import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestSeerrInstance,
  createTestExternalId,
} from "../../setup/test-helpers";

const m = vi.hoisted(() => ({
  requestsByUrl: new Map<string, unknown[] | Error>(),
  getMovie: vi.fn(),
  getTvShow: vi.fn(),
  getRequestsCalls: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function (url: string) {
    return {
      getRequests: async () => {
        m.getRequestsCalls(url);
        const value = m.requestsByUrl.get(url) ?? [];
        if (value instanceof Error) throw value;
        return { pageInfo: { page: 1, pages: 1, results: value.length }, results: value };
      },
      getMovie: m.getMovie,
      getTvShow: m.getTvShow,
    };
  }),
}));

import { GET } from "@/app/api/seerr/users/[userKey]/requests/route";
import { appCache } from "@/lib/cache/memory-cache";

type By = { username: string; plexUsername?: string | null; avatar?: string | null; email?: string };
function request(
  id: number,
  type: "movie" | "tv",
  by: By,
  media: { tmdbId?: number; tvdbId?: number | null; status?: number; status4k?: number } | null,
  extra: { createdAt?: string; is4k?: boolean } = {},
) {
  return {
    id,
    type,
    status: 2,
    is4k: extra.is4k ?? false,
    media: media
      ? { id, tmdbId: media.tmdbId ?? 0, tvdbId: media.tvdbId ?? null, status: media.status ?? 5, status4k: media.status4k }
      : undefined,
    createdAt: extra.createdAt ?? `2024-01-${String(id).padStart(2, "0")}T00:00:00Z`,
    updatedAt: "2024-01-01T00:00:00Z",
    requestedBy: { id: 1, email: by.email ?? `${by.username}@x.test`, ...by },
  };
}

type Resolved = {
  seerrId: number;
  type: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  mediaStatus: number;
  tvdbId: number | null;
  seriesKey: string | null;
  watch: { correlatable: boolean; watched: boolean; episodesWatched: number; episodesAvailable: number };
};
type Body = {
  user: { seerrUsername: string; plexUsername: string | null; avatar: string | null } | null;
  partial: boolean;
  requests: Resolved[];
};

