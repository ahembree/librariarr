import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockWalk, mockAppCache, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    seerrInstance: { findMany: vi.fn() },
    mediaServer: { findMany: vi.fn() },
    mediaItem: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
  mockWalk: vi.fn(),
  mockAppCache: {
    getOrSet: vi.fn(<T>(_k: string, compute: () => Promise<T>) => compute()),
    invalidate: vi.fn(),
    invalidatePrefix: vi.fn(),
  },
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/seerr/request-walk", () => ({ walkSeerrRequests: mockWalk }));
vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: function (this: { url: string }, url: string) {
    this.url = url;
  },
}));
vi.mock("@/lib/cache/memory-cache", () => ({ appCache: mockAppCache }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));

import {
  completedPlaysByDedupKey,
  getSeerrRequestStats,
  invalidateSeerrCaches,
  USER_REQUESTS_CACHE_PREFIX,
} from "@/lib/seerr/request-stats";

type Req = Record<string, unknown>;

/** Serve each instance (keyed by url) its own request list, or a failure. */
function serveWalks(byUrl: Record<string, Req[] | Error | string>) {
  mockWalk.mockImplementation(async (client: { url: string }, _opts: unknown, onReq: (r: Req) => void) => {
    const v = byUrl[client.url];
    if (v instanceof Error || typeof v === "string") throw v;
    for (const r of v ?? []) onReq(r);
  });
}

