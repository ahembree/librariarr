import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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
 * The play-history pause latch (`RuleSet.playHistoryPausedAt`).
 *
 * Detection skips a rule set whose play-activity criteria its servers cannot
 * answer and KEEPS its matches and PENDING actions, so those matches are from
 * before the history went unknown — an item watched in the meantime still
 * holds one. The executors used to hold such a rule set's actions only while
 * the history was unknown: once a full sync re-established it, the next
 * execution acted on the frozen matches if it ran before the next detection
 * (execution scheduled more often than detection, Settings "Run now",
 * `POST /api/v1/jobs/execution`, or Execute right after the hold lifted).
 * A detection run that skips the rule set while its play history is not
 * established now records it on the rule set — also when it names a missing
 * Arr or Seerr instance as the reason, since that refusal comes first — and
 * its actions stay held until a detection run has evaluated it again.
 *
 * Real Postgres; the sync engine, the purge route, the native history sync,
 * detection, the executor and the routes are real. Only the media server is
 * faked, and the Arr call itself (`executeAction`).
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
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
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
// Arr and Seerr criteria read their instances' metadata once one is enabled;
// an empty answer (nothing requested, nothing in Radarr) is all these need.
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
// The real engine, with a hook into its evaluation: a run can be made to see
// a concurrent run's refusal land while it is evaluating.
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

let userId: string;
let serverId: string;
let ruleSetId: string;

async function itemId(ratingKey: string) {
  return (await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey } })).id;
}
async function statusOf(ratingKey: string) {
  const a = await prisma.lifecycleAction.findFirst({ where: { ruleSetId, mediaItemId: await itemId(ratingKey) } });
  return a?.status ?? "none";
}
const comeDue = () =>
  prisma.lifecycleAction.updateMany({
    where: { ruleSetId, status: "PENDING" },
    data: { scheduledFor: new Date(Date.now() - 1_000) },
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
  /**
   * The reviewer's scenario, end to end: a native Jellyfin server; "Play
   * Count = 0" with PENDING actions on m1 and m2; another library is purged
   * (the hold); m1 is watched during it; detection skips the rule set (keeping
   * m1's match); the full sync releases the hold and establishes the history.
   */
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

    // m1 is watched during the hold: a Refresh stores the play and raises its
    // play count, but cannot establish the history under the hold.
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

    // The full sync releases the hold; its history phase establishes the history.
    await syncMediaServer(serverId, undefined, { trigger: "test: releasing full sync" });
    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(after.libraryResyncRequiredAt).toBeNull();
    expect(after.watchHistorySyncedAt).toBeInstanceOf(Date);
    await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
    await comeDue();
    vi.mocked(logger.warn).mockClear();
  });

  it("control: detection first lifts the hold — the watched m1's action is cancelled, m2's runs", async () => {
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeNull();
    await comeDue();

    await executeLifecycleActions(userId);

    expect(await statusOf("m1")).toBe("none");
    expect(await statusOf("m2")).toBe("COMPLETED");
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
    const refused = await expectJson<{ error: string }>(
      await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId, mediaItemIds: [await itemId("m1")] },
      }),
      409,
    );
    expect(refused.error).toMatch(LATCH_REASON);
    await expectJson(
      await callRoute(executePost, { url: "/api/lifecycle/actions/execute", method: "POST", body: { ruleSetId } }),
      409,
    );

    const { key } = await createTestApiKey(userId, { scopes: ["lifecycle:execute"] });
    const v1 = await expectJson<{ error: string }>(
      await callRoute(v1ExecutePost, {
        url: "/api/v1/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId, mediaItemIds: [await itemId("m2")] },
        headers: { authorization: `Bearer ${key}` },
      }),
      409,
    );
    expect(v1.error).toMatch(LATCH_REASON);
    expect(executeAction).not.toHaveBeenCalled();

    // Re-evaluated: m1 is no longer a match, and m2 executes.
    await processLifecycleRules(userId);
    const body = await expectJson<{ executed: number }>(
      await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId, mediaItemIds: [await itemId("m2")] },
      }),
      200,
    );
    expect(body.executed).toBe(1);
  });

  it("force-retry answers 409 until detection has evaluated the rule set", async () => {
    const action = await prisma.lifecycleAction.findFirstOrThrow({ where: { ruleSetId, mediaItemId: await itemId("m2") } });
    await prisma.lifecycleAction.update({ where: { id: action.id }, data: { status: "FAILED" } });
    setMockSession({ isLoggedIn: true, userId });
    const retry = () =>
      callRouteWithParams(retryPost, { id: action.id }, { url: `/api/lifecycle/actions/${action.id}`, method: "POST" });

    const refused = await expectJson<{ error: string }>(await retry(), 409);
    expect(refused.error).toMatch(LATCH_REASON);
    expect(executeAction).not.toHaveBeenCalled();

    await processLifecycleRules(userId);
    expect((await retry()).status).toBeLessThan(300);
    expect(executeAction).toHaveBeenCalled();
  });
});

