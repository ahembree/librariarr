/**
 * The Query page's own actions under the rule: a criterion whose value
 * belongs to one episode or one track must never be able to make a whole
 * show or artist the target of an action. A query judges each episode and
 * track on its own, so a whole-record action — Delete from Sonarr or Lidarr,
 * Change Quality Profile, Unmonitor & Delete Files, Monitor & Delete Files,
 * Lidarr's Unmonitor Only and Search for New Copy, tags, a Lidarr file
 * delete's search after, and in the grouped series view Sonarr's Unmonitor
 * Only and Search for New Copy — is refused when the query's criteria include
 * one the gate does not allow for it: the same predicate and field list as a
 * rule set with the scope off and that action (`groupScopeViolation`).
 *
 * Regression: "Resolution = 4K" with Delete from Sonarr, in either view,
 * deleted every show with a single 4K episode. Against the REAL query engine;
 * `executeAction` is mocked, so a call to it is the request reaching Sonarr.
 * There is no public API (`/api/v1`) path to this route.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  expectStreamResult,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
  createTestSonarrInstance,
  createTestLidarrInstance,
  createTestRadarrInstance,
} from "../../setup/test-helpers";
import { compareIds } from "@/lib/conditions/compare-ids";
import { appCache } from "@/lib/cache/memory-cache";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn(async () => {}) };
});

import { POST } from "@/app/api/query/actions/route";
import { executeAction } from "@/lib/lifecycle/actions";
import { groupScopeViolation } from "@/lib/conditions/group-scope";
import { queryActionScopeError } from "@/lib/query/action-scope";

const mockedExecuteAction = vi.mocked(executeAction);

type Rule = { field: string; operator: string; value: string; enabled?: boolean };

function groups(rules: Rule[]) {
  return [{
    id: "g1", condition: "AND", groups: [],
    rules: rules.map((r, i) => ({ id: `r${i + 1}`, condition: "AND", ...r })),
  }];
}

const FOURK = { field: "resolution", operator: "equals", value: "4K" };
const MIXED_SHOW = { field: "parentTitle", operator: "equals", value: "Mixed Show" };
const MP3 = { field: "audioCodec", operator: "equals", value: "mp3" };

describe("POST /api/query/actions — per-episode and per-track criteria under a whole-record action", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    mockedExecuteAction.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** "Mixed Show": three episodes, one of them 4K; and "Mixed Artist": three tracks, one of them MP3. */
  async function seed() {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const shows = await createTestLibrary(server.id, { type: "SERIES" });
    const episodes: string[] = [];
    for (let e = 1; e <= 3; e++) {
      const ep = await createTestMediaItem(shows.id, {
        type: "SERIES", title: `S1E${e}`, parentTitle: "Mixed Show", seasonNumber: 1, episodeNumber: e,
        resolution: e === 2 ? "4k" : "1080",
      });
      await createTestExternalId(ep.id, "TVDB", "424242");
      episodes.push(ep.id);
    }
    episodes.sort(compareIds);
    const fourK = (await getTestPrisma().mediaItem.findFirstOrThrow({ where: { resolution: "4k" } })).id;
    const music = await createTestLibrary(server.id, { type: "MUSIC" });
    const tracks: string[] = [];
    for (let t = 1; t <= 3; t++) {
      const track = await createTestMediaItem(music.id, {
        type: "MUSIC", title: `Track ${t}`, parentTitle: "Mixed Artist", audioCodec: t === 2 ? "mp3" : "flac",
      });
      await createTestExternalId(track.id, "MUSICBRAINZ", "mbid-mixed");
      tracks.push(track.id);
    }
    const mp3 = (await getTestPrisma().mediaItem.findFirstOrThrow({ where: { audioCodec: "mp3" } })).id;
    const sonarr = await createTestSonarrInstance(user.id);
    const lidarr = await createTestLidarrInstance(user.id);
    return { serverId: server.id, sonarrId: sonarr.id, lidarrId: lidarr.id, episodes, fourK, tracks, mp3 };
  }

  function query(serverId: string, type: "SERIES" | "MUSIC", rules: Rule[], includeEpisodes = false) {
    return { mediaTypes: [type], serverIds: [serverId], groups: groups(rules), sortBy: "title", sortOrder: "asc", includeEpisodes };
  }

  function run(body: Record<string, unknown>) {
    return callRoute(POST, { method: "POST", body: { targetQualityProfileId: 1, ...body } });
  }

  it("refuses Delete from Sonarr on a 4K query, in either view, with the reason — and sends nothing", async () => {
    const { serverId, sonarrId, fourK } = await seed();
    for (const includeEpisodes of [false, true]) {
      const refused = await expectJson<{ error: string }>(await run({
        query: query(serverId, "SERIES", [FOURK], includeEpisodes), mediaItemIds: [fourK],
        actionType: "DELETE_SONARR", arrInstanceId: sonarrId,
      }), 400);
      expect(refused.error).toBe(
        `"Delete from Sonarr" acts on the whole show, so it can't follow query criteria that describe one episode or ` +
          `file: Resolution — one matching episode would decide for the whole show. Remove them from the query, or pick ` +
          `an action that acts only on the matched episodes (Delete Files Only, or Unmonitor Only or Search for New Copy ` +
          `with "Include individual episodes" on or a Season Number, Episode Number or Seasons Behind Latest criterion — ` +
          `without tags).`,
      );
    }
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("answers with the predicate a rule set with series scope off and that action is judged by", async () => {
    const { serverId, sonarrId, fourK } = await seed();
    const rules = [FOURK, { field: "playCount", operator: "equals", value: "0" }];
    const refused = await expectJson<{ error: string }>(await run({
      query: query(serverId, "SERIES", rules), mediaItemIds: [fourK], actionType: "DELETE_SONARR", arrInstanceId: sonarrId,
    }), 400);
    const violation = groupScopeViolation("SERIES", false, groups(rules), { actionEnabled: true, actionType: "DELETE_SONARR" })!;
    expect(violation.fields).toEqual(["resolution", "playCount"]);
    expect(refused.error).toBe(queryActionScopeError(violation));
  });

  it("refuses every whole-record action, and a disabled per-episode criterion too", async () => {
    const { serverId, sonarrId, lidarrId, fourK, mp3 } = await seed();
    const whole: Array<["SERIES" | "MUSIC", Record<string, unknown>, boolean?]> = [
      ["SERIES", { actionType: "DELETE_SONARR" }],
      ["SERIES", { actionType: "UNMONITOR_DELETE_FILES_SONARR" }],
      ["SERIES", { actionType: "MONITOR_DELETE_FILES_SONARR" }],
      ["SERIES", { actionType: "CHANGE_QUALITY_PROFILE_SONARR" }],
      ["SERIES", { actionType: "DO_NOTHING", addArrTags: ["seen"] }],
      ["SERIES", { actionType: "DELETE_FILES_SONARR", removeArrTags: ["keep"] }],
      // Grouped by show, Unmonitor Only and Search for New Copy act on the whole series.
      ["SERIES", { actionType: "UNMONITOR_SONARR" }, false],
      ["SERIES", { actionType: "SEARCH_SONARR" }, false],
      ["MUSIC", { actionType: "DELETE_LIDARR" }],
      ["MUSIC", { actionType: "UNMONITOR_DELETE_FILES_LIDARR" }],
      ["MUSIC", { actionType: "MONITOR_DELETE_FILES_LIDARR" }],
      ["MUSIC", { actionType: "CHANGE_QUALITY_PROFILE_LIDARR" }],
      ["MUSIC", { actionType: "UNMONITOR_LIDARR" }],
      ["MUSIC", { actionType: "SEARCH_LIDARR" }],
      ["MUSIC", { actionType: "DELETE_FILES_LIDARR", searchAfterAction: true }],
      ["MUSIC", { actionType: "DO_NOTHING", addArrTags: ["seen"] }],
    ];
    for (const [type, action, includeEpisodes] of whole) {
      const rules = type === "SERIES" ? [FOURK] : [MP3];
      const refused = await expectJson<{ error: string }>(await run({
        query: query(serverId, type, rules, includeEpisodes ?? false),
        mediaItemIds: [type === "SERIES" ? fourK : mp3],
        arrInstanceId: type === "SERIES" ? sonarrId : lidarrId,
        ...action,
      }), 400);
      expect(refused.error, JSON.stringify(action)).toMatch(/^".*" acts on the whole (show|artist), so it can't follow query criteria/);
    }
    // A disabled criterion is one click from being evaluated, as in a rule set.
    const disabled = await expectJson<{ error: string }>(await run({
      query: query(serverId, "SERIES", [MIXED_SHOW, { ...FOURK, enabled: false }]), mediaItemIds: [fourK],
      actionType: "DELETE_SONARR", arrInstanceId: sonarrId,
    }), 400);
    expect(disabled.error).toContain("Resolution");
    expect(mockedExecuteAction).not.toHaveBeenCalled();
  });

  it("runs the actions that act only on the matched episodes or tracks: file deletes, and Unmonitor in episode view", async () => {
    const { serverId, sonarrId, lidarrId, fourK, mp3 } = await seed();
    const allowed: Array<["SERIES" | "MUSIC", Record<string, unknown>, boolean]> = [
      ["SERIES", { actionType: "DELETE_FILES_SONARR" }, false],
      ["SERIES", { actionType: "DELETE_FILES_SONARR", searchAfterAction: true }, true],
      ["SERIES", { actionType: "UNMONITOR_SONARR" }, true],
      ["SERIES", { actionType: "SEARCH_SONARR" }, true],
      ["MUSIC", { actionType: "DELETE_FILES_LIDARR" }, false],
    ];
    for (const [type, action, includeEpisodes] of allowed) {
      mockedExecuteAction.mockClear();
      const response = await run({
        query: query(serverId, type, type === "SERIES" ? [FOURK] : [MP3], includeEpisodes),
        mediaItemIds: [type === "SERIES" ? fourK : mp3],
        arrInstanceId: type === "SERIES" ? sonarrId : lidarrId,
        ...action,
      });
      const { result } = await expectStreamResult<{ executed: number }>(response);
      expect(result.executed, JSON.stringify(action)).toBe(1);
      // On the matched member alone.
      expect(mockedExecuteAction.mock.calls[0][0].matchedMediaItemIds, JSON.stringify(action)).toEqual([type === "SERIES" ? fourK : mp3]);
    }
  });

  it("runs a whole-record action on criteria every member answers alike: the show's name and the series aggregates", async () => {
    const { serverId, sonarrId, episodes } = await seed();
    const response = await run({
      query: query(serverId, "SERIES", [MIXED_SHOW, { field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3" }]),
      mediaItemIds: [episodes[0]],
      actionType: "DELETE_SONARR",
      arrInstanceId: sonarrId,
    });
    const { result } = await expectStreamResult<{ executed: number }>(response);
    expect(result.executed).toBe(1);
    expect(mockedExecuteAction).toHaveBeenCalledTimes(1);
  });

  describe("per-episode criteria (Season Number, Episode Number, Seasons Behind Latest)", () => {
    // Where one episode sits in its show: "Seasons Behind Latest ≥ 2" with
    // Delete from Sonarr deleted every show with three seasons or more, and
    // with Unmonitor & Delete Files (which unmonitors the series) the newest
    // seasons it exists to keep stopped downloading.
    const SEASON_1 = { field: "seasonNumber", operator: "equals", value: "1" };
    const BEHIND = { field: "seasonsBehindLatest", operator: "greaterThanOrEqual", value: "0" };
    const EPISODE_1 = { field: "episodeNumber", operator: "equals", value: "1" };

    it("refuses every whole-series action on a query using one, in either view", async () => {
      const { serverId, sonarrId, episodes } = await seed();
      const whole: Array<Record<string, unknown>> = [
        { actionType: "DELETE_SONARR" },
        { actionType: "UNMONITOR_DELETE_FILES_SONARR" },
        { actionType: "MONITOR_DELETE_FILES_SONARR" },
        { actionType: "CHANGE_QUALITY_PROFILE_SONARR" },
        // Tags act on the whole series, added and removed together or alone.
        { actionType: "UNMONITOR_SONARR", addArrTags: ["old"], removeArrTags: ["keep"] },
        { actionType: "DO_NOTHING", removeArrTags: ["keep"] },
      ];
      for (const criterion of [SEASON_1, BEHIND, EPISODE_1]) {
        for (const includeEpisodes of [false, true]) {
          for (const action of whole) {
            const refused = await expectJson<{ error: string }>(await run({
              query: query(serverId, "SERIES", [criterion], includeEpisodes),
              mediaItemIds: [episodes[0]],
              arrInstanceId: sonarrId,
              ...action,
            }), 400);
            expect(refused.error, `${criterion.field} ${includeEpisodes} ${JSON.stringify(action)}`)
              .toMatch(/^".*" acts on the whole show, so it can't follow query criteria that describe one episode or file: (Season Number|Seasons Behind Latest|Episode Number)/);
          }
        }
      }
      expect(mockedExecuteAction).not.toHaveBeenCalled();
    });

    it("runs Unmonitor Only grouped by show on the matched episodes, and the file delete on them", async () => {
      const { serverId, sonarrId, episodes } = await seed();
      for (const action of [{ actionType: "UNMONITOR_SONARR" }, { actionType: "SEARCH_SONARR" }, { actionType: "DELETE_FILES_SONARR" }]) {
        mockedExecuteAction.mockClear();
        const response = await run({
          query: query(serverId, "SERIES", [MIXED_SHOW, EPISODE_1]),
          mediaItemIds: [episodes[0]],
          arrInstanceId: sonarrId,
          ...action,
        });
        const { result } = await expectStreamResult<{ executed: number }>(response);
        expect(result.executed, JSON.stringify(action)).toBe(1);
        const record = mockedExecuteAction.mock.calls[0][0];
        // Episode 1 alone, never the whole series.
        const ep1 = (await getTestPrisma().mediaItem.findFirstOrThrow({ where: { parentTitle: "Mixed Show", episodeNumber: 1 } })).id;
        expect(record.matchedMediaItemIds, JSON.stringify(action)).toEqual([ep1]);
        if (action.actionType !== "DELETE_FILES_SONARR") expect(record.episodeScope, JSON.stringify(action)).toBe(true);
      }
    });
  });

  it("leaves a movie action alone: a movie is its own record", async () => {
    const { serverId } = await seed();
    const user = await getTestPrisma().user.findFirstOrThrow();
    const radarr = await createTestRadarrInstance(user.id);
    const library = await createTestLibrary(serverId, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "UHD Film", resolution: "4k" });
    await createTestExternalId(movie.id, "TMDB", "777");
    const response = await run({
      query: { ...query(serverId, "SERIES", [FOURK]), mediaTypes: ["MOVIE"] },
      mediaItemIds: [movie.id],
      actionType: "DELETE_RADARR",
      arrInstanceId: radarr.id,
    });
    const { result } = await expectStreamResult<{ executed: number }>(response);
    expect(result.executed).toBe(1);
  });
});
