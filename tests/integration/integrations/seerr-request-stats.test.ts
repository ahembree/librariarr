import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { SEERR_REQUEST_PAGE_SIZE as P, SEERR_REQUEST_PAGE_OVERLAP as O } from "@/lib/seerr/request-walk";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestSeerrInstance,
  createTestExternalId,
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

const mockGetRequests = vi.fn();
const mockGetUsers = vi.fn();

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function () {
    return {
      getRequests: mockGetRequests,
      getUsers: mockGetUsers,
    };
  }),
}));

import { GET } from "@/app/api/seerr/request-stats/route";
import { invalidateSeerrCaches } from "@/lib/seerr/request-stats";

// Seerr is TMDB-based: every request's media carries a tmdbId, and a TV
// request's tvdbId may be null.
function makeRequest(
  id: number,
  type: "movie" | "tv",
  requestedBy: { id: number; username: string; plexUsername?: string | null },
  media: { tmdbId: number; tvdbId?: number | null }
) {
  return {
    id,
    type,
    status: 2,
    media: {
      id,
      tmdbId: media.tmdbId,
      tvdbId: media.tvdbId ?? null,
      status: 5,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    requestedBy: {
      id: requestedBy.id,
      email: `${requestedBy.username}@test.com`,
      username: requestedBy.username,
      plexUsername: requestedBy.plexUsername ?? null,
    },
    modifiedBy: null,
    is4k: false,
    serverId: 0,
    profileId: 0,
    rootFolder: "/",
  };
}

describe("GET /api/seerr/request-stats", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // The stats are cached for a minute under one key; start every test cold.
    invalidateSeerrCaches();
    mockGetUsers.mockResolvedValue({ pageInfo: { page: 1, pages: 1, results: 0 }, results: [] });
    mockGetRequests.mockResolvedValue({
      pageInfo: { page: 1, pages: 1, results: 0 },
      results: [],
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
    expect(mockGetRequests).not.toHaveBeenCalled();
  });

  it("returns configured=false when user has no Seerr instances", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson(await callRoute(GET), 200);
    expect(body).toEqual({
      configured: false,
      partial: false,
      users: [],
      totals: {
        requestCount: 0,
        movieCount: 0,
        seriesCount: 0,
        moviesWatched: 0,
        episodesWatched: 0,
        episodesAvailable: 0,
      },
    });
    expect(mockGetRequests).not.toHaveBeenCalled();
  });

  it("aggregates requests by user with content types", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 3 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        makeRequest(2, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 1396, tvdbId: 200 }),
        makeRequest(3, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 101 }),
      ],
    });

    const body = await expectJson(await callRoute(GET), 200);

    const nothingInLibrary = {
      avatar: null,
      moviesWatched: 0,
      seriesWithAnyEpisodeWatched: 0,
      episodesWatched: 0,
      episodesAvailable: 0,
      correlatable: true,
    };
    // Sorted by requestCount desc
    expect(body).toEqual({
      configured: true,
      partial: false,
      users: [
        {
          ...nothingInLibrary,
          userKey: "alice",
          seerrUsername: "alice",
          plexUsername: "alice",
          requestCount: 2,
          movieCount: 1,
          seriesCount: 1,
          distinctSeriesCount: 1,
        },
        {
          ...nothingInLibrary,
          userKey: "bob",
          seerrUsername: "bob",
          plexUsername: "bob",
          requestCount: 1,
          movieCount: 1,
          seriesCount: 0,
          distinctSeriesCount: 0,
        },
      ],
      totals: {
        requestCount: 3,
        movieCount: 2,
        seriesCount: 1,
        moviesWatched: 0,
        episodesWatched: 0,
        episodesAvailable: 0,
      },
    });
  });

  it("marks user as not correlatable when plexUsername is missing", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Requested Movie" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.update({ where: { id: movie.id }, data: { dedupKey: "movie-dedup-carol" } });
    await createTestExternalId(movie.id, "TMDB", "100");
    // A media-server account that happens to share the local Seerr username is
    // NOT the requester: with no plexUsername/jellyfinUsername there is no
    // account to correlate, so this play must not be credited.
    await prisma.watchHistory.create({
      data: {
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: "carol",
        watchedAt: new Date("2024-06-01T20:00:00Z"),
      },
    });
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [makeRequest(1, "movie", { id: 1, username: "carol" }, { tmdbId: 100 })],
    });

    const body = await expectJson<{
      users: { seerrUsername: string; plexUsername: string | null; correlatable: boolean; moviesWatched: number }[];
    }>(await callRoute(GET), 200);

    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      seerrUsername: "carol",
      plexUsername: null,
      correlatable: false,
      moviesWatched: 0,
    });
  });

  it("correlates movie requests with watch history", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Test Movie" });
    // Set dedupKey on the movie (createTestMediaItem doesn't set it)
    const prisma = getTestPrisma();
    await prisma.mediaItem.update({
      where: { id: movie.id },
      data: { dedupKey: "movie-dedup-key-1" },
    });
    await createTestExternalId(movie.id, "TMDB", "100");
    await prisma.watchHistory.create({
      data: {
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2024-06-01T20:00:00Z"),
      },
    });

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 2 },
      results: [
        // alice watched this one
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        // alice requested but no media item exists / didn't watch
        makeRequest(2, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 999 }),
      ],
    });

    const body = await expectJson<{
      users: {
        seerrUsername: string;
        movieCount: number;
        moviesWatched: number;
        correlatable: boolean;
      }[];
    }>(await callRoute(GET), 200);

    expect(body.users[0].movieCount).toBe(2);
    expect(body.users[0].moviesWatched).toBe(1);
    expect(body.users[0].correlatable).toBe(true);
  });

  it("does not count an abandoned Tracearr play as a watched movie", async () => {
    // This stat answers "did the requester actually watch what they asked for",
    // which is the one question a partial play answers in the negative: a
    // Tracearr row with `watched = false` is someone starting a film and giving
    // up. Counting it reports the request as satisfied when it demonstrably was
    // not — the exact inversion of the stat's purpose.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const prisma = getTestPrisma();

    const finished = await createTestMediaItem(library.id, { type: "MOVIE", title: "Finished" });
    const abandoned = await createTestMediaItem(library.id, { type: "MOVIE", title: "Abandoned" });
    await prisma.mediaItem.update({ where: { id: finished.id }, data: { dedupKey: "dedup-finished" } });
    await prisma.mediaItem.update({ where: { id: abandoned.id }, data: { dedupKey: "dedup-abandoned" } });
    await createTestExternalId(finished.id, "TMDB", "100");
    await createTestExternalId(abandoned.id, "TMDB", "101");

    await prisma.watchHistory.createMany({
      data: [
        // NATIVE: `watched` is null and always counts — this half pins the
        // pre-Tracearr behaviour so the filter can't silently drop every row.
        {
          mediaItemId: finished.id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date("2024-06-01T20:00:00Z"),
        },
        {
          mediaItemId: abandoned.id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date("2024-06-02T20:00:00Z"),
          source: "TRACEARR",
          sourceEventId: "3f6c2a8e-5b1d-4c7a-9e0f-1a2b3c4d5e6f",
          watched: false,
          percentComplete: 9,
          state: "stopped",
        },
      ],
    });

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 2 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        makeRequest(2, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 101 }),
      ],
    });

    const body = await expectJson<{
      users: { movieCount: number; moviesWatched: number }[];
      totals: { moviesWatched: number };
    }>(await callRoute(GET), 200);

    expect(body.users[0].movieCount).toBe(2);
    expect(body.users[0].moviesWatched).toBe(1);
    expect(body.totals.moviesWatched).toBe(1);
  });

  it("does not count an abandoned Tracearr play as a watched episode", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();

    const episodes = await Promise.all(
      [1, 2, 3].map((n) =>
        createTestMediaItem(library.id, {
          type: "SERIES",
          title: `Ep${n}`,
          parentTitle: "Half Finished Show",
          // The sync keys a show with a TVDB id by it (see series-key.ts).
          seriesKey: "tvdb:200",
          seasonNumber: 1,
          episodeNumber: n,
        })
      )
    );
    for (let i = 0; i < episodes.length; i++) {
      await prisma.mediaItem.update({
        where: { id: episodes[i].id },
        data: { dedupKey: `abandoned-ep-${i + 1}` },
      });
      await createTestExternalId(episodes[i].id, "TVDB", "200");
    }

    await prisma.watchHistory.createMany({
      data: [
        // Ep1 finished natively; Ep2 abandoned nine minutes in; Ep3 never started.
        {
          mediaItemId: episodes[0].id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date("2024-06-01T20:00:00Z"),
        },
        {
          mediaItemId: episodes[1].id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date("2024-06-02T20:00:00Z"),
          source: "TRACEARR",
          sourceEventId: "8d1e4b2c-7f3a-4e6b-a5c9-0b1c2d3e4f5a",
          watched: false,
          percentComplete: 15,
          state: "stopped",
        },
      ],
    });

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 1396, tvdbId: 200 }),
      ],
    });

    const body = await expectJson<{
      users: {
        seriesWithAnyEpisodeWatched: number;
        episodesWatched: number;
        episodesAvailable: number;
      }[];
    }>(await callRoute(GET), 200);

    // The completed native play still counts, so the series is not written off
    // entirely — but the abandoned episode is not credited alongside it.
    expect(body.users[0].episodesWatched).toBe(1);
    expect(body.users[0].seriesWithAnyEpisodeWatched).toBe(1);
    expect(body.users[0].episodesAvailable).toBe(3);
  });

  it("correlates series episode requests with watch history", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();

    // Create 3 episodes of one series, all sharing TVDB id "200"
    const episodes = await Promise.all([
      createTestMediaItem(library.id, {
        type: "SERIES",
        title: "Ep1",
        parentTitle: "Test Series",
        seriesKey: "tvdb:200",
        seasonNumber: 1,
        episodeNumber: 1,
      }),
      createTestMediaItem(library.id, {
        type: "SERIES",
        title: "Ep2",
        parentTitle: "Test Series",
        seriesKey: "tvdb:200",
        seasonNumber: 1,
        episodeNumber: 2,
      }),
      createTestMediaItem(library.id, {
        type: "SERIES",
        title: "Ep3",
        parentTitle: "Test Series",
        seriesKey: "tvdb:200",
        seasonNumber: 1,
        episodeNumber: 3,
      }),
    ]);
    for (let i = 0; i < episodes.length; i++) {
      await prisma.mediaItem.update({
        where: { id: episodes[i].id },
        data: { dedupKey: `episode-dedup-${i + 1}` },
      });
      await createTestExternalId(episodes[i].id, "TVDB", "200");
    }
    // alice watched episodes 1 and 2
    await prisma.watchHistory.createMany({
      data: [
        {
          mediaItemId: episodes[0].id,
          mediaServerId: server.id,
          serverUsername: "alice",
        },
        {
          mediaItemId: episodes[1].id,
          mediaServerId: server.id,
          serverUsername: "alice",
        },
      ],
    });

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 1396, tvdbId: 200 }),
      ],
    });

    const body = await expectJson<{
      users: {
        seerrUsername: string;
        seriesCount: number;
        seriesWithAnyEpisodeWatched: number;
        episodesWatched: number;
        episodesAvailable: number;
      }[];
    }>(await callRoute(GET), 200);

    expect(body.users[0].seriesCount).toBe(1);
    expect(body.users[0].seriesWithAnyEpisodeWatched).toBe(1);
    expect(body.users[0].episodesWatched).toBe(2);
    expect(body.users[0].episodesAvailable).toBe(3);
  });

  it("paginates through multiple pages of requests", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    // Newest-first listing of a page and one more request. Pages overlap by
    // O rows (skip 0, then P - O) and the overlap is deduped by request id.
    const all = [
      ...Array.from({ length: P }, (_, i) =>
        makeRequest(5_000 - i, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 10_000 + i })
      ),
      makeRequest(1, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 5000, tvdbId: 999 }),
    ];
    mockGetRequests.mockImplementation(({ take, skip }: { take: number; skip: number }) =>
      Promise.resolve({
        pageInfo: { page: Math.ceil(skip / take) + 1, pages: Math.ceil(all.length / take), results: all.length },
        results: all.slice(skip, skip + take),
      })
    );

    const body = await expectJson<{ users: { requestCount: number; movieCount: number; seriesCount: number }[] }>(
      await callRoute(GET),
      200
    );

    expect(mockGetRequests).toHaveBeenCalledTimes(2);
    expect(mockGetRequests.mock.calls.map(([params]) => params)).toEqual([
      { take: P, skip: 0 },
      { take: P, skip: P - O },
    ]);
    expect(body.users[0].requestCount).toBe(P + 1);
    expect(body.users[0].movieCount).toBe(P);
    expect(body.users[0].seriesCount).toBe(1);
  });
});
