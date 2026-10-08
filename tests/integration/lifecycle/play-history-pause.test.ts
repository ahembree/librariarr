import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestApiKey,
  createTestRadarrInstance,
  createTestSeerrInstance,
} from "../../setup/test-helpers";

/**
 * Holding a play-activity rule set's actions while its play history is not established, and the latch
 * (`RuleSet.playHistoryPausedAt`) that holds them until detection evaluates it again: a skipped rule set keeps
 * matches that predate any play since. Only the media server and the Arr call (`executeAction`) are faked.
 */

const m = vi.hoisted(() => ({
  libraries: [] as Array<{ key: string; title: string; type: string }>,
  listings: {} as Record<string, { items: Array<Record<string, unknown>>; total?: number | null }>,
  history: vi.fn(),
  enqueueJob: vi.fn(),
  /** Runs inside the rule engine's evaluation, i.e. after detection began evaluating. */
  duringEvaluation: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => {
    const findItem = (ratingKey: string) =>
      Object.values(m.listings).flatMap((l) => l.items).find((i) => i.ratingKey === ratingKey);
    return {
      bulkListingIncomplete: false,
      supportsHistorySince: false,
      testConnection: vi.fn(async () => ({ ok: true, serverName: "Test Server" })),
      getLibraries: vi.fn(async () => m.libraries),
      getWatchCounts: vi.fn(async () => new Map()),
      getLibraryShows: vi.fn(async () => []),
      getLibraryItemsPage: vi.fn(async (key: string, _type: string, offset: number, limit: number) => {
        const listing = m.listings[key] ?? { items: [] };
        return {
          items: listing.items.slice(offset, offset + limit).map((i) => ({ ...i })),
          total: listing.total === undefined ? listing.items.length : listing.total,
        };
      }),
      getItemMetadata: vi.fn(async (ratingKey: string) => ({ ...findItem(ratingKey) })),
      getDetailedWatchHistory: vi.fn((...args: unknown[]) => m.history(...args)),
    };
  }),
}));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob, isJobRetrying: vi.fn(async () => false) }));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/image-cache/image-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/image-cache/image-cache")>()),
  invalidateCachedUrls: vi.fn(),
}));
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
  buildSuccessSummaryEmbed: vi.fn(),
  buildFailureSummaryEmbed: vi.fn(),
  buildMatchChangeEmbed: vi.fn(),
  buildMaintenanceEmbed: vi.fn(),
  buildApiKeyEmbed: vi.fn(),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));
// An empty Arr/Seerr answer (nothing requested, nothing in Radarr) is all these need.
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-seerr-metadata")>();
  return { ...actual, fetchSeerrMetadata: vi.fn(async () => ({})) };
});
vi.mock("@/lib/lifecycle/fetch-arr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-arr-metadata")>();
  return { ...actual, fetchArrMetadata: vi.fn(async () => ({})) };
});
// The Arr call itself is beside the point; what matters is whether it is made.
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn().mockResolvedValue(undefined) };
});
// The real engine, with a hook to land a concurrent run's refusal mid-evaluation.
vi.mock("@/lib/rules/lifecycle-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rules/lifecycle-engine")>();
  return {
    ...actual,
    evaluateLifecycleRules: vi.fn(async (...args: Parameters<typeof actual.evaluateLifecycleRules>) => {
      if (m.duringEvaluation) await m.duringEvaluation();
      return actual.evaluateLifecycleRules(...args);
    }),
  };
});

import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import {
  checkWatchHistoryCompleteness,
  clearPlayHistoryPause,
  notePlayHistoryPause,
} from "@/lib/lifecycle/evaluability";
import { requireLibraryResync } from "@/lib/media/watch-evidence";
import { executeAction } from "@/lib/lifecycle/actions";
import { logger } from "@/lib/logger";
import { DELETE as purge } from "@/app/api/media/purge/route";
import { POST as executePost } from "@/app/api/lifecycle/actions/execute/route";
import { POST as retryPost } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as v1ExecutePost } from "@/app/api/v1/lifecycle/actions/execute/route";
import { POST as runPost } from "@/app/api/lifecycle/rules/run/route";
import { PUT as ruleSetPut } from "@/app/api/lifecycle/rules/[id]/route";

