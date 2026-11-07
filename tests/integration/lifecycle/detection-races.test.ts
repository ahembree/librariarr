/**
 * An action must never run against matches or members computed from rules
 * other than its rule set's current rules (`ruleSetVersion`,
 * `lockRuleSetAtVersion` in `src/lib/lifecycle/rule-set-matching.ts`).
 *
 * Nothing serialises detection: the scheduled run and "Save and re-detect"
 * (`/api/lifecycle/rules/run`) can overlap, and the executors run beside both.
 * The edit hold (`actionsHeldSince`) covers what a save leaves stored, but not
 * a run already under way:
 *
 *  (a) a scheduled run that read the OLD rules wrote their matches and
 *      scheduled their actions after "Save and re-detect" had evaluated the
 *      new rules and released the hold — at the match write, or between it
 *      and the scheduling;
 *  (b) the scheduled executor's pass 2 ran the member list pass 1 built from
 *      the old matches: no hold, the action row unchanged;
 *  (c) Execute All checked the hold once and went on acting through a save
 *      and re-detect landing mid-loop.
 *
 * Each test injects the save (and the re-detect) between the read and the
 * write it races, through a spy on a call made at exactly that point.
 * `executeAction` is mocked: a call to it is the request reaching the Arr app.
 */
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
  createTestExternalId,
  createTestRadarrInstance,
  createTestSonarrInstance,
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

const { mockExecuteAction } = vi.hoisted(() => ({ mockExecuteAction: vi.fn() }));

vi.mock("@/lib/lifecycle/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/actions")>()),
  executeAction: mockExecuteAction,
}));
vi.mock("@/lib/discord/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord/client")>()),
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: vi.fn() }));
vi.mock("@/lib/sync/sync-incremental", () => ({
  syncMediaServerItems: vi.fn().mockResolvedValue({ status: "fell-back", upserted: 0, deleted: 0, reason: "test" }),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn(),
  syncCollectionById: vi.fn(),
  syncAllCollections: vi.fn(),
  removeItemFromCollections: vi.fn(),
  removePlexCollection: vi.fn(),
  renameCollectionInPlex: vi.fn(),
}));

import { logger } from "@/lib/logger";
import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { PUT } from "@/app/api/lifecycle/rules/[id]/route";
import { POST as runRoute } from "@/app/api/lifecycle/rules/run/route";
import { POST as executeRoute } from "@/app/api/lifecycle/actions/execute/route";
import { _resetExecuteInFlightForTesting } from "@/lib/lifecycle/execute-in-flight";
import { compareIds } from "@/lib/conditions/compare-ids";

const prisma = getTestPrisma();

type Rule = { field: string; operator: string; value: string; negate?: boolean };

function groups(rules: Rule[]) {
  return [{ id: "g1", condition: "AND", rules: rules.map((r, i) => ({ id: `r${i}`, condition: "AND", ...r })), groups: [] }];
}

const titled = (title: string) => groups([{ field: "title", operator: "equals", value: title }]);

/** Which items reached the Arr app, and with which members. */
function actedOn(): Array<{ id: string; members: string[] }> {
  return mockExecuteAction.mock.calls.map((c) => {
    const action = c[0] as { mediaItem: { id: string }; matchedMediaItemIds: string[] };
    return { id: action.mediaItem.id, members: [...action.matchedMediaItemIds].sort(compareIds) };
  });
}

/** "Save only" in the editor: new rules, the matches kept, the actions held. */
async function saveRules(ruleSetId: string, rules: unknown) {
  await expectJson(
    await callRouteWithParams(PUT, { id: ruleSetId }, {
      url: `/api/lifecycle/rules/${ruleSetId}`, method: "PUT", body: { rules }, searchParams: { clearMatches: "false" },
    }),
    200,
  );
}

/** Re-evaluate on the Matches page, as "Save and re-detect" runs it: detection, then scheduling. */
async function redetect(ruleSetId: string) {
  return expectJson<{ skipped: Array<{ ruleSetId: string; reason: string }> }>(
    await callRoute(runRoute, { url: "/api/lifecycle/rules/run", method: "POST", body: { ruleSetId, processActions: true } }),
    200,
  );
}

/** Runs `inject` the first time `method` is called, then the call itself. */
function injectAtFirst<T extends object>(delegate: T, method: keyof T & string, inject: () => Promise<void>) {
  const original = (delegate[method] as (...args: unknown[]) => unknown).bind(delegate);
  return vi.spyOn(delegate, method as never).mockImplementationOnce((async (...args: unknown[]) => {
    await inject();
    return original(...args);
  }) as never);
}

