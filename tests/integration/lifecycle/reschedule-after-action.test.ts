import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { scheduleActionsForRuleSet } from "@/lib/lifecycle/processor";

type Cfg = Parameters<typeof scheduleActionsForRuleSet>[0];

function config(ruleSetId: string, userId: string, actionType: string): Cfg {
  return {
    id: ruleSetId,
    userId,
    name: "RS",
    type: "MOVIE",
    actionEnabled: true,
    actionType,
    actionDelayDays: 0,
    arrInstanceId: "arr1",
    targetQualityProfileId: null,
    addImportExclusion: false,
    searchAfterAction: false,
    addArrTags: [],
    removeArrTags: [],
  };
}

describe("scheduleActionsForRuleSet — re-schedule after a prior action (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  async function setup(actionType: string) {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "RS", enabled: true, actionEnabled: true, actionType,
    });
    return { prisma, user, item, ruleSet };
  }

  it("schedules the NEW action after the rule's action type changed (Search → Delete)", async () => {
    // The reported bug: a completed "Search for New Copy" was permanently
    // blocking a freshly-configured "Delete from Radarr".
    const { prisma, user, item, ruleSet } = await setup("DELETE_RADARR");
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
        actionType: "SEARCH_RADARR", status: "COMPLETED",
        scheduledFor: new Date("2020-01-01T00:00:00Z"), executedAt: new Date("2020-01-02T00:00:00Z"),
      },
    });
    await prisma.ruleMatch.create({ data: { ruleSetId: ruleSet.id, mediaItemId: item.id, itemData: {} } });

    await scheduleActionsForRuleSet(config(ruleSet.id, user.id, "DELETE_RADARR"), [{ id: item.id, title: "Movie" }], new Map());

    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(pending).toHaveLength(1);
    expect(pending[0].actionType).toBe("DELETE_RADARR");
    expect(pending[0].mediaItemId).toBe(item.id);
  });

  it("does NOT schedule a second action of the SAME non-destructive type (loop prevention)", async () => {
    const { prisma, user, item, ruleSet } = await setup("UNMONITOR_RADARR");
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
        actionType: "UNMONITOR_RADARR", status: "COMPLETED",
        scheduledFor: new Date("2020-01-01T00:00:00Z"), executedAt: new Date("2020-01-02T00:00:00Z"),
      },
    });
    await prisma.ruleMatch.create({ data: { ruleSetId: ruleSet.id, mediaItemId: item.id, itemData: {} } });

    await scheduleActionsForRuleSet(config(ruleSet.id, user.id, "UNMONITOR_RADARR"), [{ id: item.id, title: "Movie" }], new Map());

    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(pending).toHaveLength(0);
  });

  it("does not loop across schedule → execute → re-detect cycles for a no-op action", async () => {
    // Full steady-state replay: this is the exact sequence that a naive
    // detectedAt-based guard re-scheduled every cycle.
    const { prisma, user, item, ruleSet } = await setup("DO_NOTHING");
    const cfg = config(ruleSet.id, user.id, "DO_NOTHING");

    // Cycle 1: detection creates the match, scheduling creates the PENDING action.
    await prisma.ruleMatch.create({
      data: { ruleSetId: ruleSet.id, mediaItemId: item.id, itemData: {}, detectedAt: new Date("2024-01-01T00:00:00Z") },
    });
    await scheduleActionsForRuleSet(cfg, [{ id: item.id, title: "Movie" }], new Map());
    const afterCycle1 = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(afterCycle1).toHaveLength(1);

    // Execution: faithfully replicate processor.ts success path (COMPLETED + delete match).
    await prisma.lifecycleAction.update({
      where: { id: afterCycle1[0].id },
      data: { status: "COMPLETED", executedAt: new Date("2024-02-01T00:00:00Z") },
    });
    await prisma.ruleMatch.deleteMany({ where: { ruleSetId: ruleSet.id, mediaItemId: item.id } });

    // Cycle 2: item still matches (DO_NOTHING changed nothing) → detection recreates
    // the match with a NEWER detectedAt → scheduling must NOT create a second action.
    await prisma.ruleMatch.create({
      data: { ruleSetId: ruleSet.id, mediaItemId: item.id, itemData: {}, detectedAt: new Date("2024-03-01T00:00:00Z") },
    });
    await scheduleActionsForRuleSet(cfg, [{ id: item.id, title: "Movie" }], new Map());

    const pendingAfterCycle2 = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    const allAfterCycle2 = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(pendingAfterCycle2).toHaveLength(0);
    expect(allAfterCycle2).toHaveLength(1); // only the original, now-COMPLETED action
  });
});