const prisma = getTestPrisma();

const rule = (field: string, operator: string, value: unknown) => [
  { id: "g1", condition: "AND", rules: [{ id: "r1", field, operator, value, condition: "AND" }], groups: [] },
];
const NEVER_PLAYED = rule("playCount", "equals", 0);
const BY_TITLE = rule("title", "contains", "Movie");

const movie = (ratingKey: string) => ({ ratingKey, title: `Movie ${ratingKey}`, type: "movie" });
const episode = (ratingKey: string, index: number) => ({
  ratingKey,
  title: `Episode ${index}`,
  type: "episode",
  grandparentTitle: "The Show",
  grandparentRatingKey: "show-1",
  parentIndex: 1,
  index,
});
const play = (ratingKey: string, username = "alice") => ({
  ratingKey,
  username,
  watchedAt: "2026-09-30T20:00:00.000Z",
  deviceName: null,
  platform: null,
});

const pausedAt = async (ruleSetId: string) =>
  (await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSetId }, select: { playHistoryPausedAt: true } }))
    .playHistoryPausedAt;
const heldWarnings = () =>
  vi
    .mocked(logger.warn)
    .mock.calls.map((c) => String(c[1]))
    .filter((line) => line.startsWith("Holding ") && line.includes("due action(s)"));
const LATCH_REASON = /this rule set's matches have not been evaluated since its play history was last unknown/;
/** Play Count = 0 AND `field` = false: refused for a missing Arr/Seerr instance before the play history. */
const withCriterion = (field: string) => [
  {
    id: "g1",
    condition: "AND",
    rules: [
      { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" },
      { id: "r2", field, operator: "equals", value: "false", condition: "AND" },
    ],
    groups: [],
  },
];

let userId: string;
let serverId: string;
let ruleSetId: string;

async function itemId(ratingKey: string) {
  return (await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey } })).id;
}
async function statusOf(ratingKey: string, rs = ruleSetId) {
  const a = await prisma.lifecycleAction.findFirst({ where: { ruleSetId: rs, mediaItemId: await itemId(ratingKey) } });
  return a?.status ?? "none";
}
/** Every action of the rule set, by item. */
const statuses = async () =>
  (await prisma.lifecycleAction.findMany({ where: { ruleSetId }, orderBy: { mediaItemId: "asc" } })).map(
    (a) => a.status,
  );
const comeDue = () =>
  prisma.lifecycleAction.updateMany({
    where: { ruleSetId, status: "PENDING" },
    data: { scheduledFor: new Date(Date.now() - 1_000) },
  });
/** The household watches it; the history pass's reconcile raises its play count. */
const watch = (ratingKey: string) =>
  prisma.mediaItem.updateMany({ where: { ratingKey }, data: { playCount: 1, lastPlayedAt: new Date() } });

const execute = (mediaItemIds?: string[]) =>
  callRoute(executePost, {
    url: "/api/lifecycle/actions/execute",
    method: "POST",
    body: { ruleSetId, ...(mediaItemIds ? { mediaItemIds } : {}) },
  });
async function v1Execute(mediaItemIds: string[]) {
  const { key } = await createTestApiKey(userId, { scopes: ["lifecycle:execute"] });
  return callRoute(v1ExecutePost, {
    url: "/api/v1/lifecycle/actions/execute",
    method: "POST",
    body: { ruleSetId, mediaItemIds },
    headers: { authorization: `Bearer ${key}` },
  });
}
const retry = (actionId: string) =>
  callRouteWithParams(retryPost, { id: actionId }, { url: `/api/lifecycle/actions/${actionId}`, method: "POST" });
