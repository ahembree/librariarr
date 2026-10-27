/**
 * Extra coverage for the rule editor's evaluation routes against the REAL
 * engine (only the Arr/Seerr metadata fetchers are stubbed):
 *   POST /api/lifecycle/rules/preview   — Seerr and music-scope paths
 *   POST /api/lifecycle/rules/test-item — Arr/Seerr reads and group aggregates
 */
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
  createTestExternalId,
  createTestRuleSet,
  createTestRuleMatch,
  callRouteWithParams,
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

// The routes read through the editor's preview caches (`loadPreviewMetadata`,
// `fetchArrRecordForPreview`); those are mocked here, and tested on their own.
const mockFetchArr = vi.hoisted(() => vi.fn());
const mockFetchArrRecord = vi.hoisted(() => vi.fn());
const mockFetchSeerr = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lifecycle/fetch-arr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-arr-metadata")>();
  return {
    ...actual,
    fetchArrMetadataForPreview: mockFetchArr,
    fetchArrRecordForPreview: mockFetchArrRecord,
    hasEnabledArrInstances: vi.fn().mockResolvedValue(true),
    resolveArrInstanceScope: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-seerr-metadata")>();
  return { ...actual, fetchSeerrMetadataForPreview: mockFetchSeerr, hasEnabledSeerrInstances: vi.fn().mockResolvedValue(true) };
});

import { POST as preview } from "@/app/api/lifecycle/rules/preview/route";
import { POST as testItem } from "@/app/api/lifecycle/rules/test-item/route";
import { POST as diff } from "@/app/api/lifecycle/rules/[id]/diff/route";

const rule = (field: string, operator: string, value: unknown) => [
  { id: "g1", condition: "AND", rules: [{ id: "r1", field, operator, value, condition: "AND" }], groups: [] },
];

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  mockFetchArr.mockResolvedValue({});
  mockFetchArrRecord.mockResolvedValue({});
  mockFetchSeerr.mockResolvedValue({});
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("POST /api/lifecycle/rules/preview", () => {
  it("fetches Seerr metadata for Seerr criteria and reports its phase", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const requested = await createTestMediaItem(lib.id, { title: "Requested" });
    await createTestExternalId(requested.id, "TMDB", "1");
    await createTestMediaItem(lib.id, { title: "Never requested" });
    mockFetchSeerr.mockImplementation(async (_u: string, _t: string, onProgress?: (f: number) => void) => {
      onProgress?.(0.5);
      return { "TMDB:1": { requested: true, requestCount: 1, requestDate: null, requestedBy: ["alice"], approvalDate: null, declineDate: null } };
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const { result, events } = await expectStreamResult<{ items: Array<{ title: string }>; count: number }>(
      await callRoute(preview, {
        url: "/api/lifecycle/rules/preview", method: "POST",
        body: { type: "MOVIE", serverIds: [server.id], rules: rule("seerrRequested", "equals", "true") },
      }),
    );

    expect(mockFetchSeerr).toHaveBeenCalledWith(user.id, "MOVIE", expect.any(Function));
    expect(result.items.map((i) => i.title)).toEqual(["Requested"]);
    expect(events.some((e) => e.type === "phase" && e.key === "seerr" && e.fraction === 0.5)).toBe(true);
  });

  it("evaluates music in artist scope and lists the artists alphabetically", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Yellow", parentTitle: "Coldplay", albumTitle: "Parachutes" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Airbag", parentTitle: "Radiohead", albumTitle: "OK Computer" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Intro", parentTitle: "ABBA", albumTitle: "Gold" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const { result } = await expectStreamResult<{ items: Array<{ title: string; parentTitle: string | null }> }>(
      await callRoute(preview, {
        url: "/api/lifecycle/rules/preview", method: "POST",
        body: { type: "MUSIC", serverIds: [server.id], rules: rule("playCount", "equals", 0) },
      }),
    );

    expect(result.items.map((i) => i.parentTitle ?? i.title)).toEqual(["ABBA", "Coldplay", "Radiohead"]);
  });
});

