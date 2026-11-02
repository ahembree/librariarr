import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestRuleSet,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * `cleanupOldActions` against the real database: the retention window ages an
 * action by when it RAN. The executor completes an action by updating its
 * PENDING row, so `createdAt` is when detection scheduled it — and aged by that,
 * any rule set whose delay was at least the retention lost its history, its
 * failures and its deletion stats within 15 minutes of every run.
 */
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cleanupOldActions } from "@/lib/jobs/tasks";
import { computeDeletionStats } from "@/lib/lifecycle/deletion-stats";

const DAY = 24 * 60 * 60 * 1000;
const prisma = getTestPrisma();

async function setup(retentionDays = 30) {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id, actionHistoryRetentionDays: retentionDays } });
  const ruleSet = await createTestRuleSet(user.id, { name: "Delete after 30 days", actionDelayDays: 30 });
  return { user, ruleSet };
}

async function action(
  userId: string,
  ruleSetId: string,
  fields: {
    status: "PENDING" | "COMPLETED" | "FAILED";
    createdAt: Date;
    executedAt: Date | null;
    mediaItemId?: string;
  },
) {
  return prisma.lifecycleAction.create({
    data: {
      userId,
      ruleSetId,
      ruleSetName: "Delete after 30 days",
      ruleSetType: "MOVIE",
      actionType: "DELETE_RADARR",
      scheduledFor: new Date(fields.createdAt.getTime() + 30 * DAY),
      deletedBytes: fields.status === "COMPLETED" ? BigInt(4_000_000_000) : null,
      mediaItemTitle: "Some Movie",
      ...fields,
    },
  });
}

const exists = async (id: string) => (await prisma.lifecycleAction.findUnique({ where: { id } })) !== null;

describe("cleanupOldActions (real database)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("keeps an action that ran minutes ago although it was scheduled before the retention window", async () => {
    const { user, ruleSet } = await setup(30);
    const completed = await action(user.id, ruleSet.id, {
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 31 * DAY),
      executedAt: new Date(Date.now() - 5 * 60_000),
    });
    const failed = await action(user.id, ruleSet.id, {
      status: "FAILED",
      createdAt: new Date(Date.now() - 31 * DAY),
      executedAt: new Date(Date.now() - 5 * 60_000),
    });

    const before = await computeDeletionStats(user.id);
    // The completed delete is counted before cleanup runs...
    expect(before.totalBytesDeleted).toBe("4000000000");
    expect(before.actionCount).toBe(1);
    await cleanupOldActions();

    expect(await exists(completed.id)).toBe(true);
    expect(await exists(failed.id)).toBe(true);
    // The reclaimed total still counts the deletion.
    expect(await computeDeletionStats(user.id)).toEqual(before);
  });

  it("removes an action that ran before the retention window", async () => {
    const { user, ruleSet } = await setup(30);
    const old = await action(user.id, ruleSet.id, {
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 61 * DAY),
      executedAt: new Date(Date.now() - 31 * DAY),
    });
    // Inside the window: kept beside it.
    const recent = await action(user.id, ruleSet.id, {
      status: "COMPLETED",
      createdAt: new Date(Date.now() - 59 * DAY),
      executedAt: new Date(Date.now() - 29 * DAY),
    });

    await cleanupOldActions();

    expect(await exists(old.id)).toBe(false);
    expect(await exists(recent.id)).toBe(true);
  });

  it("ages a row with no recorded run time by when it was created", async () => {
    const { user, ruleSet } = await setup(30);
    const legacyOld = await action(user.id, ruleSet.id, {
      status: "FAILED",
      createdAt: new Date(Date.now() - 31 * DAY),
      executedAt: null,
    });
    const legacyRecent = await action(user.id, ruleSet.id, {
      status: "FAILED",
      createdAt: new Date(Date.now() - 2 * DAY),
      executedAt: null,
    });

    await cleanupOldActions();

    expect(await exists(legacyOld.id)).toBe(false);
    expect(await exists(legacyRecent.id)).toBe(true);
  });

  it("never removes a pending action, however old", async () => {
    const { user, ruleSet } = await setup(30);
    // Linked to an item: a PENDING action whose item is gone is swept as an orphan.
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id);
    const pending = await action(user.id, ruleSet.id, {
      mediaItemId: item.id,
      status: "PENDING",
      createdAt: new Date(Date.now() - 400 * DAY),
      executedAt: null,
    });

    await cleanupOldActions();

    expect(await exists(pending.id)).toBe(true);
  });
});