/** Marks the item's action FAILED, for force-retry. */
async function failAction(ratingKey: string) {
  const action = await prisma.lifecycleAction.findFirstOrThrow({ where: { ruleSetId, mediaItemId: await itemId(ratingKey) } });
  await prisma.lifecycleAction.update({ where: { id: action.id }, data: { status: "FAILED" } });
  return action.id;
}
/** The run route's Re-evaluate for this rule set. */
const reEvaluate = () => {
  setMockSession({ isLoggedIn: true, userId });
  return callRoute(runPost, {
    url: "/api/lifecycle/rules/run",
    method: "POST",
    body: { ruleSetId, fullReEval: true, processActions: true },
  });
};
/** `detectAndSaveMatches` on the stored rule set. */
async function detectStored() {
  const rs = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSetId } });
  return detectAndSaveMatches({ ...rs, serverIds: [serverId] }, [serverId]);
}

/**
 * A native server with established history, two never-played movies (m1, m2) and a rule set "Unwatched"
 * with an armed DO_NOTHING action; detection has run, so both are PENDING.
 */
async function armed(rules: unknown = NEVER_PLAYED, setup?: (userId: string) => Promise<unknown>) {
  const user = await createTestUser();
  userId = user.id;
  await setup?.(user.id);
  const server = await createTestServer(user.id, { watchHistorySyncedAt: new Date() });
  serverId = server.id;
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  await createTestMediaItem(library.id, { ratingKey: "m1", title: "Movie m1", type: "MOVIE", playCount: 0 });
  await createTestMediaItem(library.id, { ratingKey: "m2", title: "Movie m2", type: "MOVIE", playCount: 0 });
  const rs = await createTestRuleSet(user.id, {
    name: "Unwatched",
    type: "MOVIE",
    rules,
    serverIds: [server.id],
    actionEnabled: true,
    actionType: "DO_NOTHING",
    actionDelayDays: 7,
  });
  ruleSetId = rs.id;
  await processLifecycleRules(user.id);
  expect(await prisma.lifecycleAction.count({ where: { ruleSetId, status: "PENDING" } })).toBe(2);
}
/** A full sync released the hold and its history phase established the marker. */
const release = () =>
  prisma.mediaServer.update({
    where: { id: serverId },
    data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: new Date() },
  });

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  m.duringEvaluation = null;
  m.enqueueJob.mockResolvedValue(true);
  m.history.mockResolvedValue([]);
});
afterAll(async () => {
  await disconnectTestDb();
});

