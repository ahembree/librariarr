/**
 * Per-episode and per-track criteria are not allowed in a series- or
 * artist-scoped rule set (`src/lib/conditions/group-scope.ts`).
 *
 * With "Match against entire series" / "Match against entire artist" on, a
 * rule judges a whole show or artist and its action covers all of it, so a
 * criterion whose value belongs to one file or one episode/track
 * (`Resolution = 4K`) made a whole show match on one episode — and a
 * whole-series delete take every other episode with it.
 *
 * - Saving such a rule set is refused (create, update, turning the scope on).
 * - One already in that state (saved before the rule, or restored) is skipped
 *   by detection, never evaluated, with the reason; Preview and Test Media
 *   answer the reason.
 * - Its actions are held: the scheduled executor, Execute, Execute All and
 *   force-retry refuse them, and the Pending listing reports the hold.
 * - Editing it into a valid state releases it through the normal save and
 *   detection path.
 *
 * `executeAction` is mocked: a call to it is the request reaching Sonarr.
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
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { POST as createRoute } from "@/app/api/lifecycle/rules/route";
import { PUT } from "@/app/api/lifecycle/rules/[id]/route";
import { GET as listActions } from "@/app/api/lifecycle/actions/route";
import { POST as executeRoute } from "@/app/api/lifecycle/actions/execute/route";
import { POST as retryRoute } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as runRoute } from "@/app/api/lifecycle/rules/run/route";
import { POST as previewRoute } from "@/app/api/lifecycle/rules/preview/route";
import { POST as testItemRoute } from "@/app/api/lifecycle/rules/test-item/route";
import { POST as diffRoute } from "@/app/api/lifecycle/rules/[id]/diff/route";
import { _resetExecuteInFlightForTesting } from "@/lib/lifecycle/execute-in-flight";
import { groupScopeHoldReason, groupScopeViolation } from "@/lib/conditions/group-scope";

const prisma = getTestPrisma();

type Rule = { field: string; operator: string; value: string; enabled?: boolean };

function groups(rules: Rule[], nested: unknown[] = []) {
  return [{
    id: "g1",
    condition: "AND",
    rules: rules.map((r, i) => ({ id: `r${i}`, condition: "AND", ...r })),
    groups: nested,
  }];
}

const SHOW = { field: "title", operator: "equals", value: "Mixed Show" };
/** Selects the show by its own name: show-level, allowed in series scope. */
const VALID = groups([SHOW]);
/**
 * The show by name AND an episode at 720p, which none is: evaluated, the
 * show would stop matching and its action be cancelled — so a match and an
 * action that survive a detection run prove it was never evaluated.
 */
const INVALID = groups([SHOW, { field: "resolution", operator: "equals", value: "720" }]);
const REASON = groupScopeHoldReason(groupScopeViolation("SERIES", true, INVALID)!);

/** Which items reached Sonarr. */
function actedOn(): string[] {
  return mockExecuteAction.mock.calls.map((c) => (c[0] as { mediaItem: { id: string } }).mediaItem.id);
}

/** The rule editor's body for a save. */
function editorBody(ruleSet: { name: string; arrInstanceId: string | null; serverIds: string[] }, rules: unknown, seriesScope: boolean) {
  return {
    name: ruleSet.name,
    rules,
    seriesScope,
    enabled: true,
    actionEnabled: true,
    actionType: "DELETE_SONARR",
    actionDelayDays: 0,
    arrInstanceId: ruleSet.arrInstanceId,
    targetQualityProfileId: null,
    addImportExclusion: false,
    searchAfterAction: false,
    addArrTags: [],
    removeArrTags: [],
    collectionId: null,
    discordNotifyOnAction: false,
    discordNotifyOnMatch: false,
    stickyMatches: false,
    serverIds: ruleSet.serverIds,
  };
}