describe("GET /api/seerr/users/[userKey]/requests — partial walks, fallbacks, series watch", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    vi.clearAllMocks();
    m.requestsByUrl.clear();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function get(userKey = "alice") {
    return expectJson<Body>(await callRouteWithParams(GET, { userKey }));
  }

  it("reports a partial answer when an instance cannot be read, and does not cache it", async () => {
    await createTestSeerrInstance(userId, { name: "Good", url: "http://good:5055" });
    await createTestSeerrInstance(userId, { name: "Bad", url: "http://bad:5055" });
    m.requestsByUrl.set("http://good:5055", [request(1, "movie", { username: "bob" }, { tmdbId: 1 })]);
    m.requestsByUrl.set("http://bad:5055", new Error("ECONNREFUSED"));

    const first = await get();
    expect(first).toEqual({ user: null, partial: true, requests: [] });
    expect(m.warn).toHaveBeenCalledWith(
      "Seerr",
      expect.stringContaining("Bad"),
      { error: "ECONNREFUSED" },
    );

    await get();
    // Walked again: the partial answer was not cached.
    expect(m.getRequestsCalls.mock.calls.filter(([u]) => u === "http://good:5055")).toHaveLength(2);
  });

  it("caches a complete answer", async () => {
    await createTestSeerrInstance(userId, { url: "http://good:5055" });
    m.requestsByUrl.set("http://good:5055", []);
    expect((await get()).partial).toBe(false);
    await get();
    expect(m.getRequestsCalls).toHaveBeenCalledTimes(1);
  });

  it("adopts the Plex name and avatar a later request supplies", async () => {
    await createTestSeerrInstance(userId, { url: "http://s:5055" });
    m.getMovie.mockRejectedValue(new Error("nope"));
    m.requestsByUrl.set("http://s:5055", [
      request(1, "movie", { username: "alice", plexUsername: null, avatar: null }, { tmdbId: 11 }),
      request(2, "movie", { username: "Alice B", plexUsername: "alice", avatar: "/a.png" }, { tmdbId: 12 }),
    ]);
    const body = await get();
    expect(body.user).toEqual({ seerrUsername: "alice", plexUsername: "alice", avatar: "/a.png" });
    expect(body.requests.every((r) => r.watch.correlatable)).toBe(true);
  });

  it("labels requests Seerr cannot describe with placeholders", async () => {
    await createTestSeerrInstance(userId, { url: "http://s:5055" });
    m.getMovie.mockRejectedValue(new Error("down"));
    m.getTvShow.mockRejectedValue(new Error("down"));
    m.requestsByUrl.set("http://s:5055", [
      request(1, "movie", { username: "alice" }, { tmdbId: 101 }),
      request(2, "tv", { username: "alice" }, { tmdbId: 202, tvdbId: null }),
      request(3, "tv", { username: "alice" }, { tmdbId: 0, tvdbId: 0 }),
      request(4, "tv", { username: "alice" }, null),
      request(5, "movie", { username: "alice" }, null),
    ]);
    const body = await get();
    const byId = new Map(body.requests.map((r) => [r.seerrId, r]));
    expect(byId.get(1)!.title).toBe("Movie (TMDB 101)");
    expect(byId.get(1)!.posterUrl).toBeNull();
    expect(byId.get(2)!.title).toBe("Series (TMDB 202)");
    expect(byId.get(3)!.title).toBe("Series");
    expect(byId.get(3)!.tvdbId).toBeNull();
    expect(byId.get(4)!.title).toBe("Series");
    // No media at all: status falls back to 1 (unknown).
    expect(byId.get(4)!.mediaStatus).toBe(1);
    expect(byId.get(5)!.title).toBe("Movie (TMDB 0)");
    // Newest first.
    expect(body.requests.map((r) => r.seerrId)).toEqual([5, 4, 3, 2, 1]);
    // Only the two requests with a TMDB id were looked up.
    expect(m.getMovie).toHaveBeenCalledTimes(1);
    expect(m.getTvShow).toHaveBeenCalledTimes(1);
  });

  it("uses Seerr's absolute poster URL as-is and drops an unparseable year", async () => {
    await createTestSeerrInstance(userId, { url: "http://s:5055" });
    m.getMovie.mockResolvedValue({ title: null, posterPath: "https://cdn.example/p.jpg", releaseDate: "TBA!" });
    m.getTvShow.mockResolvedValue({ name: "Show X", posterPath: null, firstAirDate: null });
    m.requestsByUrl.set("http://s:5055", [
      request(1, "movie", { username: "alice" }, { tmdbId: 7 }),
      request(2, "tv", { username: "alice" }, { tmdbId: 8, tvdbId: 99 }),
    ]);
    const body = await get();
    const movie = body.requests.find((r) => r.seerrId === 1)!;
    expect(movie.posterUrl).toBe("https://cdn.example/p.jpg");
    expect(movie.year).toBeNull();
    expect(movie.title).toBe("Movie (TMDB 7)");
    const show = body.requests.find((r) => r.seerrId === 2)!;
    expect(show.title).toBe("Show X");
    expect(show.year).toBeNull();
    expect(show.posterUrl).toBeNull();
    expect(show.tvdbId).toBe(99);
  });

  it("reports a 4K request by the 4K copy's status", async () => {
    await createTestSeerrInstance(userId, { url: "http://s:5055" });
    m.getMovie.mockResolvedValue({ title: "Film", posterPath: "/p.jpg", releaseDate: "2020-05-05" });
    m.requestsByUrl.set("http://s:5055", [
      request(1, "movie", { username: "alice" }, { tmdbId: 7, status: 5, status4k: 3 }, { is4k: true }),
      request(2, "movie", { username: "alice" }, { tmdbId: 8, status: 4 }, { is4k: true }),
    ]);
    const body = await get();
    const byId = new Map(body.requests.map((r) => [r.seerrId, r]));
    expect(byId.get(1)!.mediaStatus).toBe(3);
    // No 4K status recorded: the plain status stands in.
    expect(byId.get(2)!.mediaStatus).toBe(4);
    expect(byId.get(1)!.year).toBe(2020);
    expect(byId.get(1)!.posterUrl).toBe("https://image.tmdb.org/t/p/w154/p.jpg");
  });

  it("counts the episodes of a requested show the requester watched", async () => {
    const server = await createTestServer(userId);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    const eps = [];
    for (let e = 1; e <= 3; e++) {
      const ep = await createTestMediaItem(lib.id, {
        type: "SERIES", title: `E${e}`, parentTitle: "Lost", seasonNumber: 1, episodeNumber: e,
        seriesKey: "tvdb:73739",
      });
      await prisma.mediaItem.update({ where: { id: ep.id }, data: { dedupKey: `lost-${e}` } });
      await createTestExternalId(ep.id, "TVDB", "73739");
      eps.push(ep);
    }
    // alice watched episodes 1 and 2 (twice for 1); bob watched 3; one play of 3
    // by alice was abandoned and does not count.
    for (const [ep, who, watched] of [
      [eps[0], "alice", null],
      [eps[0], "alice", null],
      [eps[1], "alice", true],
      [eps[2], "bob", null],
      [eps[2], "alice", false],
    ] as const) {
      await prisma.watchHistory.create({
        data: { mediaItemId: ep.id, mediaServerId: server.id, serverUsername: who, watched },
      });
    }
    await createTestSeerrInstance(userId, { url: "http://s:5055" });
    m.requestsByUrl.set("http://s:5055", [
      request(1, "tv", { username: "alice", plexUsername: "alice" }, { tmdbId: 4607, tvdbId: 73739 }),
    ]);

    const [show] = (await get()).requests;
    expect(show.title).toBe("Lost");
    expect(show.seriesKey).toBe("tvdb:73739");
    expect(show.watch).toEqual({ correlatable: true, watched: true, episodesWatched: 2, episodesAvailable: 3 });
    expect(m.getTvShow).not.toHaveBeenCalled();
  });

  it("reports an unwatched requested show with zero watched episodes", async () => {
    const server = await createTestServer(userId);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Dark", seasonNumber: 1, episodeNumber: 1, seriesKey: "tvdb:1",
    });
    await getTestPrisma().mediaItem.update({ where: { id: ep.id }, data: { dedupKey: "dark-1" } });
    await createTestExternalId(ep.id, "TVDB", "1");
    await createTestSeerrInstance(userId, { url: "http://s:5055" });
    m.requestsByUrl.set("http://s:5055", [
      request(1, "tv", { username: "alice", plexUsername: "alice" }, { tmdbId: 5, tvdbId: 1 }),
    ]);
    const [show] = (await get()).requests;
    expect(show.watch).toEqual({ correlatable: true, watched: false, episodesWatched: 0, episodesAvailable: 1 });
  });
});