async function setup() {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id } });
  const server = await createTestServer(user.id);
  setMockSession({ isLoggedIn: true, userId: user.id });
  return { user, server };
}

/** Two movies, and a Delete from Radarr rule set (no delay) selecting `rules`. */
async function twoMovies(rules: unknown, extra: Record<string, unknown> = {}) {
  const { user, server } = await setup();
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const movieA = await createTestMediaItem(library.id, { type: "MOVIE", title: "Movie A", year: 2001 });
  const movieB = await createTestMediaItem(library.id, { type: "MOVIE", title: "Movie B", year: 2002 });
  await createTestExternalId(movieA.id, "TMDB", "1001");
  await createTestExternalId(movieB.id, "TMDB", "1002");
  const radarr = await createTestRadarrInstance(user.id);
  const ruleSet = await createTestRuleSet(user.id, {
    name: "Delete movies", type: "MOVIE", rules, serverIds: [server.id],
    actionEnabled: true, actionType: "DELETE_RADARR", arrInstanceId: radarr.id, actionDelayDays: 0,
  });
  if (Object.keys(extra).length > 0) await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: extra });
  return { user, movieA, movieB, ruleSet };
}

async function pendingItems(ruleSetId: string) {
  const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId, status: "PENDING" }, select: { mediaItemId: true } });
  return pending.map((a) => a.mediaItemId).sort();
}

async function matchedItems(ruleSetId: string) {
  const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId }, select: { mediaItemId: true } });
  return matches.map((m) => m.mediaItemId).sort();
}