describe("POST /api/lifecycle/rules/test-item", () => {
  const call = (body: unknown) =>
    callRoute(testItem, { url: "/api/lifecycle/rules/test-item", method: "POST", body });

  it("reads the Arr record the item resolves to", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(lib.id, { title: "Heat" });
    await createTestExternalId(movie.id, "TMDB", "949");
    mockFetchArrRecord.mockResolvedValue({ "949": { arrId: 1, monitored: false, tags: [] } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ matches: boolean }>(
      await call({ type: "MOVIE", mediaItemId: movie.id, serverIds: [server.id], rules: rule("arrMonitored", "equals", "false"), arrInstanceId: "r1" }),
      200,
    );

    expect(body.matches).toBe(true);
    // Only the item's own record is read, not the whole Radarr library.
    expect(mockFetchArrRecord).toHaveBeenCalledWith(user.id, "MOVIE", "949", "r1", { customFormatScores: false });
    expect(mockFetchArr).not.toHaveBeenCalled();
  });

  it("reads Seerr data for a series, and never for music", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 1 });
    await createTestExternalId(ep.id, "TVDB", "73739");
    const musicLib = await createTestLibrary(server.id, { type: "MUSIC" });
    const track = await createTestMediaItem(musicLib.id, { type: "MUSIC", title: "Airbag", parentTitle: "Radiohead" });
    mockFetchSeerr.mockResolvedValue({ "TVDB:73739": { requested: true, requestCount: 2, requestDate: null, requestedBy: [], approvalDate: null, declineDate: null } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ matches: boolean }>(
      await call({ type: "SERIES", mediaItemId: ep.id, serverIds: [server.id], rules: rule("seerrRequestCount", "greaterThan", 1) }),
      200,
    );

    expect(body.matches).toBe(true);
    expect(mockFetchSeerr).toHaveBeenCalledWith(user.id, "SERIES");

    // Seerr data is never fetched for music: a Seerr criterion there is refused.
    await expectJson(
      await call({ type: "MUSIC", mediaItemId: track.id, serverIds: [server.id], rules: rule("seerrRequested", "equals", "true") }),
      400,
    );
    expect(mockFetchSeerr).toHaveBeenCalledTimes(1);
  });

  it("aggregates a show's episodes: latest play, earliest add, newest air date, watched share", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const mk = (n: number, season: number, o: Record<string, unknown>) =>
      createTestMediaItem(lib.id, { type: "SERIES", title: `Ep ${n}`, parentTitle: "Lost", seasonNumber: season, episodeNumber: n, ...o });
    // The tested episode (e1, S1E1) holds none of the extremes, so each
    // aggregate below is only right if it is read across the whole show.
    const e1 = await mk(1, 1, { playCount: 1, lastPlayedAt: new Date("2024-11-01"), addedAt: new Date("2024-03-01") });
    await mk(2, 1, { playCount: 0, addedAt: new Date("2024-01-01") });
    await mk(1, 2, { playCount: 2, lastPlayedAt: new Date("2025-03-01"), addedAt: new Date("2024-06-01") });
    await mk(2, 2, { playCount: 0, lastPlayedAt: new Date("2024-12-01"), addedAt: new Date("2024-02-01") });
    const { getTestPrisma } = await import("../../setup/test-db");
    const prisma = getTestPrisma();
    await prisma.mediaItem.updateMany({ where: { libraryId: lib.id, seasonNumber: 2 }, data: { originallyAvailableAt: new Date("2008-05-01") } });
    await prisma.mediaItem.updateMany({ where: { libraryId: lib.id, seasonNumber: 1 }, data: { originallyAvailableAt: new Date("2004-09-22") } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ matches: boolean; actualValues: Record<string, unknown>; item: { title: string } }>(
      await call({
        type: "SERIES", seriesScope: true, mediaItemId: e1.id, serverIds: [server.id],
        rules: [{
          id: "g1", condition: "AND", groups: [],
          rules: [
            { id: "r1", field: "watchedEpisodePercentage", operator: "equals", value: 50, condition: "AND" },
            { id: "r2", field: "availableEpisodeCount", operator: "equals", value: 4, condition: "AND" },
            { id: "r3", field: "watchedEpisodeCount", operator: "equals", value: 2, condition: "AND" },
            // Latest play is S2E1's 2025-03-01 (e1's own is 2024-11-01).
            { id: "r4", field: "seriesLastPlayedAt", operator: "after", value: "2025-02-01", condition: "AND" },
            // Earliest add is S1E2's 2024-01-01 (e1's own is 2024-03-01).
            { id: "r5", field: "addedAt", operator: "before", value: "2024-02-01", condition: "AND" },
            // Newest air date is season 2's 2008-05-01 (e1's own is 2004-09-22).
            { id: "r6", field: "lastEpisodeAiredAt", operator: "after", value: "2008-01-01", condition: "AND" },
          ],
        }],
      }),
      200,
    );

    expect(body.matches).toBe(true);
    expect(body.item.title).toBe("Lost");
    expect(Object.keys(body.actualValues).sort()).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(body.actualValues).toMatchObject({ r2: "4", r3: "2" });
  });

  it("aggregates an artist's tracks in music scope", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const t1 = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Airbag", parentTitle: "Radiohead", playCount: 3 });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Lucky", parentTitle: "Radiohead", playCount: 4 });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Yellow", parentTitle: "Coldplay", playCount: 100 });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const ok = await expectJson<{ matches: boolean; item: { title: string } }>(
      await call({ type: "MUSIC", seriesScope: true, mediaItemId: t1.id, serverIds: [server.id], rules: rule("playCount", "equals", 7) }),
      200,
    );
    expect(ok.matches).toBe(true);
    expect(ok.item.title).toBe("Radiohead");
    expect(mockFetchSeerr).not.toHaveBeenCalled();
  });
});

