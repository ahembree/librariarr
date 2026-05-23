import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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

vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: vi.fn().mockImplementation(function () {
    return {
      getRequests: mockGetRequests,
      getUsers: mockGetUsers,
    };
  }),
}));

import { GET } from "@/app/api/seerr/request-stats/route";
import { invalidateSeerrRequestStats } from "@/lib/seerr/request-stats";

function makeRequest(
  id: number,
  type: "movie" | "tv",
  requestedBy: { id: number; username: string; plexUsername?: string | null },
  media: { tmdbId?: number; tvdbId?: number | null }
) {
  return {
    id,
    type,
    status: 2,
    media: {
      id,
      tmdbId: media.tmdbId ?? 0,
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
      plexUsername: requestedBy.plexUsername ?? undefined,
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
    expect(res.status).toBe(401);
  });

  it("returns configured=false when user has no Seerr instances", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(user.id);

    const body = await expectJson<{ configured: boolean; users: unknown[] }>(
      await callRoute(GET),
      200
    );
    expect(body.configured).toBe(false);
    expect(body.users).toEqual([]);
  });

  it("aggregates requests by user with content types", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(user.id);

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 3 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        makeRequest(2, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 200 }),
        makeRequest(3, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 101 }),
      ],
    });

    const body = await expectJson<{
      configured: boolean;
      users: {
        userKey: string;
        seerrUsername: string;
        requestCount: number;
        movieCount: number;
        seriesCount: number;
        correlatable: boolean;
      }[];
    }>(await callRoute(GET), 200);

    expect(body.configured).toBe(true);
    expect(body.users).toHaveLength(2);
    const alice = body.users.find((u) => u.seerrUsername === "alice");
    const bob = body.users.find((u) => u.seerrUsername === "bob");
    expect(alice).toMatchObject({ requestCount: 2, movieCount: 1, seriesCount: 1, correlatable: true });
    expect(bob).toMatchObject({ requestCount: 1, movieCount: 1, seriesCount: 0, correlatable: true });
    // Sorted by requestCount desc
    expect(body.users[0].seerrUsername).toBe("alice");
  });

  it("marks user as not correlatable when plexUsername is missing", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(user.id);

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [makeRequest(1, "movie", { id: 1, username: "carol" }, { tmdbId: 100 })],
    });

    const body = await expectJson<{
      users: { seerrUsername: string; correlatable: boolean; moviesWatched: number }[];
    }>(await callRoute(GET), 200);

    expect(body.users).toHaveLength(1);
    expect(body.users[0].correlatable).toBe(false);
    expect(body.users[0].moviesWatched).toBe(0);
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
        watchedAt: new Date("2024-06-01"),
      },
    });

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(user.id);

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
        seasonNumber: 1,
        episodeNumber: 1,
      }),
      createTestMediaItem(library.id, {
        type: "SERIES",
        title: "Ep2",
        parentTitle: "Test Series",
        seasonNumber: 1,
        episodeNumber: 2,
      }),
      createTestMediaItem(library.id, {
        type: "SERIES",
        title: "Ep3",
        parentTitle: "Test Series",
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
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(user.id);

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 200 }),
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

  it("does not leak data across users (multi-tenant isolation)", async () => {
    const userA = await createTestUser({ plexId: "userA" });
    const userB = await createTestUser({ plexId: "userB" });
    await createTestSeerrInstance(userA.id);
    // userB has no Seerr instance
    setMockSession({ userId: userB.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(userB.id);

    mockGetRequests.mockResolvedValue({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
      ],
    });

    const body = await expectJson<{ configured: boolean }>(await callRoute(GET), 200);
    expect(body.configured).toBe(false);
    // mockGetRequests should NOT have been called since userB has no instance
    expect(mockGetRequests).not.toHaveBeenCalled();
  });

  it("paginates through multiple pages of requests", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    invalidateSeerrRequestStats(user.id);

    // First page: 100 requests (full page). Second page: 1 request (partial, stop).
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      makeRequest(i + 1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 1000 + i })
    );
    const secondPage = [
      makeRequest(101, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 999 }),
    ];
    mockGetRequests
      .mockResolvedValueOnce({ pageInfo: { page: 1, pages: 2, results: 101 }, results: firstPage })
      .mockResolvedValueOnce({ pageInfo: { page: 2, pages: 2, results: 101 }, results: secondPage });

    const body = await expectJson<{ users: { requestCount: number; movieCount: number; seriesCount: number }[] }>(
      await callRoute(GET),
      200
    );

    expect(mockGetRequests).toHaveBeenCalledTimes(2);
    expect(body.users[0].requestCount).toBe(101);
    expect(body.users[0].movieCount).toBe(100);
    expect(body.users[0].seriesCount).toBe(1);
  });
});