describe("detection and execution racing an edit", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    _resetExecuteInFlightForTesting();
    mockExecuteAction.mockResolvedValue({});
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe("(a) a scheduled detection run that read the old rules", () => {
    it("discards its matches when a save and re-detect land while it evaluates", async () => {
      const { user, movieA, movieB, ruleSet } = await twoMovies(titled("Movie A"));

      // The scheduled run has read the rule set (Movie A) and is evaluating
      // when the user saves Movie B and re-detects: that run evaluates Movie
      // B, releases the edit's hold and schedules Movie B's delete.
      const spy = injectAtFirst(prisma.mediaItem, "findMany", async () => {
        await saveRules(ruleSet.id, titled("Movie B"));
        await redetect(ruleSet.id);
      });

      await processLifecycleRules(user.id);

      expect(spy).toHaveBeenCalled();
      // Left as the newer run wrote them: Movie B, unheld.
      expect(await matchedItems(ruleSet.id)).toEqual([movieB.id]);
      expect(await pendingItems(ruleSet.id)).toEqual([movieB.id]);
      expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).toBeNull();
      expect(logger.info).toHaveBeenCalledWith("Lifecycle", expect.stringMatching(/^Discarded this run's matches for rule set "Delete movies"/));

      await executeLifecycleActions(user.id);
      // Movie A — which the current rules do not select — is never deleted.
      expect(actedOn().map((a) => a.id)).toEqual([movieB.id]);
      expect(movieA.id).not.toBe(movieB.id);
    });

    it("schedules nothing when the save and re-detect land between its match write and its scheduling", async () => {
      // Match-change notifications on: the run reads the webhook settings
      // after writing its matches and before scheduling — where the save lands.
      const { user, movieA, movieB, ruleSet } = await twoMovies(titled("Movie A"), { discordNotifyOnMatch: true });

      const spy = injectAtFirst(prisma.appSettings, "findUnique", async () => {
        await saveRules(ruleSet.id, titled("Movie B"));
        await redetect(ruleSet.id);
      });

      await processLifecycleRules(user.id);

      expect(spy).toHaveBeenCalled();
      // The newer run's actions stand; the older one neither cancelled them
      // nor scheduled Movie A's.
      expect(await pendingItems(ruleSet.id)).toEqual([movieB.id]);
      expect(await matchedItems(ruleSet.id)).toEqual([movieB.id]);
      expect(logger.info).toHaveBeenCalledWith("Lifecycle", expect.stringMatching(/^Left the actions of rule set "Delete movies" as they were/));

      await executeLifecycleActions(user.id);
      expect(actedOn().map((a) => a.id)).toEqual([movieB.id]);
      expect(movieA.id).not.toBe(movieB.id);
    });

    it("reports a manual run whose result it discarded, rather than a clean success", async () => {
      const { ruleSet } = await twoMovies(titled("Movie A"));

      // A save landing while "Re-evaluate" evaluates the rule set.
      injectAtFirst(prisma.mediaItem, "findMany", async () => {
        await saveRules(ruleSet.id, titled("Movie B"));
      });

      const run = await redetect(ruleSet.id);

      expect(run.skipped).toEqual([expect.objectContaining({ ruleSetId: ruleSet.id, reason: expect.stringMatching(/edited while this run evaluated it/) })]);
      expect(await matchedItems(ruleSet.id)).toEqual([]);
      expect(await pendingItems(ruleSet.id)).toEqual([]);
      // Still held for the save: the next run evaluates the new rules.
      expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).not.toBeNull();
    });
  });

  describe("(b) the scheduled executor's pass 2", () => {
    it("leaves an action whose rule set was edited and re-detected after pass 1 judged it", async () => {
      const { user, server } = await setup();
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const episodes = [];
      for (let e = 1; e <= 3; e++) {
        const ep = await createTestMediaItem(library.id, {
          type: "SERIES", title: `Episode ${e}`, parentTitle: "Show", seasonNumber: 1, episodeNumber: e,
        });
        await createTestExternalId(ep.id, "TVDB", "7001");
        episodes.push(ep);
      }
      const [first, middle, last] = episodes.map((ep) => ep.id).sort(compareIds);
      const middleTitle = episodes.find((ep) => ep.id === middle)!.title;
      const sonarr = await createTestSonarrInstance(user.id);
      // Delete Files on every episode of Show, series scope off.
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Show files", type: "SERIES", seriesScope: false, serverIds: [server.id],
        rules: groups([{ field: "parentTitle", operator: "equals", value: "Show" }]),
        actionEnabled: true, actionType: "DELETE_FILES_SONARR", arrInstanceId: sonarr.id, actionDelayDays: 0,
      });
      await processLifecycleRules(user.id);
      const action = await prisma.lifecycleAction.findFirstOrThrow({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
      expect(action.mediaItemId).toBe(first);
      expect([...action.matchedMediaItemIds].sort(compareIds)).toEqual([first, middle, last]);

      // Pass 1 has read the matches (every episode a member) when the user
      // narrows the rules to leave the middle episode out and re-detects:
      // the show still matches through the first episode, so its action row
      // is untouched, and the re-detect releases the edit's hold.
      const spy = injectAtFirst(prisma.lifecycleException, "findMany", async () => {
        await saveRules(ruleSet.id, groups([
          { field: "parentTitle", operator: "equals", value: "Show" },
          { field: "title", operator: "equals", value: middleTitle, negate: true },
        ]));
        await redetect(ruleSet.id);
      });

      await executeLifecycleActions(user.id);

      expect(spy).toHaveBeenCalled();
      expect(actedOn()).toEqual([]);
      expect(await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
        status: "PENDING", updatedAt: action.updatedAt,
      });
      expect(logger.info).toHaveBeenCalledWith("Lifecycle", expect.stringMatching(/for the next run — rule set "Show files" was edited after this run started$/));

      // The next run judges it under the current rules: the middle episode is left alone.
      await executeLifecycleActions(user.id);
      expect(actedOn()).toEqual([{ id: first, members: [first, last] }]);
    });
  });

  describe("(c) Execute and Execute All", () => {
    it("stops Execute All when the rule set is edited and re-detected mid-run", async () => {
      const { user, movieA, movieB, ruleSet } = await twoMovies(groups([{ field: "title", operator: "contains", value: "Movie" }]));
      await processLifecycleRules(user.id);
      expect(await matchedItems(ruleSet.id)).toEqual([movieA.id, movieB.id].sort());

      // While the first deletion is with Radarr, the user narrows the rules to
      // match nothing and re-detects.
      mockExecuteAction.mockImplementationOnce(async () => {
        await saveRules(ruleSet.id, titled("Movie C"));
        await redetect(ruleSet.id);
        return {};
      });

      const result = await expectJson<{ executed: number; failed: number; stopped?: string }>(
        await callRoute(executeRoute, { method: "POST", body: { ruleSetId: ruleSet.id } }),
        200,
      );

      // The one under way ran; the next was not sent.
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ executed: 1, failed: 0 });
      expect(result.stopped).toMatch(/^The rule set was edited while its actions ran/);
    });

    it("refuses Execute when the rule set is edited after the route read it, before anything ran", async () => {
      const { user, movieA, ruleSet } = await twoMovies(titled("Movie A"));
      await processLifecycleRules(user.id);

      // The route has checked the hold and read the matches; it now loads the
      // items to act on — when a save lands.
      injectAtFirst(prisma.mediaItem, "findMany", async () => {
        await saveRules(ruleSet.id, titled("Movie B"));
      });

      const refused = await expectJson<{ error: string }>(
        await callRoute(executeRoute, { method: "POST", body: { ruleSetId: ruleSet.id, mediaItemIds: [movieA.id] } }),
        409,
      );

      expect(refused.error).toMatch(/^The rule set was edited while its actions ran/);
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });
  });
});