describe("POST /api/lifecycle/rules/[id]/diff", () => {
  type Diff = { added: Array<{ id: string }>; removed: Array<{ id: string }>; retained: Array<{ id: string }> };
  const call = (id: string, body: unknown) =>
    callRouteWithParams(diff, { id }, { url: `/api/lifecycle/rules/${id}/diff`, method: "POST", body });

  it("reads Arr criteria from the rule set's stored instance when the editor sends none", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const unmonitored = await createTestMediaItem(lib.id, { title: "Heat" });
    await createTestExternalId(unmonitored.id, "TMDB", "949");
    const monitored = await createTestMediaItem(lib.id, { title: "Ronin" });
    await createTestExternalId(monitored.id, "TMDB", "8195");
    const ruleSet = await createTestRuleSet(user.id, { arrInstanceId: "radarr-4k", serverIds: [server.id] });
    await createTestRuleMatch(ruleSet.id, monitored.id, { title: "Ronin" });
    mockFetchArr.mockResolvedValue({
      "949": { arrId: 1, monitored: false, tags: [] },
      "8195": { arrId: 2, monitored: true, tags: [] },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<Diff>(
      await call(ruleSet.id, { type: "MOVIE", serverIds: [server.id], rules: rule("arrMonitored", "equals", "false") }),
      200,
    );

    expect(mockFetchArr).toHaveBeenCalledWith(user.id, "MOVIE", undefined, "radarr-4k", { customFormatScores: false });
    expect(body.added.map((a) => a.id)).toEqual([unmonitored.id]);
    expect(body.removed.map((r) => r.id)).toEqual([monitored.id]);
  });

  it("fetches Seerr data for a series diff", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 1 });
    await createTestExternalId(ep.id, "TVDB", "73739");
    const ruleSet = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: true, serverIds: [server.id] });
    mockFetchSeerr.mockResolvedValue({ "TVDB:73739": { requested: true, requestCount: 1, requestDate: null, requestedBy: [], approvalDate: null, declineDate: null } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<Diff>(
      await call(ruleSet.id, { type: "SERIES", seriesScope: true, serverIds: [server.id], rules: rule("seerrRequested", "equals", "true") }),
      200,
    );

    expect(mockFetchSeerr).toHaveBeenCalledWith(user.id, "SERIES");
    expect(body.added.map((a) => a.id)).toEqual([ep.id]);
  });

  it("diffs a music rule set in artist scope", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const played = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Yellow", parentTitle: "Coldplay", playCount: 5 });
    const unplayed = await createTestMediaItem(lib.id, { type: "MUSIC", title: "Airbag", parentTitle: "Radiohead", playCount: 0 });
    const ruleSet = await createTestRuleSet(user.id, { type: "MUSIC", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(ruleSet.id, played.id, { title: "Coldplay", memberIds: [played.id] });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<Diff>(
      await call(ruleSet.id, { type: "MUSIC", serverIds: [server.id], rules: rule("playCount", "equals", 0) }),
      200,
    );

    expect(body.added.map((a) => a.id)).toEqual([unplayed.id]);
    expect(body.removed.map((r) => r.id)).toEqual([played.id]);
    expect(mockFetchSeerr).not.toHaveBeenCalled();
  });
});
