import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  expectJson,
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
} from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/lifecycle/actions/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Envelope {
  items: any[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

function list(key: string, searchParams?: Record<string, string>) {
  return callV1(GET, { url: "/api/v1/lifecycle/actions", key, searchParams });
}

async function seedActions() {
  const prisma = getTestPrisma();
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope: "READ_ONLY" });
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id);
  const item = await createTestMediaItem(library.id, {
    title: "The Matrix",
    year: 1999,
    type: "MOVIE",
  });
  const ruleSet = await createTestRuleSet(user.id, { name: "Movie rule", type: "MOVIE" });

  const pending = await prisma.lifecycleAction.create({
    data: {
      userId: user.id,
      mediaItemId: item.id,
      mediaItemTitle: item.title,
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSet.name,
      ruleSetType: "MOVIE",
      actionType: "DELETE_RADARR",
      status: "PENDING",
      scheduledFor: new Date("2024-03-01T00:00:00Z"),
    },
  });

  const completed = await prisma.lifecycleAction.create({
    data: {
      userId: user.id,
      mediaItemId: item.id,
      mediaItemTitle: item.title,
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSet.name,
      ruleSetType: "MOVIE",
      actionType: "DELETE_RADARR",
      status: "COMPLETED",
      scheduledFor: new Date("2024-02-01T00:00:00Z"),
      executedAt: new Date("2024-02-02T00:00:00Z"),
      // 4 GiB — comfortably past 2^32, so a number round-trip would lose it.
      deletedBytes: BigInt("4294967296"),
    },
  });

  const failed = await prisma.lifecycleAction.create({
    data: {
      userId: user.id,
      ruleSetType: "SERIES",
      mediaItemTitle: "Deleted Show",
      mediaItemParentTitle: "Parent Show",
      ruleSetName: "Gone rule",
      actionType: "DELETE_SONARR",
      status: "FAILED",
      scheduledFor: new Date("2024-01-01T00:00:00Z"),
      error: "Sonarr returned 500",
    },
  });

  return { user, raw, item, ruleSet, pending, completed, failed };
}

describe("GET /api/v1/lifecycle/actions", () => {
  it("returns an empty envelope when nothing is scheduled", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("returns the action shape ordered by scheduledFor desc", async () => {
    const { raw, item, ruleSet, pending, completed, failed } = await seedActions();

    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items.map((a) => a.id)).toEqual([pending.id, completed.id, failed.id]);

    expect(body.items[0]).toMatchObject({
      id: pending.id,
      actionType: "DELETE_RADARR",
      status: "PENDING",
      executedAt: null,
      error: null,
      deletedBytes: null,
      ruleSet: { id: ruleSet.id, name: "Movie rule", libraryType: "MOVIE" },
      mediaItem: {
        id: item.id,
        title: "The Matrix",
        parentTitle: null,
        year: 1999,
        type: "MOVIE",
      },
    });
    expect(typeof body.items[0].scheduledFor).toBe("string");
    expect(typeof body.items[0].createdAt).toBe("string");
  });

  // deletedBytes is a Prisma BigInt; JSON.stringify throws on one, so a number
  // here would mean the column never reached the response at all.
  it("serializes deletedBytes as a string", async () => {
    const { raw, completed } = await seedActions();
    const body = await expectJson<Envelope>(await list(raw, { status: "COMPLETED" }));
    const row = body.items.find((a) => a.id === completed.id);
    expect(typeof row.deletedBytes).toBe("string");
    expect(row.deletedBytes).toBe("4294967296");
  });

  it("falls back to the denormalized columns when the media item is gone", async () => {
    const { raw, failed } = await seedActions();
    const body = await expectJson<Envelope>(await list(raw, { status: "FAILED" }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: failed.id,
      status: "FAILED",
      error: "Sonarr returned 500",
      ruleSet: { id: null, name: "Gone rule", libraryType: "SERIES" },
      mediaItem: {
        id: null,
        title: "Deleted Show",
        parentTitle: "Parent Show",
        year: null,
        type: "SERIES",
      },
    });
  });

  it("filters by status", async () => {
    const { raw, pending } = await seedActions();
    const body = await expectJson<Envelope>(await list(raw, { status: "PENDING" }));
    expect(body.items.map((a) => a.id)).toEqual([pending.id]);
  });

  it("filters by the denormalized rule set type", async () => {
    const { raw, failed } = await seedActions();
    const body = await expectJson<Envelope>(await list(raw, { type: "SERIES" }));
    expect(body.items.map((a) => a.id)).toEqual([failed.id]);
  });

  it("rejects an unknown status", async () => {
    const { raw } = await seedActions();
    const body = await expectJson<{ error: string }>(
      await list(raw, { status: "NOPE" }),
      400,
    );
    expect(body.error).toBe("Invalid status. Expected one of: PENDING, COMPLETED, FAILED");
  });

  // Cancellation deletes the row rather than parking it in a terminal state, so
  // there is no CANCELLED member and asking for one is a client error, not an
  // empty page.
  it("rejects CANCELLED, which is not a status this app stores", async () => {
    const { raw } = await seedActions();
    await expectJson(await list(raw, { status: "CANCELLED" }), 400);
  });

  it("rejects an unknown type", async () => {
    const { raw } = await seedActions();
    const body = await expectJson<{ error: string }>(
      await list(raw, { type: "BOOKS" }),
      400,
    );
    expect(body.error).toBe("Invalid type. Expected one of: MOVIE, SERIES, MUSIC");
  });

  it("paginates and clamps limit to 200", async () => {
    const { raw, pending, completed } = await seedActions();

    const first = await expectJson<Envelope>(await list(raw, { limit: "2" }));
    expect(first.items.map((a) => a.id)).toEqual([pending.id, completed.id]);
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });

    const second = await expectJson<Envelope>(await list(raw, { limit: "2", page: "2" }));
    expect(second.items).toHaveLength(1);
    expect(second.pagination.hasMore).toBe(false);

    const clamped = await expectJson<Envelope>(await list(raw, { limit: "999" }));
    expect(clamped.pagination.limit).toBe(200);
  });

  it("never returns another user's actions", async () => {
    const { raw } = await seedActions();
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    await getTestPrisma().lifecycleAction.create({
      data: {
        userId: stranger.id,
        actionType: "DELETE_RADARR",
        status: "PENDING",
        scheduledFor: new Date("2030-01-01T00:00:00Z"),
        mediaItemTitle: "Private",
        ruleSetType: "MOVIE",
      },
    });

    const body = await expectJson<Envelope>(await list(raw, { limit: "200" }));
    expect(body.items.map((a) => a.mediaItem.title)).not.toContain("Private");
    expect(body.items).toHaveLength(3);
  });
});