describe("the play-history pause latch", () => {
  /**
   * A native server with established history, two never-played movies and a
   * rule set matching never-played movies with an armed DO_NOTHING action;
   * detection has run, so both are PENDING.
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
  const release = () =>
    prisma.mediaServer.update({
      where: { id: serverId },
      data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: new Date() },
    });

  it("is recorded by a scheduled detection run that skips the rule set, and lifted by one that evaluates it", async () => {
    await armed();
    await requireLibraryResync([serverId]);
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

    // History back, no detection yet: still held.
    await release();
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  it("is recorded and lifted the same way by the manual run route (runDetection)", async () => {
    await armed();
    await requireLibraryResync([serverId]);
    setMockSession({ isLoggedIn: true, userId });
    const run = () =>
      callRoute(runPost, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: { ruleSetId, fullReEval: true, processActions: true },
      });

    const skipped = await expectJson<{ skipped: Array<{ ruleSetId: string }> }>(await run(), 200);
    expect(skipped.skipped.map((s) => s.ruleSetId)).toEqual([ruleSetId]);
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

    await release();
    await expectJson(await run(), 200);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  it("is recorded by detectAndSaveMatches' own refusal, which keeps the matches", async () => {
    await armed();
    const rs = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSetId } });
    await requireLibraryResync([serverId]);

    const result = await detectAndSaveMatches(
      {
        id: rs.id,
        name: rs.name,
        userId: rs.userId,
        type: rs.type,
        rules: rs.rules,
        seriesScope: rs.seriesScope,
        serverIds: [serverId],
        actionEnabled: rs.actionEnabled,
        actionType: rs.actionType,
        actionDelayDays: rs.actionDelayDays,
        arrInstanceId: rs.arrInstanceId,
        addImportExclusion: rs.addImportExclusion,
        addArrTags: rs.addArrTags,
        removeArrTags: rs.removeArrTags,
        stickyMatches: rs.stickyMatches,
      },
      [serverId],
    );

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

  it("is not lifted by a run that began evaluating before a newer refusal landed — a run outside MAIN_QUEUE racing the schedule", async () => {
    await armed();
    // While this run evaluates (its own check already passed), another run
    // finds the history unestablished and records its refusal.
    m.duringEvaluation = async () => {
      m.duringEvaluation = null;
      // In a later millisecond than this run's start, as it would be: the two
      // are stored to the millisecond, and one in the same millisecond counts
      // as before it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await notePlayHistoryPause(ruleSetId);
    };

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

  it("...nor by a full re-evaluation that began before it (the run route's Re-evaluate)", async () => {
    await armed();
    m.duringEvaluation = async () => {
      m.duringEvaluation = null;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await notePlayHistoryPause(ruleSetId);
    };
    setMockSession({ isLoggedIn: true, userId });
    const reEvaluate = () =>
      callRoute(runPost, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: { ruleSetId, fullReEval: true, processActions: true },
      });

    await expectJson(await reEvaluate(), 200);
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

    await expectJson(await reEvaluate(), 200);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  it("goes with the matches when a rule set edit clears them, and stays when the edit keeps them", async () => {
    await armed();
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: new Date() } });
    setMockSession({ isLoggedIn: true, userId });

    await expectJson(
      await callRouteWithParams(ruleSetPut, { id: ruleSetId }, {
        url: `/api/lifecycle/rules/${ruleSetId}`,
        method: "PUT",
        body: { name: "Renamed" },
        searchParams: { clearMatches: "false" },
      }),
      200,
    );
    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(2);

    await expectJson(
      await callRouteWithParams(ruleSetPut, { id: ruleSetId }, {
        url: `/api/lifecycle/rules/${ruleSetId}`,
        method: "PUT",
        body: { name: "Renamed again" },
      }),
      200,
    );
    expect(await pausedAt(ruleSetId)).toBeNull();
    expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(0);
  });

  it("holds nothing of a rule set that reads no play activity", async () => {
    await armed(BY_TITLE);
    await prisma.ruleSet.update({ where: { id: ruleSetId }, data: { playHistoryPausedAt: new Date() } });
    await comeDue();

    await executeLifecycleActions(userId);

    expect(await prisma.lifecycleAction.count({ where: { ruleSetId, status: "COMPLETED" } })).toBe(2);
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
    // Play Count AND an Arr criterion, with no Arr instance and the history
    // established: skipped for the Arr instance, which says nothing about
    // whether its matches predate a play.
    const user = await createTestUser();
    const server = await createTestServer(user.id, { watchHistorySyncedAt: new Date() });
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "m1", title: "Movie m1", type: "MOVIE", playCount: 0 });
    const rs = await createTestRuleSet(user.id, {
      name: "Unwatched, not in Radarr",
      type: "MOVIE",
      rules: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" },
            { id: "r2", field: "foundInArr", operator: "equals", value: "false", condition: "AND" },
          ],
          groups: [],
        },
      ],
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
    // Play Count = 0 AND an Arr/Seerr criterion: refused for the missing
    // instance first, whatever the play history says.
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
    const watch = (ratingKey: string) =>
      prisma.mediaItem.updateMany({ where: { ratingKey }, data: { playCount: 1, lastPlayedAt: new Date() } });
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

      // The history is established again: the matches from before m1's play stay held.
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
      setMockSession({ isLoggedIn: true, userId });
      const run = () =>
        callRoute(runPost, {
          url: "/api/lifecycle/rules/run",
          method: "POST",
          body: { ruleSetId, fullReEval: true, processActions: true },
        });

      const skipped = await expectJson<{ skipped: Array<{ ruleSetId: string; reason: string }> }>(await run(), 200);
      expect(skipped.skipped).toEqual([expect.objectContaining({ ruleSetId, reason: expect.stringMatching(/^Rules use Arr criteria/) })]);
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);

      await release();
      await prisma.radarrInstance.update({ where: { id: radarrId }, data: { enabled: true } });
      await expectJson(await run(), 200);
      expect(await pausedAt(ruleSetId)).toBeNull();
    });

    it("records it for detectAndSaveMatches' own Seerr refusal, which keeps the matches", async () => {
      let seerrId = "";
      await armed(withCriterion("seerrRequested"), async (uid) => {
        seerrId = (await createTestSeerrInstance(uid)).id;
      });
      const rs = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSetId } });
      await requireLibraryResync([serverId]);
      await prisma.seerrInstance.update({ where: { id: seerrId }, data: { enabled: false } });

      const result = await detectAndSaveMatches(
        {
          id: rs.id,
          name: rs.name,
          userId: rs.userId,
          type: rs.type,
          rules: rs.rules,
          seriesScope: rs.seriesScope,
          serverIds: [serverId],
          actionEnabled: rs.actionEnabled,
          actionType: rs.actionType,
          actionDelayDays: rs.actionDelayDays,
          arrInstanceId: rs.arrInstanceId,
          addImportExclusion: rs.addImportExclusion,
          addArrTags: rs.addArrTags,
          removeArrTags: rs.removeArrTags,
          stickyMatches: rs.stickyMatches,
        },
        [serverId],
      );

      expect(skips()).toContainEqual(expect.stringMatching(/^Refusing to evaluate rule set "Unwatched" — Rules use Seerr criteria/));
      expect(result.count).toBe(2);
      expect(await prisma.ruleMatch.count({ where: { ruleSetId } })).toBe(2);
      expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    });
  });
});