function instances(...urls: string[]) {
  mockPrisma.seerrInstance.findMany.mockResolvedValue(
    urls.map((url, i) => ({ id: `s${i}`, url, apiKey: "k", name: `Seerr${i}` })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.mediaServer.findMany.mockResolvedValue([{ id: "srv1" }]);
  mockPrisma.mediaItem.findMany.mockResolvedValue([]);
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
});

describe("completedPlaysByDedupKey", () => {
  it("sends the keys and accounts as one array parameter each, with the completed-play predicate", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ serverUsername: "p", dedupKey: "k1" }]);
    const rows = await completedPlaysByDedupKey({ dedupKeys: ["k1", "k2"], usernames: ["p"], type: "SERIES", episodesOnly: true });
    expect(rows).toEqual([{ serverUsername: "p", dedupKey: "k1" }]);
    const [sql, keys, users, type] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    // A library-long key list stays one parameter, never one per key.
    expect(sql).toContain(`mi."dedupKey" = ANY($1::text[])`);
    expect(sql).toContain(`wh."serverUsername" = ANY($2::text[])`);
    expect(sql).toContain(`wh."watched" IS DISTINCT FROM false`);
    expect(sql).toContain(`mi."type" = $3::"LibraryType"`);
    expect(sql).toContain(`mi."episodeNumber" IS NOT NULL`);
    expect(sql).toContain("SELECT DISTINCT");
    expect(keys).toEqual(["k1", "k2"]);
    expect(users).toEqual(["p"]);
    expect(type).toBe("SERIES");
  });

  it("filters on neither type nor episode number unless asked", async () => {
    await completedPlaysByDedupKey({ dedupKeys: ["k1"], usernames: ["p"] });
    const call = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[0]).not.toContain(`mi."type"`);
    expect(call[0]).not.toContain(`"episodeNumber"`);
  });

  it("asks nothing for no keys or no accounts", async () => {
    await expect(completedPlaysByDedupKey({ dedupKeys: [], usernames: ["p"] })).resolves.toEqual([]);
    await expect(completedPlaysByDedupKey({ dedupKeys: ["k"], usernames: [] })).resolves.toEqual([]);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("invalidateSeerrCaches", () => {
  it("drops the stats, drill-down and health caches", () => {
    invalidateSeerrCaches();
    expect(mockAppCache.invalidate).toHaveBeenCalledWith("seerr-request-stats");
    expect(mockAppCache.invalidatePrefix).toHaveBeenCalledWith(USER_REQUESTS_CACHE_PREFIX);
    // The health route's one key (single admin), not a per-user prefix.
    expect(mockAppCache.invalidate).toHaveBeenCalledWith("integrations:health");
    expect(mockAppCache.invalidatePrefix).not.toHaveBeenCalledWith("integrations:health:");
  });
});

describe("getSeerrRequestStats (branches)", () => {
  it("logs a non-Error walk failure as a string and marks the result partial", async () => {
    instances("a");
    serveWalks({ a: "socket hang up" });
    const r = await getSeerrRequestStats("u");
    expect(r).toMatchObject({ configured: true, partial: true, users: [] });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Seerr",
      "Failed to fetch requests from Seerr0 for stats",
      { error: "socket hang up" },
    );
  });

  it("names a requester by the first identity it has, and adopts later details", async () => {
    instances("a", "b");
    serveWalks({
      a: [
        // Keyed by email only: no username, no media account.
        { type: "movie", media: { tmdbId: 1 }, requestedBy: { email: "e@x" } },
        // Keyed by plexUsername, with no username — named by it.
        { type: "movie", media: {}, requestedBy: { plexUsername: "pp" } },
        // Jellyfin user without a username: keyed by email, named by the Jellyfin name.
        { type: "movie", media: { tmdbId: 2 }, requestedBy: { jellyfinUsername: "jf", email: "j@x" } },
      ],
      b: [
        // Same email key as the first: adopts an avatar and a media account name.
        { type: "tv", media: { tvdbId: 5 }, requestedBy: { email: "e@x", avatar: "/a.png", jellyfinUsername: "ejf" } },
        // Unsupported type counts as a request but neither movie nor TV.
        { type: "music", media: {}, requestedBy: { email: "e@x" } },
        // No usable identity at all: skipped.
        { type: "movie", media: {}, requestedBy: {} },
      ],
    });

    const r = await getSeerrRequestStats("u");
    const by = Object.fromEntries(r.users.map((u) => [u.userKey, u]));
    expect(by["e@x"]).toMatchObject({
      seerrUsername: "e@x",
      plexUsername: null,
      avatar: "/a.png",
      requestCount: 3,
      movieCount: 1,
      seriesCount: 1,
      distinctSeriesCount: 1,
      correlatable: true,
    });
    expect(by["pp"]).toMatchObject({ seerrUsername: "pp", plexUsername: "pp", requestCount: 1, correlatable: true });
    expect(by["j@x"]).toMatchObject({ seerrUsername: "jf", correlatable: true });
    expect(r.totals.requestCount).toBe(5);
  });

  it("ignores a TV request with no ids and keys a TVDB-only show by TVDB", async () => {
    instances("a");
    serveWalks({
      a: [
        { type: "tv", media: {}, requestedBy: { username: "u1" } },
        { type: "tv", media: { tvdbId: 9 }, requestedBy: { username: "u1" } },
        { type: "tv", media: { tmdbId: 9 }, requestedBy: { username: "u1" } },
      ],
    });
    const r = await getSeerrRequestStats("u");
    // Not correlatable (no media account), so no watch queries.
    expect(r.users[0]).toMatchObject({ seriesCount: 3, distinctSeriesCount: 2, correlatable: false });
    expect(mockPrisma.mediaServer.findMany).not.toHaveBeenCalled();
  });

  it("orders users with equal request counts by name", async () => {
    instances("a");
    serveWalks({
      a: [
        { type: "movie", media: {}, requestedBy: { username: "zed" } },
        { type: "movie", media: {}, requestedBy: { username: "amy" } },
      ],
    });
    const r = await getSeerrRequestStats("u");
    expect(r.users.map((u) => u.seerrUsername)).toEqual(["amy", "zed"]);
  });

  it("returns empty watch figures when there are no enabled media servers", async () => {
    instances("a");
    serveWalks({ a: [{ type: "movie", media: { tmdbId: 1 }, requestedBy: { plexUsername: "p" } }] });
    mockPrisma.mediaServer.findMany.mockResolvedValue([]);
    const r = await getSeerrRequestStats("u");
    expect(r.users[0]).toMatchObject({ moviesWatched: 0, episodesAvailable: 0 });
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it("skips movie rows it cannot key and plays it cannot attribute", async () => {
    instances("a");
    serveWalks({
      a: [
        { type: "movie", media: { tmdbId: 1 }, requestedBy: { plexUsername: "p" } },
        { type: "movie", media: { tmdbId: 2 }, requestedBy: { plexUsername: "p" } },
        { type: "movie", media: { tmdbId: 3 }, requestedBy: { plexUsername: "q" } },
      ],
    });
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { dedupKey: "m1", externalIds: [{ externalId: "1" }] },
      { dedupKey: "m1b", externalIds: [{ externalId: "1" }] }, // second copy of tmdb 1
      { dedupKey: null, externalIds: [{ externalId: "2" }] },
      { dedupKey: "nox", externalIds: [] },
      { dedupKey: "nan", externalIds: [{ externalId: "abc" }] },
      { dedupKey: "m3", externalIds: [{ externalId: "3" }] },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { serverUsername: "p", dedupKey: "m1" },
      { serverUsername: "p", dedupKey: "m1b" },
      { serverUsername: "p", dedupKey: null },
      { serverUsername: "p", dedupKey: "unknown" },
      { serverUsername: "q", dedupKey: "m3" },
    ]);

    const r = await getSeerrRequestStats("u");
    const by = Object.fromEntries(r.users.map((u) => [u.userKey, u]));
    expect(by.p.moviesWatched).toBe(1);
    expect(by.q.moviesWatched).toBe(1);
    expect(r.totals.moviesWatched).toBe(2);
    // Only the dedupKeys that resolved to a TMDB id were asked about.
    const keys = mockPrisma.$queryRawUnsafe.mock.calls[0][1] as string[];
    expect([...keys].sort()).toEqual(["m1", "m1b", "m3"]);
  });

  it("asks no watch history when no requested movie is in the library", async () => {
    instances("a");
    serveWalks({ a: [{ type: "movie", media: { tmdbId: 1 }, requestedBy: { plexUsername: "p" } }] });
    const r = await getSeerrRequestStats("u");
    expect(r.users[0].moviesWatched).toBe(0);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("does not query episode plays for a show whose episodes carry no dedupKey", async () => {
    instances("a");
    serveWalks({ a: [{ type: "tv", media: { tvdbId: 7 }, requestedBy: { plexUsername: "p" } }] });
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "e1", dedupKey: null, parentTitle: "Show", seriesKey: "tvdb:7", externalIds: [{ source: "TVDB", externalId: "7" }] },
      { id: "e2", dedupKey: null, parentTitle: "Show", seriesKey: "tvdb:7", externalIds: [{ source: "TVDB", externalId: "7" }] },
    ]);
    const r = await getSeerrRequestStats("u");
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    // With no dedupKeys, every episode row counts.
    expect(r.users[0]).toMatchObject({ episodesAvailable: 2, episodesWatched: 0, seriesWithAnyEpisodeWatched: 0 });
  });

  it("attributes episode plays per user and per show, skipping unattributable rows", async () => {
    instances("a");
    serveWalks({
      a: [
        { type: "tv", media: { tvdbId: 7 }, requestedBy: { plexUsername: "p" } },
        { type: "tv", media: { tvdbId: 8 }, requestedBy: { plexUsername: "p" } },
        { type: "tv", media: { tvdbId: 7 }, requestedBy: { plexUsername: "q" } },
        // Requested show not in the library.
        { type: "tv", media: { tvdbId: 99 }, requestedBy: { plexUsername: "q" } },
      ],
    });
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "a1", dedupKey: "a1", parentTitle: "A", seriesKey: "tvdb:7", externalIds: [{ source: "TVDB", externalId: "7" }] },
      { id: "a2", dedupKey: "a2", parentTitle: "A", seriesKey: "tvdb:7", externalIds: [{ source: "TVDB", externalId: "7" }] },
      { id: "b1", dedupKey: "b1", parentTitle: "B", seriesKey: "tvdb:8", externalIds: [{ source: "TVDB", externalId: "8" }] },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { serverUsername: "p", dedupKey: "a1" },
      { serverUsername: "p", dedupKey: "a1" }, // replay: one episode
      { serverUsername: "p", dedupKey: "b1" },
      { serverUsername: "p", dedupKey: null },
      { serverUsername: "p", dedupKey: "zz" },
      { serverUsername: "q", dedupKey: "a2" },
    ]);

    const r = await getSeerrRequestStats("u");
    const by = Object.fromEntries(r.users.map((u) => [u.userKey, u]));
    expect(by.p).toMatchObject({ episodesAvailable: 3, episodesWatched: 2, seriesWithAnyEpisodeWatched: 2 });
    expect(by.q).toMatchObject({ episodesAvailable: 2, episodesWatched: 1, seriesWithAnyEpisodeWatched: 1, distinctSeriesCount: 2 });
    expect(r.totals).toMatchObject({ episodesWatched: 3, episodesAvailable: 5 });
  });
});