function put(id: string, body: unknown, clearMatches = true) {
  return callRouteWithParams(PUT, { id }, {
    url: `/api/lifecycle/rules/${id}`,
    method: "PUT",
    body,
    ...(clearMatches ? {} : { searchParams: { clearMatches: "false" } }),
  });
}

async function setup() {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id } });
  const server = await createTestServer(user.id);
  setMockSession({ isLoggedIn: true, userId: user.id });
  return { user, server };
}

/**
 * A Delete from Sonarr rule set (series scope on, no delay) that matched
 * "Mixed Show" and scheduled its action under valid rules, then had a
 * per-episode criterion written straight into its rules — a rule set saved
 * before this rule existed, or restored from a backup.
 */
async function legacyInvalid() {
  const { user, server } = await setup();
  const library = await createTestLibrary(server.id, { type: "SERIES" });
  const episodes = [];
  for (let e = 1; e <= 3; e++) {
    const ep = await createTestMediaItem(library.id, {
      type: "SERIES", title: `Episode ${e}`, parentTitle: "Mixed Show", seasonNumber: 1, episodeNumber: e,
      resolution: e === 3 ? "4k" : "1080",
    });
    await createTestExternalId(ep.id, "TVDB", "5001");
    episodes.push(ep);
  }
  const sonarr = await createTestSonarrInstance(user.id);
  const ruleSet = await createTestRuleSet(user.id, {
    name: "Delete Mixed Show",
    type: "SERIES",
    seriesScope: true,
    rules: VALID,
    serverIds: [server.id],
    actionEnabled: true,
    actionType: "DELETE_SONARR",
    arrInstanceId: sonarr.id,
    actionDelayDays: 0,
  });
  await processLifecycleRules(user.id);
  const action = await prisma.lifecycleAction.findFirstOrThrow({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
  await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { rules: INVALID as never } });
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
  return { user, server, episodes, ruleSet, action };
}

type Listing = {
  groups: Array<{
    ruleSet: { id: string; actionsHeldSince: string | null; scopeHoldReason: string | null };
    items: Array<{ id: string; status: string }>;
  }>;
};

async function holdOf(ruleSetId: string, status = "PENDING") {
  const body = await expectJson<Listing>(await callRoute(listActions, { url: `/api/lifecycle/actions?status=${status}` }), 200);
  const group = body.groups.find((g) => g.ruleSet.id === ruleSetId);
  expect(group, `no group for rule set ${ruleSetId}`).toBeDefined();
  return group!.ruleSet;
}