describe("held actions once the history is established again, before detection has run", () => {
  // A native Jellyfin server; "Play Count = 0" holds PENDING actions on m1 and m2; another library is purged
  // (the hold); m1 is watched during it; detection skips the rule set; the full sync releases the hold.
  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(user.id, { type: "JELLYFIN", watchHistorySyncedAt: null });
    serverId = server.id;
    await createTestLibrary(server.id, { key: "1", title: "Movies", type: "MOVIE" });
    const shows = await createTestLibrary(server.id, { key: "2", title: "Shows", type: "SERIES" });
    m.libraries = [
      { key: "1", title: "Movies", type: "movie" },
      { key: "2", title: "Shows", type: "show" },
    ];
    m.listings = {
      "1": { items: [movie("m1"), movie("m2")] },
      "2": { items: [episode("e1", 1), episode("e2", 2)] },
    };
    await syncMediaServer(serverId, undefined, { trigger: "test: first sync" });
    await prisma.mediaItem.updateMany({ data: { createdAt: new Date("2025-01-01T00:00:00.000Z") } });

    const rs = await createTestRuleSet(user.id, {
      name: "Never played",
      type: "MOVIE",
      rules: NEVER_PLAYED,
      serverIds: [serverId],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 7,
    });
    ruleSetId = rs.id;
    await processLifecycleRules(userId);
    expect(await statusOf("m1")).toBe("PENDING");
    expect(await statusOf("m2")).toBe("PENDING");
    expect(await pausedAt(ruleSetId)).toBeNull();

    setMockSession({ isLoggedIn: true, userId });
    await expectJson(
      await callRoute(purge, { url: "/api/media/purge", method: "DELETE", searchParams: { libraryId: shows.id } }),
      200,
    );
    clearMockSession();

    // m1 is watched during the hold: a Refresh stores the play but cannot establish the history.
    m.history.mockResolvedValue([play("m1")]);
    await syncWatchHistory(serverId);
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } })).playCount).toBe(1);

    // Detection skips the rule set (keeping m1's match) and records it.
    const before = Date.now();
    await processLifecycleRules(userId);
    const latch = await pausedAt(ruleSetId);
    expect(latch).toBeInstanceOf(Date);
    expect(latch!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(latch!.getTime()).toBeLessThanOrEqual(Date.now() + 5);

    await syncMediaServer(serverId, undefined, { trigger: "test: releasing full sync" });
    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(after.libraryResyncRequiredAt).toBeNull();
    expect(after.watchHistorySyncedAt).toBeInstanceOf(Date);
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    await comeDue();
    vi.mocked(logger.warn).mockClear();
  });

  it("an execution before the next detection holds both actions, until detection has evaluated the rule set", async () => {
    await executeLifecycleActions(userId);

    expect(await statusOf("m1")).toBe("PENDING");
    expect(await statusOf("m2")).toBe("PENDING");
    expect(executeAction).not.toHaveBeenCalled();
    const warnings = heldWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Holding 2 due action\(s\) of rule set "Never played" — Rules read play activity, and /);
    expect(warnings[0]).toMatch(LATCH_REASON);
    expect(warnings[0]).toMatch(/re-evaluate it under Lifecycle → Matches, or wait for the next scheduled detection run/);
    // ...and what to fix when Re-evaluate reports it skipped.
    expect(warnings[0]).toMatch(/Detection has to be able to evaluate it first/);

    // Detection evaluates it: m1 drops out, and m2 runs.
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeNull();
    await comeDue();
    await executeLifecycleActions(userId);
    expect(await statusOf("m1")).toBe("none");
    expect(await statusOf("m2")).toBe("COMPLETED");
  });

  it("Execute and its /api/v1 mirror answer 409 until detection has evaluated the rule set", async () => {
    setMockSession({ isLoggedIn: true, userId });
    const refused = await expectJson<{ error: string }>(await execute([await itemId("m1")]), 409);
    expect(refused.error).toMatch(LATCH_REASON);
    await expectJson(await execute(), 409);
    const v1 = await expectJson<{ error: string }>(await v1Execute([await itemId("m2")]), 409);
    expect(v1.error).toMatch(LATCH_REASON);
    expect(executeAction).not.toHaveBeenCalled();

    // Re-evaluated: m1 is no longer a match, and m2 executes.
    await processLifecycleRules(userId);
    const body = await expectJson<{ executed: number }>(await execute([await itemId("m2")]), 200);
    expect(body.executed).toBe(1);
  });

  it("force-retry answers 409 until detection has evaluated the rule set", async () => {
    const actionId = await failAction("m2");
    setMockSession({ isLoggedIn: true, userId });

    const refused = await expectJson<{ error: string }>(await retry(actionId), 409);
    expect(refused.error).toMatch(LATCH_REASON);
    expect(executeAction).not.toHaveBeenCalled();

    await processLifecycleRules(userId);
    expect((await retry(actionId)).status).toBeLessThan(300);
    expect(executeAction).toHaveBeenCalled();
  });
});

