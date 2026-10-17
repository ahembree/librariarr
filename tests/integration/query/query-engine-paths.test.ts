/**
 * executeQuery's less-travelled paths: the grouped path with full in-memory
 * evaluation (cross-system enrichment of flat items and episodes), combined
 * sorting and pagination, the Arr/Seerr fetch phases and their progress
 * events, the episode view with a series-aggregate rule, and the ungrouped
 * path's in-memory vs DB pagination.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import type { QueryDefinition, QueryGroup, QueryRule } from "@/lib/query/types";
import type { ProgressUpdate } from "@/lib/progress/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockFetchArr, mockFetchSeerr } = vi.hoisted(() => ({
  mockFetchArr: vi.fn(),
  mockFetchSeerr: vi.fn(),
}));

vi.mock("@/lib/query/fetch-arr-data", () => ({ fetchArrDataForQuery: mockFetchArr }));
vi.mock("@/lib/query/fetch-seerr-data", () => ({ fetchSeerrDataForQuery: mockFetchSeerr }));

import { executeQuery } from "@/lib/query/query-engine";
import { appCache } from "@/lib/cache/memory-cache";

function rule(field: string, operator: string, value: string | number = "", extra: Partial<QueryRule> = {}): QueryRule {
  return { id: `${field}-${operator}`, field, operator, value, condition: "AND", ...extra };
}

function group(rules: QueryRule[], extra: Partial<QueryGroup> = {}): QueryGroup {
  return { id: "g", condition: "AND", rules, groups: [], ...extra };
}

function def(overrides: Partial<QueryDefinition> = {}): QueryDefinition {
  return { mediaTypes: [], serverIds: [], groups: [], sortBy: "title", sortOrder: "asc", ...overrides };
}

const titles = (r: { items: Array<Record<string, unknown>> }) => r.items.map((i) => i.title as string);

async function seedMixed() {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { name: "Main" });
  const movies = await createTestLibrary(server.id, { type: "MOVIE", key: "m" });
  const shows = await createTestLibrary(server.id, { type: "SERIES", key: "s" });
  const music = await createTestLibrary(server.id, { type: "MUSIC", key: "mu" });
  const big = await createTestMediaItem(movies.id, { title: "Big Movie", fileSize: BigInt(15_000_000_000), year: 2001, ratingKey: "mv1" });
  const small = await createTestMediaItem(movies.id, { title: "Small Movie", fileSize: BigInt(2_000_000_000), year: 1990, ratingKey: "mv2" });
  const track = await createTestMediaItem(music.id, { type: "MUSIC", title: "A Track", parentTitle: "Artist", fileSize: BigInt(5_000_000), year: 2010, ratingKey: "t1" });
  const eps = [];
  for (let e = 1; e <= 3; e++) {
    eps.push(await createTestMediaItem(shows.id, {
      type: "SERIES", title: `Ep ${e}`, parentTitle: "The Show", seasonNumber: 1, episodeNumber: e,
      fileSize: BigInt(1_000_000_000), year: 2015, ratingKey: `e${e}`, playCount: e === 1 ? 1 : 0,
      lastPlayedAt: e === 1 ? new Date("2024-01-01T00:00:00Z") : undefined,
    }));
  }
  return { user, server, movies, shows, music, big, small, track, eps };
}

describe("executeQuery — paths", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns nothing for a user with no servers, or a selection of servers they do not have", async () => {
    const user = await createTestUser();
    const none = await executeQuery(def(), user.id, 1, 50);
    expect(none).toEqual({ items: [], pagination: { page: 1, limit: 50, hasMore: false, total: 0 } });

    const { user: other } = await seedMixed();
    const wrong = await executeQuery(def({ serverIds: ["not-a-server"] }), other.id, 2, 10);
    expect(wrong).toEqual({ items: [], pagination: { page: 2, limit: 10, hasMore: false, total: 0 } });
  });

  it("grouped path without rules combines flat items and one row per show, sorted by title", async () => {
    const { user } = await seedMixed();
    const res = await executeQuery(def(), user.id, 1, 0);
    expect(titles(res)).toEqual(["A Track", "Big Movie", "Small Movie", "The Show"]);
    const show = res.items.find((i) => i.title === "The Show")!;
    expect(show).toMatchObject({ type: "SERIES", matchedEpisodes: 3, seasonCount: 1, fileSize: "3000000000", playCount: 1 });
    expect(res.pagination).toEqual({ page: 1, limit: 0, hasMore: false, total: 4 });
  });

  it("grouped results sort fileSize numerically, nulls last, both directions", async () => {
    const { user, movies } = await seedMixed();
    await getTestPrisma().mediaItem.create({ data: { libraryId: movies.id, ratingKey: "nofs", title: "No Size", type: "MOVIE", fileSize: null } });
    const desc = await executeQuery(def({ sortBy: "fileSize", sortOrder: "desc" }), user.id, 1, 0);
    expect(titles(desc)).toEqual(["Big Movie", "The Show", "Small Movie", "A Track", "No Size"]);
    const asc = await executeQuery(def({ sortBy: "fileSize", sortOrder: "asc" }), user.id, 1, 0);
    expect(titles(asc)).toEqual(["A Track", "Small Movie", "The Show", "Big Movie", "No Size"]);
  });

  it("grouped results sort numbers and mixed values, and paginate", async () => {
    const { user } = await seedMixed();
    const byYear = await executeQuery(def({ sortBy: "year", sortOrder: "desc" }), user.id, 1, 2);
    expect(titles(byYear)).toEqual(["The Show", "A Track"]);
    expect(byYear.pagination).toEqual({ page: 1, limit: 2, hasMore: true, total: 4 });
    const page2 = await executeQuery(def({ sortBy: "year", sortOrder: "desc" }), user.id, 2, 2);
    expect(titles(page2)).toEqual(["Big Movie", "Small Movie"]);
    expect(page2.pagination.hasMore).toBe(false);

    // lastPlayedAt: only the show has one (an ISO string); everything else is null.
    const byPlayed = await executeQuery(def({ sortBy: "lastPlayedAt", sortOrder: "asc" }), user.id, 1, 0);
    expect(titles(byPlayed)[0]).toBe("The Show");
  });

  it("grouped path with a cross-system rule enriches flat items and episodes before evaluating", async () => {
    const { user, server, movies, shows } = await seedMixed();
    // A second server holding the same movie (same dedupKey) and the same show.
    const second = await createTestServer(user.id, { name: "Second", machineId: "m2" });
    const movies2 = await createTestLibrary(second.id, { type: "MOVIE", key: "m2" });
    const shows2 = await createTestLibrary(second.id, { type: "SERIES", key: "s2" });
    const prisma = getTestPrisma();
    const big = await prisma.mediaItem.findFirstOrThrow({ where: { libraryId: movies.id, title: "Big Movie" } });
    await prisma.mediaItem.update({ where: { id: big.id }, data: { dedupKey: "dk-big" } });
    await createTestMediaItem(movies2.id, { title: "Big Movie", ratingKey: "mv1b" }).then((m) =>
      prisma.mediaItem.update({ where: { id: m.id }, data: { dedupKey: "dk-big" } }));
    const ep1 = await prisma.mediaItem.findFirstOrThrow({ where: { libraryId: shows.id, episodeNumber: 1 } });
    await prisma.mediaItem.update({ where: { id: ep1.id }, data: { dedupKey: "dk-ep1" } });
    await createTestMediaItem(shows2.id, { type: "SERIES", title: "Ep 1", parentTitle: "The Show", seasonNumber: 1, episodeNumber: 1, ratingKey: "e1b" })
      .then((m) => prisma.mediaItem.update({ where: { id: m.id }, data: { dedupKey: "dk-ep1" } }));

    const progress: ProgressUpdate[] = [];
    const res = await executeQuery(
      def({ serverIds: [server.id], groups: [group([rule("serverCount", "greaterThan", "1")])] }),
      user.id, 1, 0, (u) => progress.push(u),
    );
    expect(titles(res)).toEqual(["Big Movie", "The Show"]);
    const show = res.items.find((i) => i.title === "The Show")!;
    expect(show.matchedEpisodes).toBe(1);
    const plan = progress.find((p) => p.type === "plan") as { phases: Array<{ key: string }> } | undefined;
    expect(plan?.phases.map((p) => p.key)).toEqual(["servers", "query", "evaluate", "finalize"]);
  });

  it("fetches Arr and Seerr data, reports their phases, and evaluates against them", async () => {
    const { user, big } = await seedMixed();
    const prisma = getTestPrisma();
    await prisma.mediaItemExternalId.create({ data: { mediaItemId: big.id, source: "TMDB", externalId: "603" } });
    mockFetchArr.mockImplementation(async (_u: string, _ids: unknown, _types: unknown, report?: (f: number) => void) => {
      report?.(0.5);
      return { MOVIE: { "603": { arrId: 1, tags: ["keep"] } } };
    });
    mockFetchSeerr.mockImplementation(async (_u: string, _types: unknown, report?: (f: number) => void) => {
      report?.(1);
      return { MOVIE: { "TMDB:603": { requested: true, requestCount: 1, requestDate: null, requestedBy: ["bob"], approvalDate: null, declineDate: null } } };
    });

    const progress: ProgressUpdate[] = [];
    const res = await executeQuery(
      def({
        mediaTypes: ["MOVIE"],
        arrServerIds: { radarr: "radarr-1" },
        groups: [group([rule("arrTag", "contains", "keep"), rule("seerrRequestedBy", "contains", "bob")])],
      }),
      user.id, 1, 50, (u) => progress.push(u),
    );
    expect(titles(res)).toEqual(["Big Movie"]);
    expect(mockFetchArr).toHaveBeenCalledWith(user.id, { radarr: "radarr-1" }, ["MOVIE"], expect.any(Function));
    expect(mockFetchSeerr).toHaveBeenCalledWith(user.id, ["MOVIE"], expect.any(Function));
    const plan = progress.find((p) => p.type === "plan") as { phases: Array<{ key: string }> };
    expect(plan.phases.map((p) => p.key)).toEqual(["servers", "arr", "seerr", "query", "evaluate", "finalize"]);
    expect(progress).toContainEqual({ type: "phase", key: "arr", fraction: 0.5 });
    expect(progress).toContainEqual({ type: "phase", key: "seerr", fraction: 1 });
  });

  it("Arr rules without a selected Arr server skip the fetch and match nothing", async () => {
    const { user } = await seedMixed();
    const res = await executeQuery(def({ mediaTypes: ["MOVIE"], groups: [group([rule("arrTag", "contains", "keep")])] }), user.id, 1, 50);
    expect(mockFetchArr).not.toHaveBeenCalled();
    expect(res.items).toEqual([]);
  });

  it("grouped series-aggregate path: no SERIES episodes, or none surviving, yields no shows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(movies.id, { title: "Only Movie" });
    const aggRule = group([rule("watchedEpisodeCount", "greaterThan", "0")]);
    expect(titles(await executeQuery(def({ mediaTypes: ["SERIES"], groups: [aggRule] }), user.id, 1, 0))).toEqual([]);

    const shows = await createTestLibrary(server.id, { type: "SERIES", key: "s" });
    await createTestMediaItem(shows.id, { type: "SERIES", title: "E1", parentTitle: "Unwatched", seasonNumber: 1, episodeNumber: 1 });
    expect(titles(await executeQuery(def({ mediaTypes: ["SERIES"], groups: [aggRule] }), user.id, 1, 0))).toEqual([]);
  });

  it("grouped path with in-memory rules and no surviving episodes returns only flat items", async () => {
    const { user } = await seedMixed();
    const res = await executeQuery(def({ groups: [group([rule("title", "matchesWildcard", "*Movie")])] }), user.id, 1, 0);
    expect(titles(res)).toEqual(["Big Movie", "Small Movie"]);
  });

  it("grouped path with plain rules matching no episode returns no show", async () => {
    const { user } = await seedMixed();
    const res = await executeQuery(def({ groups: [group([rule("title", "equals", "Big Movie")])] }), user.id, 1, 0);
    expect(titles(res)).toEqual(["Big Movie"]);
  });

  it("episode view + series-aggregate rule: returns surviving episodes and evaluated flat items, paginated", async () => {
    const { user, server, movies } = await seedMixed();
    const second = await createTestServer(user.id, { name: "Second", machineId: "m2" });
    const movies2 = await createTestLibrary(second.id, { type: "MOVIE", key: "m2" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.updateMany({ where: { libraryId: movies.id, title: "Small Movie" }, data: { dedupKey: "dk-s" } });
    const copy = await createTestMediaItem(movies2.id, { title: "Small Movie", ratingKey: "copy" });
    await prisma.mediaItem.update({ where: { id: copy.id }, data: { dedupKey: "dk-s" } });

    const groups = [
      group([rule("watchedEpisodeCount", "greaterThanOrEqual", "1")]),
      group([rule("serverCount", "greaterThan", "1")], { id: "g2", condition: "OR" }),
    ];
    const all = await executeQuery(
      def({ serverIds: [server.id], mediaTypes: ["MOVIE", "SERIES"], includeEpisodes: true, groups }),
      user.id, 1, 0,
    );
    expect(titles(all).sort()).toEqual(["Ep 1", "Ep 2", "Ep 3", "Small Movie"]);
    expect(all.pagination.total).toBe(4);

    const paged = await executeQuery(
      def({ serverIds: [server.id], mediaTypes: ["MOVIE", "SERIES"], includeEpisodes: true, groups }),
      user.id, 2, 3,
    );
    // Sorted by title: Ep 1, Ep 2, Ep 3 on page 1, the movie alone on page 2.
    expect(titles(paged)).toEqual(["Small Movie"]);
    expect(paged.pagination).toEqual({ page: 2, limit: 3, hasMore: false, total: 4 });

    const seriesOnly = await executeQuery(
      def({ mediaTypes: ["SERIES"], includeEpisodes: true, groups: [group([rule("watchedEpisodeCount", "equals", "99")])] }),
      user.id, 1, 0,
    );
    expect(seriesOnly.items).toEqual([]);
  });

  it("ungrouped path: DB pagination counts the whole match set, unknown sort columns fall back to title", async () => {
    const { user } = await seedMixed();
    const res = await executeQuery(def({ mediaTypes: ["MOVIE", "MUSIC"], sortBy: "bogus", sortOrder: "desc" }), user.id, 1, 2);
    expect(titles(res)).toEqual(["Small Movie", "Big Movie"]);
    expect(res.pagination).toEqual({ page: 1, limit: 2, hasMore: true, total: 3 });
    const bySize = await executeQuery(def({ mediaTypes: ["MOVIE"], sortBy: "fileSize", sortOrder: "asc" }), user.id, 1, 0);
    expect(titles(bySize)).toEqual(["Small Movie", "Big Movie"]);
    expect(bySize.pagination).toEqual({ page: 1, limit: 0, hasMore: false, total: 2 });
  });

  it("ungrouped path with in-memory evaluation paginates in memory and reports evaluation progress", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await getTestPrisma().mediaItem.createMany({
      data: Array.from({ length: 260 }, (_, i) => ({
        libraryId: lib.id, ratingKey: `bulk-${i}`, type: "MOVIE" as const,
        title: `Film ${String(i).padStart(3, "0")}`, year: i % 2 === 0 ? 2000 : 2001,
      })),
    });
    const progress: ProgressUpdate[] = [];
    const groups = [group([rule("title", "matchesWildcard", "Film *"), rule("serverCount", "equals", "1")])];
    const res = await executeQuery(def({ mediaTypes: ["MOVIE"], groups }), user.id, 2, 100, (u) => progress.push(u));
    expect(res.items).toHaveLength(100);
    expect(res.items[0].title).toBe("Film 100");
    expect(res.pagination).toEqual({ page: 2, limit: 100, hasMore: true, total: 260 });
    expect(progress).toContainEqual({ type: "phase", key: "evaluate", fraction: 250 / 260 });

    const all = await executeQuery(def({ mediaTypes: ["MOVIE"], groups }), user.id, 1, 0);
    expect(all.pagination).toEqual({ page: 1, limit: 0, hasMore: false, total: 260 });
  });

  it("grouped path reports evaluation progress for large flat sets", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await getTestPrisma().mediaItem.createMany({
      data: Array.from({ length: 251 }, (_, i) => ({ libraryId: lib.id, ratingKey: `g-${i}`, type: "MOVIE" as const, title: `G ${i}` })),
    });
    const progress: ProgressUpdate[] = [];
    const res = await executeQuery(def({ groups: [group([rule("title", "matchesWildcard", "G *")])] }), user.id, 1, 10, (u) => progress.push(u));
    expect(res.pagination.total).toBe(251);
    expect(progress).toContainEqual({ type: "phase", key: "evaluate", fraction: 250 / 251 });
  });

  it("stream-query groups nested in sub-groups force in-memory evaluation", async () => {
    const { user, big, small } = await seedMixed();
    const prisma = getTestPrisma();
    await prisma.mediaStream.create({ data: { mediaItemId: big.id, streamType: 2, codec: "truehd", extendedDisplayTitle: "TrueHD 7.1 Atmos", channels: 8 } });
    await prisma.mediaStream.create({ data: { mediaItemId: small.id, streamType: 2, codec: "aac", channels: 2 } });
    const sq: QueryGroup = group([rule("sqAudioProfile", "equals", "Dolby Atmos")], { id: "sq", streamQuery: { streamType: "audio" } });
    const res = await executeQuery(def({ mediaTypes: ["MOVIE"], groups: [group([], { groups: [sq] }), group([], { id: "off", enabled: false })] }), user.id, 1, 0);
    expect(titles(res)).toEqual(["Big Movie"]);
  });
});