describe("per-episode and per-track criteria at series and artist scope", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    _resetExecuteInFlightForTesting();
    mockExecuteAction.mockResolvedValue({});
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe("saving", () => {
    async function create(body: Record<string, unknown>) {
      return callRoute(createRoute, { url: "/api/lifecycle/rules", method: "POST", body });
    }

    it("refuses to create a series-scoped rule set with a per-episode criterion, naming it", async () => {
      const { server } = await setup();
      const base = { name: "Series", type: "SERIES", serverIds: [server.id] };

      for (const body of [
        { ...base, rules: INVALID, seriesScope: true },
        // Series scope is on unless the request turns it off.
        { ...base, rules: INVALID },
      ]) {
        const refused = await expectJson<{ error: string; details: string[] }>(await create(body), 400);
        expect(refused.error).toBe("Validation failed");
        expect(refused.details).toEqual([
          `rules: With "Match against entire series" on, a rule judges a whole show, so it can't use criteria that ` +
            `describe one episode or file: Resolution. Turn "Match against entire series" off to check them per ` +
            `episode, or remove them.`,
        ]);
      }
      expect(await prisma.ruleSet.count()).toBe(0);
    });

    it("refuses a disabled per-episode rule, one in a nested group, and a stream query group", async () => {
      const { server } = await setup();
      const base = { name: "Series", type: "SERIES", serverIds: [server.id], seriesScope: true };
      const nested = groups([SHOW], [{ id: "g2", condition: "OR", rules: [{ id: "n1", field: "year", operator: "lessThan", value: "2000", condition: "AND" }], groups: [] }]);
      const disabled = groups([SHOW, { field: "container", operator: "equals", value: "avi", enabled: false }]);
      const streamQuery = groups([SHOW], [{
        id: "sq", condition: "AND", streamQuery: { streamType: "audio", quantifier: "none" },
        rules: [{ id: "s1", field: "sqLanguage", operator: "equals", value: "English", condition: "AND" }], groups: [],
      }]);

      for (const [rules, label] of [[nested, "Year"], [disabled, "Container"], [streamQuery, "Stream Query"]] as const) {
        const refused = await expectJson<{ details: string[] }>(await create({ ...base, rules }), 400);
        expect(refused.details[0]).toContain(`one episode or file: ${label}.`);
      }
      expect(await prisma.ruleSet.count()).toBe(0);
    });

    it("refuses to create an artist-scoped rule set with a per-track criterion", async () => {
      const { server } = await setup();
      const refused = await expectJson<{ details: string[] }>(await create({
        name: "Music", type: "MUSIC", serverIds: [server.id], seriesScope: true,
        rules: groups([{ field: "audioCodec", operator: "equals", value: "mp3" }, { field: "albumTitle", operator: "contains", value: "Live" }]),
      }), 400);
      expect(refused.details[0]).toContain(`a rule judges a whole artist, so it can't use criteria that describe one track or file: Audio Codec, Album.`);
    });

    it("saves the same rules with the scope off, show-level criteria with it on, and any criterion on a movie rule set", async () => {
      const { server } = await setup();
      const created = [
        { name: "Episode scope", type: "SERIES", seriesScope: false, rules: INVALID },
        { name: "Track scope", type: "MUSIC", seriesScope: false, rules: groups([{ field: "audioCodec", operator: "equals", value: "mp3" }]) },
        {
          name: "Show level", type: "SERIES", seriesScope: true,
          rules: groups([SHOW, { field: "genre", operator: "equals", value: "Drama" }, { field: "arrEnded", operator: "equals", value: "true" }]),
        },
        { name: "Artist level", type: "MUSIC", seriesScope: true, rules: groups([{ field: "playCount", operator: "equals", value: "0" }]) },
        { name: "Movie", type: "MOVIE", rules: groups([{ field: "resolution", operator: "equals", value: "720" }]) },
      ];
      for (const body of created) {
        await expectJson(await create({ ...body, serverIds: [server.id] }), 201);
      }
      expect(await prisma.ruleSet.count()).toBe(created.length);
    });

    it("refuses an update that adds a per-episode criterion, and turning series scope on over one", async () => {
      const { user, server } = await setup();
      const scoped = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: true, rules: VALID, serverIds: [server.id] });
      const episodeScope = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: false, rules: INVALID, serverIds: [server.id] });

      const added = await expectJson<{ details: string[] }>(await put(scoped.id, editorBody(scoped, INVALID, true)), 400);
      expect(added.details[0]).toMatch(/^rules: .*one episode or file: Resolution\./);
      // A body carrying only the rules is merged with the stored scope.
      await expectJson(await put(scoped.id, { rules: INVALID }), 400);

      const turnedOn = await expectJson<{ details: string[] }>(await put(episodeScope.id, { seriesScope: true }), 400);
      expect(turnedOn.details[0]).toMatch(/^seriesScope: .*one episode or file: Resolution\./);

      expect(await prisma.ruleSet.findUniqueOrThrow({ where: { id: scoped.id } })).toMatchObject({ rules: VALID, seriesScope: true });
      expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: episodeScope.id } })).seriesScope).toBe(false);

      // The valid forms save.
      await expectJson(await put(episodeScope.id, editorBody(episodeScope, INVALID, false)), 200);
      await expectJson(await put(scoped.id, editorBody(scoped, INVALID, false)), 200);
    });

    it("refuses an artist-scoped update the same way", async () => {
      const { user, server } = await setup();
      const artist = await createTestRuleSet(user.id, {
        type: "MUSIC", seriesScope: false, rules: groups([{ field: "year", operator: "lessThan", value: "1990" }]), serverIds: [server.id],
      });

      const refused = await expectJson<{ details: string[] }>(await put(artist.id, { seriesScope: true }), 400);
      expect(refused.details[0]).toContain(`one track or file: Year.`);
      expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: artist.id } })).seriesScope).toBe(false);
    });
  });

  describe("a rule set already in that state", () => {
    it("is skipped by detection, never evaluated, with the reason", async () => {
      const { user, ruleSet, action, episodes } = await legacyInvalid();

      await processLifecycleRules(user.id);

      expect(logger.warn).toHaveBeenCalledWith("Lifecycle", `Skipping rule set "${ruleSet.name}" — ${REASON}`);
      // Evaluated, no episode is 720p: the match and its action would be gone.
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id, mediaItemId: episodes[0].id } })).toBe(1);
      expect(await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
        status: "PENDING", scheduledFor: action.scheduledFor,
      });
    });

    it("is reported skipped by a manual run, and by Preview and Test Media", async () => {
      const { server, ruleSet, episodes } = await legacyInvalid();

      const run = await expectJson<{ ruleMatches: unknown[]; skipped: Array<{ ruleSetId: string; reason: string }> }>(
        await callRoute(runRoute, { url: "/api/lifecycle/rules/run", method: "POST", body: { ruleSetId: ruleSet.id } }),
        200,
      );
      expect(run.ruleMatches).toEqual([]);
      expect(run.skipped).toEqual([{ ruleSetId: ruleSet.id, name: ruleSet.name, reason: REASON }]);

      const body = { rules: INVALID, type: "SERIES", seriesScope: true, serverIds: [server.id], ruleSetId: ruleSet.id };
      const preview = await expectJson<{ error: string }>(
        await callRoute(previewRoute, { url: "/api/lifecycle/rules/preview", method: "POST", body }),
        400,
      );
      expect(preview.error).toBe(REASON);
      const tested = await expectJson<{ error: string }>(
        await callRoute(testItemRoute, { url: "/api/lifecycle/rules/test-item", method: "POST", body: { ...body, mediaItemId: episodes[0].id } }),
        400,
      );
      expect(tested.error).toBe(REASON);
      // The Match Changes Preview of "Save and re-detect" too.
      const diff = await expectJson<{ error: string }>(
        await callRouteWithParams(diffRoute, { id: ruleSet.id }, {
          url: `/api/lifecycle/rules/${ruleSet.id}/diff`, method: "POST", body: { rules: INVALID, type: "SERIES", seriesScope: true, serverIds: [server.id] },
        }),
        400,
      );
      expect(diff.error).toBe(REASON);

      // With series scope off the same rules are checked per episode.
      await expectJson(
        await callRoute(testItemRoute, {
          url: "/api/lifecycle/rules/test-item", method: "POST",
          body: { ...body, seriesScope: false, mediaItemId: episodes[0].id },
        }),
        200,
      );
    });

    it("has its pending action held by the scheduled executor, Execute and Execute All, and listed as held", async () => {
      const { user, ruleSet, action, episodes } = await legacyInvalid();

      await executeLifecycleActions(user.id);
      expect(actedOn()).toEqual([]);
      expect(await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
        status: "PENDING", scheduledFor: action.scheduledFor,
      });
      expect(logger.info).toHaveBeenCalledWith("Lifecycle", `Holding the due actions of rule set "${ruleSet.name}" — ${REASON}`);

      for (const body of [{ ruleSetId: ruleSet.id }, { ruleSetId: ruleSet.id, mediaItemIds: [episodes[0].id] }]) {
        const refused = await expectJson<{ error: string }>(await callRoute(executeRoute, { method: "POST", body }), 409);
        expect(refused.error).toBe(REASON);
      }
      expect(actedOn()).toEqual([]);

      expect(await holdOf(ruleSet.id)).toMatchObject({ actionsHeldSince: null, scopeHoldReason: REASON });
    });

    it("is refused by detection's own guard when a caller goes straight to it", async () => {
      const { user, server, ruleSet, action, episodes } = await legacyInvalid();
      const stored = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });

      await detectAndSaveMatches(
        { ...stored, type: "SERIES", rules: stored.rules, seriesScope: true, serverIds: [server.id] } as never,
        [server.id],
        undefined,
        undefined,
        true, // a full re-evaluation would replace every match
      );

      expect(logger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining(`Refusing to evaluate rule set "${ruleSet.name}" — ${REASON}`));
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id, mediaItemId: episodes[0].id } })).toBe(1);
      expect((await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
      expect(user.id).toBeTruthy();
    });

    it("holds an action whose rule set fell into that state after the executor loaded it", async () => {
      // Restored over a running execution, say: pass 2 re-reads the rule set
      // under the item lock and leaves the action for the next run.
      const { user, ruleSet, action } = await legacyInvalid();
      await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { rules: VALID as never } });
      const exceptions = prisma.lifecycleException;
      const original = exceptions.findMany.bind(exceptions);
      const spy = vi.spyOn(exceptions, "findMany").mockImplementationOnce((async (...args: Parameters<typeof original>) => {
        await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { rules: INVALID as never } });
        return original(...args);
      }) as never);

      await executeLifecycleActions(user.id);

      expect(spy).toHaveBeenCalled();
      expect(actedOn()).toEqual([]);
      expect((await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
      expect(logger.info).toHaveBeenCalledWith("Lifecycle", expect.stringMatching(/was held after this run started$/));
      spy.mockRestore();
    });

    it("has a failed action refused by force-retry", async () => {
      const { ruleSet, action } = await legacyInvalid();
      await prisma.lifecycleAction.update({ where: { id: action.id }, data: { status: "FAILED", error: "timeout" } });

      const refused = await expectJson<{ error: string }>(
        await callRouteWithParams(retryRoute, { id: action.id }, { method: "POST" }),
        409,
      );

      expect(refused.error).toBe(REASON);
      expect(actedOn()).toEqual([]);
      expect(await holdOf(ruleSet.id, "FAILED")).toMatchObject({ scopeHoldReason: REASON });
    });

    it("can still be disabled or renamed without being fixed", async () => {
      const { ruleSet } = await legacyInvalid();
      await expectJson(await put(ruleSet.id, { enabled: false }, false), 200);
      await expectJson(await put(ruleSet.id, { name: "Renamed" }, false), 200);
      expect(await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).toMatchObject({ enabled: false, name: "Renamed" });
    });

    it("refuses an editor save that leaves it as it is", async () => {
      const { ruleSet } = await legacyInvalid();
      await expectJson(await put(ruleSet.id, editorBody(ruleSet, INVALID, true), false), 400);
    });

    it("runs its still-matching action normally once edited to a valid state and re-detected", async () => {
      const { user, ruleSet, action, episodes } = await legacyInvalid();

      // "Save only": the per-episode criterion removed, the matches kept.
      await expectJson(await put(ruleSet.id, editorBody(ruleSet, VALID, true), false), 200);
      const saved = await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } });
      expect(saved.actionsHeldSince).not.toBeNull();
      // Held until detection re-checks the matches under the edited rules.
      expect(await holdOf(ruleSet.id)).toMatchObject({ scopeHoldReason: null });
      await executeLifecycleActions(user.id);
      expect(actedOn()).toEqual([]);

      await processLifecycleRules(user.id);
      expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).toBeNull();
      expect(await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
        status: "PENDING", scheduledFor: action.scheduledFor,
      });

      await executeLifecycleActions(user.id);
      expect(actedOn()).toEqual([episodes[0].id]);
    });
  });
});