describe("while play history is not established", () => {
  it("the scheduled executor leaves a held rule set's due actions PENDING, untouched — the item watched during the hold too", async () => {
    // Detection refuses the rule set and keeps its frozen matches, so the stale check passes on m1's.
    await armed();
    await requireLibraryResync([serverId]);
    await watch("m1");
    await processLifecycleRules(userId);
    await comeDue();

    await executeLifecycleActions(userId);

    expect(await statuses()).toEqual(["PENDING", "PENDING"]);
    expect(executeAction).not.toHaveBeenCalled();
    // Said once per rule set, with the guard's reason.
    const warnings = heldWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Holding 2 due action(s) of rule set "Unwatched" — Rules read play activity but');
    expect(warnings[0]).toMatch(/waits for a complete library sync/);
  });

  it("holds for every fault the guard refuses on (here: no marker): the scheduled executor, and Execute All writing no FAILED rows", async () => {
    await armed();
    await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
    await comeDue();

    await executeLifecycleActions(userId);
    expect(await statuses()).toEqual(["PENDING", "PENDING"]);
    expect(heldWarnings()[0]).toMatch(/no sync has established what was played there/);

    setMockSession({ isLoggedIn: true, userId });
    const body = await expectJson<{ error: string }>(await execute(), 409);
    expect(body.error).toMatch(/no sync has established what was played there/);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId, status: { not: "PENDING" } } })).toBe(0);
  });

  it("the scheduled executor's hold is scoped to the servers the rule set reads", async () => {
    await armed();
    const other = await createTestServer(userId, { name: "Elsewhere" });
    await requireLibraryResync([other.id]);
    await comeDue();

    await executeLifecycleActions(userId);

    expect(await statuses()).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it("Execute and its /api/v1 mirror refuse with 409 and the guard's reason, executing nothing", async () => {
    await armed();
    await requireLibraryResync([serverId]);
    setMockSession({ isLoggedIn: true, userId });

    const body = await expectJson<{ error: string }>(await execute([await itemId("m1")]), 409);
    expect(body.error).toMatch(/^Rules read play activity but 1 server\(s\) have no established play history yet/);
    expect(body.error).toMatch(/waits for a complete library sync/);
    await expectJson(await execute(), 409);
    const v1 = await expectJson<{ error: string }>(await v1Execute([await itemId("m1")]), 409);
    expect(v1.error).toMatch(/^Rules read play activity but/);

    expect(executeAction).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(["PENDING", "PENDING"]);
  });

  it("force-retry refuses a FAILED action with 409 and the reason", async () => {
    await armed();
    const actionId = await failAction("m1");
    await requireLibraryResync([serverId]);
    setMockSession({ isLoggedIn: true, userId });

    const body = await expectJson<{ error: string }>(await retry(actionId), 409);
    expect(body.error).toMatch(/^Rules read play activity but .*waits for a complete library sync/);
    expect(executeAction).not.toHaveBeenCalled();
    expect((await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe("FAILED");
  });

  it("Execute runs as before for a rule set that reads no play activity", async () => {
    await armed(BY_TITLE);
    await requireLibraryResync([serverId]);
    setMockSession({ isLoggedIn: true, userId });

    const executed = await expectJson<{ executed: number }>(await execute([await itemId("m1")]), 200);
    expect(executed.executed).toBe(1);
  });
});

describe("the play-history pause latch", () => {
  it("is recorded and lifted by the manual run route (runDetection) as by a scheduled run", async () => {
    await armed();
    await requireLibraryResync([serverId]);

    const skipped = await expectJson<{ skipped: Array<{ ruleSetId: string }> }>(await reEvaluate(), 200);
    expect(skipped.skipped.map((s) => s.ruleSetId)).toEqual([ruleSetId]);
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

    await release();
    await expectJson(await reEvaluate(), 200);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  it("is recorded by detectAndSaveMatches' own refusal, which keeps the matches", async () => {
    await armed();
    await requireLibraryResync([serverId]);

    const result = await detectStored();

    expect(result.count).toBe(2);
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(2);
  });

  it("keeps the LATEST refusal", async () => {
    await armed();
    await requireLibraryResync([serverId]);
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: later } });
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toEqual(later);

    const earlier = new Date("2026-01-01T00:00:00.000Z");
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: earlier } });
    const before = Date.now();
    await notePlayHistoryPause(ruleSetId);
    expect((await pausedAt(ruleSetId))!.getTime()).toBeGreaterThanOrEqual(before - 5);
  });

  it("is lifted only up to the instant the evaluating run began (compare-and-set)", async () => {
    await armed();
    const at = new Date("2026-06-01T12:00:00.000Z");
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: at } });

    await expect(clearPlayHistoryPause(ruleSetId, new Date(at.getTime() - 1))).resolves.toBe(false);
    expect(await pausedAt(ruleSetId)).toEqual(at);
    await expect(clearPlayHistoryPause(ruleSetId, at)).resolves.toBe(true);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  describe("is not lifted by a run that began evaluating before a newer refusal landed", () => {
    // Another run (outside MAIN_QUEUE) records its refusal while this one evaluates, in a later millisecond.
    beforeEach(async () => {
      await armed();
      m.duringEvaluation = async () => {
        m.duringEvaluation = null;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await notePlayHistoryPause(ruleSetId);
      };
    });

    it("a scheduled run", async () => {
      await processLifecycleRules(userId);
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
      await comeDue();
      await executeLifecycleActions(userId);
      expect(executeAction).not.toHaveBeenCalled();
      expect(heldWarnings()[0]).toMatch(LATCH_REASON);

      // The next run, which began after that refusal, lifts it.
      await processLifecycleRules(userId);
      expect(await pausedAt(ruleSetId)).toBeNull();
    });

    it("a full re-evaluation (the run route's Re-evaluate)", async () => {
      await expectJson(await reEvaluate(), 200);
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

      await expectJson(await reEvaluate(), 200);
      expect(await pausedAt(ruleSetId)).toBeNull();
    });
  });

  it("goes with the matches when a rule set edit clears them, and stays when the edit keeps them", async () => {
    await armed();
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: new Date() } });
    setMockSession({ isLoggedIn: true, userId });
    const put = (name: string, searchParams?: Record<string, string>) =>
      callRouteWithParams(ruleSetPut, { id: ruleSetId }, {
        url: `/api/lifecycle/rules/${ruleSetId}`,
        method: "PUT",
        body: { name },
        searchParams,
      });

    await expectJson(await put("Renamed", { clearMatches: "false" }), 200);
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(2);

    await expectJson(await put("Renamed again"), 200);
    expect(await pausedAt(ruleSetId)).toBeNull();
    expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(0);
  });

  it("holds nothing of a rule set that reads no play activity — latched, or while its servers are held", async () => {
    await armed(BY_TITLE);
    await requireLibraryResync([serverId]);
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: new Date() } });
    await comeDue();

    await executeLifecycleActions(userId);

    expect(await statuses()).toEqual(["COMPLETED", "COMPLETED"]);
    expect(heldWarnings()).toHaveLength(0);
  });

  it("is never recorded when nothing skipped the rule set: history lost and back between two detection runs", async () => {
    await armed();
    await requireLibraryResync([serverId]);
    await release();
    await comeDue();

    await executeLifecycleActions(userId);

    expect(await pausedAt(ruleSetId)).toBeNull();
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId, status: "COMPLETED" } })).toBe(2);
  });

  it("is not recorded by a skip for anything but play history", async () => {
    // Skipped for the missing Arr instance while the history is established.
    const user = await createTestUser();
    const server = await createTestServer(user.id, { watchHistorySyncedAt: new Date() });
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "m1", title: "Movie m1", type: "MOVIE", playCount: 0 });
    const rs = await createTestRuleSet(user.id, {
      name: "Unwatched, not in Radarr",
      type: "MOVIE",
      rules: withCriterion("foundInArr"),
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DO_NOTHING",
    });

    await processLifecycleRules(user.id);

    expect(vi.mocked(logger.warn).mock.calls.map((c) => String(c[1]))).toContainEqual(
      expect.stringMatching(/^Skipping rule set "Unwatched, not in Radarr" — Rules use Arr criteria/),
    );
    expect(await pausedAt(rs.id)).toBeNull();
  });

  describe("when an Arr or Seerr refusal comes ahead of the play-history one", () => {
    const skips = () =>
      vi
        .mocked(logger.warn)
        .mock.calls.map((c) => String(c[1]))
        .filter((line) => line.startsWith("Skipping rule set ") || line.startsWith("Refusing to evaluate rule set "));

    it("records the latch for a Seerr refusal during a hold, so the frozen matches stay held once the history is back", async () => {
      let seerrId = "";
      await armed(withCriterion("seerrRequested"), async (uid) => {
        seerrId = (await createTestSeerrInstance(uid)).id;
      });
      // During a library-resync hold the Seerr instance is turned off, and m1 is watched.
      await requireLibraryResync([serverId]);
      await prisma.seerrInstance.update({ where: { id: seerrId }, data: { enabled: false } });
      await watch("m1");

      await processLifecycleRules(userId);
      expect(skips()).toContainEqual(expect.stringMatching(/^Skipping rule set "Unwatched" — Rules use Seerr criteria/));
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

      await release();
      await comeDue();
      await executeLifecycleActions(userId);
      expect(executeAction).not.toHaveBeenCalled();
      expect(heldWarnings()[0]).toMatch(LATCH_REASON);

      // Seerr back, and the rule set evaluated: m1 drops out, m2 runs.
      await prisma.seerrInstance.update({ where: { id: seerrId }, data: { enabled: true } });
      await processLifecycleRules(userId);
      expect(await pausedAt(ruleSetId)).toBeNull();
      await comeDue();
      await executeLifecycleActions(userId);
      expect(await statusOf("m1")).toBe("none");
      expect(await statusOf("m2")).toBe("COMPLETED");
    });

    it("records it for an Arr refusal in the manual run route (runDetection), and lifts it once the rule set is evaluated", async () => {
      let radarrId = "";
      await armed(withCriterion("foundInArr"), async (uid) => {
        radarrId = (await createTestRadarrInstance(uid)).id;
      });
      await requireLibraryResync([serverId]);
      await prisma.radarrInstance.update({ where: { id: radarrId }, data: { enabled: false } });

      const skipped = await expectJson<{ skipped: Array<{ ruleSetId: string; reason: string }> }>(await reEvaluate(), 200);
      expect(skipped.skipped).toEqual([expect.objectContaining({ ruleSetId, reason: expect.stringMatching(/^Rules use Arr criteria/) })]);
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

      await release();
      await prisma.radarrInstance.update({ where: { id: radarrId }, data: { enabled: true } });
      await expectJson(await reEvaluate(), 200);
      expect(await pausedAt(ruleSetId)).toBeNull();
    });

    it("records it for detectAndSaveMatches' own Seerr refusal, which keeps the matches", async () => {
      let seerrId = "";
      await armed(withCriterion("seerrRequested"), async (uid) => {
        seerrId = (await createTestSeerrInstance(uid)).id;
      });
      await requireLibraryResync([serverId]);
      await prisma.seerrInstance.update({ where: { id: seerrId }, data: { enabled: false } });

      const result = await detectStored();

      expect(skips()).toContainEqual(expect.stringMatching(/^Refusing to evaluate rule set "Unwatched" — Rules use Seerr criteria/));
      expect(result.count).toBe(2);
      expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(2);
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    });
  });
});

