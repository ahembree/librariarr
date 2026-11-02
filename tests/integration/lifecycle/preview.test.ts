import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  expectStreamResult,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRadarrInstance,
  createTestExternalId,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock Arr clients (used by ad-hoc preview for arrMetadata fetching). Movies
// are served per instance URL so a test can tell which instance was read.
const radarrMoviesByUrl = vi.hoisted(() => new Map<string, unknown[]>());
vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function (url: string) {
    return {
      getMovies: vi.fn().mockResolvedValue(radarrMoviesByUrl.get(url) ?? []),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
      getCustomFormatScores: vi.fn().mockResolvedValue(new Map()),
    };
  }),
}));

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      getSeries: vi.fn().mockResolvedValue([]),
      getSeriesIdsWithUpcomingEpisodes: vi.fn().mockResolvedValue(new Set()),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      getArtists: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Import AFTER mocks
import { POST as adHocPreviewPOST } from "@/app/api/lifecycle/rules/preview/route";
// The real client the Preview button feeds every response to. Imported here so
// the refusal below is asserted end-to-end rather than only at the route.
import { consumeProgressStream } from "@/lib/progress/client";

describe("Lifecycle Rules Preview", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    radarrMoviesByUrl.clear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("POST /api/lifecycle/rules/preview", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules: [], type: "MOVIE" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when rules are missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { type: "MOVIE" },
      });

      const err = await expectJson<{ error: string }>(response, 400);
      expect(err.error).toBe("Validation failed");
    });

    it("returns 400 when type is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules: [] },
      });

      const err = await expectJson<{ error: string }>(response, 400);
      expect(err.error).toBe("Validation failed");
    });

    it("returns 400 when rules is not an array", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules: "invalid", type: "MOVIE" },
      });

      const err = await expectJson<{ error: string }>(response, 400);
      expect(err.error).toBe("Validation failed");
    });

    it("evaluates ad-hoc rules and returns matching items", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(library.id, {
        title: "Old Movie",
        type: "MOVIE",
        year: 2000,
        playCount: 0,
      });
      await createTestMediaItem(library.id, {
        title: "New Movie",
        type: "MOVIE",
        year: 2024,
        playCount: 0,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            {
              id: "r1",
              field: "year",
              operator: "lessThan",
              value: 2010,
              condition: "AND",
            },
          ],
        },
      });

      const { result: body } = await expectStreamResult<{ items: { title: string }[]; count: number }>(
        response,
      );
      expect(body.count).toBe(1);
      expect(body.items[0].title).toBe("Old Movie");
    });

    it("returns 400 with empty rules array (min 1 required)", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { type: "MOVIE", rules: [] },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when all rules are disabled (safety guard)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            {
              id: "r1",
              field: "playCount",
              operator: "greaterThan",
              value: 0,
              condition: "AND",
              enabled: false,
            },
          ],
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("No active rules to evaluate");
    });

    it("returns 400 when all groups are disabled (safety guard)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            {
              id: "g1",
              condition: "AND",
              enabled: false,
              rules: [
                { id: "r1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND" },
              ],
              groups: [],
            },
          ],
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("No active rules to evaluate");
    });
  });

  describe("series-aggregate rules with series scope off", () => {
    // Detection routes such a rule set through the series aggregate (members
    // restricted to the matching episodes); the preview evaluated it per
    // episode, where the aggregate reads absent, and showed a different set.
    it("previews the set detection stores", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      for (let e = 1; e <= 5; e++) {
        await createTestMediaItem(library.id, { type: "SERIES", title: `Big ${e}`, parentTitle: "Big Show", seasonNumber: 1, episodeNumber: e });
      }
      await createTestMediaItem(library.id, { type: "SERIES", title: "Small 1", parentTitle: "Small Show", seasonNumber: 1, episodeNumber: 1 });
      const rules = [{
        id: "g", condition: "AND", groups: [],
        rules: [{ id: "r", field: "availableEpisodeCount", operator: "lessThan", value: "3", condition: "AND" }],
      }];
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules, type: "SERIES", seriesScope: false, serverIds: [server.id] },
      });
      const { result } = await expectStreamResult<{ items: Array<{ title: string }> }>(response);
      expect(result.items.map((i) => i.title)).toEqual(["Small Show"]);
    });

    it("previews only the episodes that match on their own as the show's members, as detection stores them", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const GiB = BigInt(1024 * 1024 * 1024);
      const big = await createTestMediaItem(library.id, { type: "SERIES", title: "Big", parentTitle: "Small Show", seasonNumber: 1, episodeNumber: 1, fileSize: GiB * BigInt(3) });
      await createTestMediaItem(library.id, { type: "SERIES", title: "Small", parentTitle: "Small Show", seasonNumber: 1, episodeNumber: 2, fileSize: GiB });
      // The show (4 GiB in all) passes the size rule; only one episode does on its own.
      const rules = [{
        id: "g", condition: "AND", groups: [],
        rules: [
          { id: "r1", field: "availableEpisodeCount", operator: "lessThan", value: "3", condition: "AND" },
          { id: "r2", field: "fileSize", operator: "greaterThan", value: "2000", condition: "AND" },
        ],
      }];
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules, type: "SERIES", seriesScope: false, serverIds: [server.id] },
      });
      const { result } = await expectStreamResult<{ items: Array<{ title: string; memberIds?: string[] }> }>(response);
      expect(result.items.map((i) => i.title)).toEqual(["Small Show"]);
      expect(result.items[0].memberIds).toEqual([big.id]);
    });
  });

  // Arr/Seerr rules evaluated with no enabled instance behind them would
  // preview the ENTIRE library as matching ("foundInArr = false" goes
  // vacuously true) — the routes must refuse instead.
  describe("no-enabled-instance match-all guard", () => {
    it("ad-hoc preview evaluates Arr rules normally once an enabled instance exists", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(library.id, { title: "Unmanaged Movie", type: "MOVIE" });
      await createTestRadarrInstance(user.id, { enabled: true });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            { id: "r1", field: "foundInArr", operator: "equals", value: "false", condition: "AND" },
          ],
        },
      });

      // Instance exists (mocked client returns an empty Radarr library), so
      // "not found in Arr" legitimately matches the unmanaged item.
      const { result: body } = await expectStreamResult<{ count: number; items: Array<{ title: string }> }>(response);
      expect(body.count).toBe(1);
      expect(body.items.map((i) => i.title)).toEqual(["Unmanaged Movie"]);
    });

    it("reads Arr criteria from the rule set's own instance, not another one", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { title: "Only In 1080p", type: "MOVIE" });
      await createTestExternalId(movie.id, "TMDB", "100");
      await createTestRadarrInstance(user.id, { name: "Radarr 1080p", url: "http://radarr-hd:7878" });
      const uhd = await createTestRadarrInstance(user.id, { name: "Radarr 4K", url: "http://radarr-4k:7878" });
      radarrMoviesByUrl.set("http://radarr-hd:7878", [
        { id: 1, tmdbId: 100, title: "Only In 1080p", tags: [], qualityProfileId: 1, monitored: true, hasFile: false },
      ]);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const adHoc = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          arrInstanceId: uhd.id,
          rules: [
            { id: "r1", field: "foundInArr", operator: "equals", value: "false", condition: "AND" },
          ],
        },
      });
      // Not on the 4K instance the rule set acts on — even though the 1080p
      // instance has it.
      const { result: adHocBody } = await expectStreamResult<{ count: number }>(adHoc);
      expect(adHocBody.count).toBe(1);
    });

    it("refuses when the chosen Arr instance is disabled, even with another enabled", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestRadarrInstance(user.id, { name: "Radarr 1080p", enabled: true });
      const uhd = await createTestRadarrInstance(user.id, { name: "Radarr 4K", enabled: false });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          arrInstanceId: uhd.id,
          rules: [
            { id: "r1", field: "foundInArr", operator: "equals", value: "false", condition: "AND" },
          ],
        },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/instance "Radarr 4K" is disabled/);
    });

    it("ad-hoc preview returns 400 when rules use Arr criteria and no enabled Arr instance exists", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            { id: "r1", field: "foundInArr", operator: "equals", value: "false", condition: "AND" },
          ],
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/no enabled Radarr instance/i);
    });

    it("ad-hoc preview returns 400 for Seerr criteria on a MUSIC preview", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MUSIC" });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MUSIC",
          serverIds: [server.id],
          rules: [
            { id: "r1", field: "seerrRequested", operator: "equals", value: "false", condition: "AND" },
          ],
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/Seerr criteria are not supported for music/i);
    });
  });
  // ---- The refusal actually reaching the user ----
  //
  // The route and the client were each correct in isolation and broken
  // together. A refusal is answered as plain JSON BEFORE the NDJSON stream
  // opens, and the client fed EVERY response to `consumeProgressStream`, where
  // that single line parsed as an event with no `type`, fell through every
  // branch, and surfaced as "Stream ended without a result" — the guard's
  // reason discarded and replaced by a parse complaint the UI then swallowed
  // into `console.error`. Clicking Preview mid-Tracearr-import did nothing
  // visible at all.
  //
  // So these assert the seam, not either half: the REAL route's response run
  // through the REAL client, and the message that comes out is the one the
  // toast puts on screen.
  describe("a refusal reaches the client that reads it", () => {
    it("surfaces the play-history reason through consumeProgressStream", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      // Never synced: what a brand-new server, a watch-history source switch,
      // or an in-flight Tracearr backfill all leave behind.
      const server = await createTestServer(user.id, { watchHistorySyncedAt: null });
      await createTestLibrary(server.id, { type: "MOVIE" });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          rules: [{ id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" }],
          type: "MOVIE",
          serverIds: [server.id],
        },
      });

      expect(response.status).toBe(400);
      await expect(consumeProgressStream(response, () => {})).rejects.toThrow(
        /play activity.*no established play history/is,
      );
    });

    // The other two dimensions of the same guard travel the same path.
    it("surfaces the missing-Arr-instance reason through consumeProgressStream", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          rules: [{ id: "r1", field: "foundInArr", operator: "equals", value: "false", condition: "AND" }],
          type: "MOVIE",
          serverIds: [server.id],
        },
      });

      expect(response.status).toBe(400);
      await expect(consumeProgressStream(response, () => {})).rejects.toThrow(
        /no enabled Radarr instance/i,
      );
    });

    // The success path must keep working through the same client — a non-OK
    // guard that also broke ordinary previews would be a worse bug than the
    // one it fixes.
    it("still yields the result payload for a preview that is allowed", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(library.id, { title: "Unwatched Film", playCount: 0 });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          rules: [{ id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" }],
          type: "MOVIE",
          serverIds: [server.id],
        },
      });

      expect(response.status).toBe(200);
      const result = await consumeProgressStream<{ items: Array<{ title: string }> }>(
        response,
        () => {},
      );
      expect(result.items.map((i) => i.title)).toEqual(["Unwatched Film"]);
    });
  });
});