describe("a full backup's restore", () => {
  // Its matches are as old as the backup, so it latches every play-activity rule set it brought matches back for:
  // their actions wait, past the full sync that lifts the restore's hold, until detection evaluates them.
  let backups: typeof import("@/lib/backup/backup-service");
  let backupDir: string;
  beforeAll(async () => {
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-backup-"));
    // Read when the service loads, so before the first import.
    process.env.BACKUP_DIR = backupDir;
    backups = await import("@/lib/backup/backup-service");
  });
  afterAll(async () => {
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(user.id, { type: "JELLYFIN", watchHistorySyncedAt: null });
    serverId = server.id;
    await createTestLibrary(server.id, { key: "1", title: "Movies", type: "MOVIE" });
    m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
    m.listings = { "1": { items: [movie("m1"), movie("m2")] } };
    await syncMediaServer(serverId, undefined, { trigger: "test: first sync" });
    await prisma.mediaItem.updateMany({ data: { createdAt: new Date("2025-01-01T00:00:00.000Z") } });
    const rs = await createTestRuleSet(user.id, {
      name: "Never played",
      type: "MOVIE",
      rules: NEVER_PLAYED,
      serverIds: [serverId],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 0,
    });
    ruleSetId = rs.id;
    await processLifecycleRules(userId);
    expect(await statusOf("m1")).toBe("PENDING");
    expect(await statusOf("m2")).toBe("PENDING");
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  /** The backup's m1 is watched after it was taken: restore, then the full sync the docs advise. */
  async function restoreThenSync(configOnly = false) {
    const file = await backups.createBackup(undefined, configOnly);
    m.history.mockResolvedValue([play("m1")]);
    const before = Date.now();
    await backups.restoreBackup(file);
    await syncMediaServer(serverId, undefined, { trigger: "test: full sync after restore" });
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    return before;
  }

  it("holds the restored actions from an execution after the sync and before detection, and Execute answers 409", async () => {
    const before = await restoreThenSync();
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } })).playCount).toBe(1);
    const latch = await pausedAt(ruleSetId);
    expect(latch).toBeInstanceOf(Date);
    expect(latch!.getTime()).toBeGreaterThanOrEqual(before - 5);
    setMockSession({ isLoggedIn: true, userId });
    const refused = await expectJson<{ error: string }>(await execute([await itemId("m1")]), 409);
    expect(refused.error).toMatch(/a backup restore brought the matches back/);

    await executeLifecycleActions(userId);

    expect(executeAction).not.toHaveBeenCalled();
    expect(await statusOf("m1")).toBe("PENDING");
    expect(await statusOf("m2")).toBe("PENDING");

    // Detection evaluates the rule set: the watched m1 drops out, m2 runs.
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeNull();
    await executeLifecycleActions(userId);
    expect(await statusOf("m1")).toBe("none");
    expect(await statusOf("m2")).toBe("COMPLETED");
  });

  it("latches only the play-activity rule sets it brought matches back for; one reading no play activity runs", async () => {
    const byTitle = await createTestRuleSet(userId, {
      name: "By title",
      type: "MOVIE",
      rules: BY_TITLE,
      serverIds: [serverId],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 0,
    });
    const empty = await createTestRuleSet(userId, {
      name: "Nothing yet",
      type: "MOVIE",
      rules: NEVER_PLAYED,
      serverIds: [serverId],
      enabled: false,
    });
    await processLifecycleRules(userId);
    expect(await statusOf("m1", byTitle.id)).toBe("PENDING");

    await restoreThenSync();

    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    // Latched, they would hold nothing, and detection would announce lifting a hold that never was.
    expect(await pausedAt(byTitle.id)).toBeNull();
    expect(await pausedAt(empty.id)).toBeNull();
    await executeLifecycleActions(userId);
    expect(await statusOf("m1", byTitle.id)).toBe("COMPLETED");
    expect(await statusOf("m1")).toBe("PENDING");
  });

  it("a config-only restore brings back no matches, so it latches nothing", async () => {
    await restoreThenSync(true);

    expect(await prisma.ruleMatch.count()).toBe(0);
    expect(await prisma.lifecycleAction.count()).toBe(0);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });
});
