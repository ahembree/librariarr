import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  seerrInstance: { findMany: vi.fn() },
  mediaServer: { findMany: vi.fn() },
  mediaItem: { findMany: vi.fn() },
  watchHistory: { findMany: vi.fn() },
}));

const mockSeerrClient = vi.hoisted(() => ({
  getRequests: vi.fn(),
}));

const mockAppCache = vi.hoisted(() => ({
  getOrSet: vi.fn(<T>(_key: string, compute: () => Promise<T>) => compute()),
  invalidate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: function () {
    return mockSeerrClient;
  },
}));
vi.mock("@/lib/cache/memory-cache", () => ({ appCache: mockAppCache }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getSeerrRequestStats } from "@/lib/seerr/request-stats";

interface SeerrUserStub {
  id: number;
  username: string;
  plexUsername?: string;
}

function req(
  id: number,
  type: "movie" | "tv",
  by: SeerrUserStub,
  media: { tmdbId?: number; tvdbId?: number | null }
) {
  return {
    id,
    type,
    status: 2,
    media: {
      tmdbId: media.tmdbId ?? 0,
      tvdbId: media.tvdbId ?? null,
    },
    requestedBy: {
      id: by.id,
      username: by.username,
      plexUsername: by.plexUsername,
      email: `${by.username}@test.com`,
    },
  };
}

describe("getSeerrRequestStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.mediaServer.findMany.mockResolvedValue([{ id: "srv1" }]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.watchHistory.findMany.mockResolvedValue([]);
  });

  it("returns configured=false when user has no Seerr instances", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([]);
    const result = await getSeerrRequestStats("user1");
    expect(result.configured).toBe(false);
    expect(result.users).toEqual([]);
    expect(mockSeerrClient.getRequests).not.toHaveBeenCalled();
  });

  it("aggregates requests by plexUsername and content type", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 3 },
      results: [
        req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        req(2, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 200 }),
        req(3, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 101 }),
      ],
    });

    const result = await getSeerrRequestStats("user1");

    expect(result.configured).toBe(true);
    expect(result.users).toHaveLength(2);
    const alice = result.users.find((u) => u.seerrUsername === "alice")!;
    expect(alice.requestCount).toBe(2);
    expect(alice.movieCount).toBe(1);
    expect(alice.seriesCount).toBe(1);
    expect(alice.correlatable).toBe(true);
    expect(result.totals.requestCount).toBe(3);
    expect(result.totals.movieCount).toBe(2);
    expect(result.totals.seriesCount).toBe(1);
  });

  it("marks user as not correlatable when plexUsername is missing", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [req(1, "movie", { id: 1, username: "carol" }, { tmdbId: 100 })],
    });

    const result = await getSeerrRequestStats("user1");

    expect(result.users).toHaveLength(1);
    expect(result.users[0].correlatable).toBe(false);
    expect(result.users[0].moviesWatched).toBe(0);
  });

  it("aggregates the same plexUsername across multiple Seerr instances", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o1", apiKey: "k1", name: "Seerr1" },
      { id: "s2", url: "http://o2", apiKey: "k2", name: "Seerr2" },
    ]);
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({
        pageInfo: { page: 1, pages: 1, results: 1 },
        results: [req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 })],
      })
      .mockResolvedValueOnce({
        pageInfo: { page: 1, pages: 1, results: 1 },
        results: [req(2, "movie", { id: 7, username: "alice", plexUsername: "alice" }, { tmdbId: 101 })],
      });

    const result = await getSeerrRequestStats("user1");

    expect(result.users).toHaveLength(1);
    expect(result.users[0].requestCount).toBe(2);
    expect(result.users[0].movieCount).toBe(2);
  });

  it("paginates when results match the page size", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      req(i + 1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 1000 + i })
    );
    const secondPage = [req(101, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 9 })];
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({ pageInfo: { page: 1, pages: 2, results: 101 }, results: firstPage })
      .mockResolvedValueOnce({ pageInfo: { page: 2, pages: 2, results: 101 }, results: secondPage });

    const result = await getSeerrRequestStats("user1");

    expect(mockSeerrClient.getRequests).toHaveBeenCalledTimes(2);
    expect(mockSeerrClient.getRequests).toHaveBeenNthCalledWith(1, { take: 100, skip: 0 });
    expect(mockSeerrClient.getRequests).toHaveBeenNthCalledWith(2, { take: 100, skip: 100 });
    expect(result.users[0].requestCount).toBe(101);
  });

  it("continues processing remaining instances when one Seerr fetch fails", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o1", apiKey: "k1", name: "BrokenSeerr" },
      { id: "s2", url: "http://o2", apiKey: "k2", name: "WorkingSeerr" },
    ]);
    mockSeerrClient.getRequests
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        pageInfo: { page: 1, pages: 1, results: 1 },
        results: [req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 })],
      });

    const result = await getSeerrRequestStats("user1");

    expect(result.configured).toBe(true);
    expect(result.users).toHaveLength(1);
    expect(result.users[0].requestCount).toBe(1);
  });

  it("correlates movie watch history via shared dedupKey", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 2 },
      results: [
        req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        req(2, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 200 }),
      ],
    });
    // Canonical movie for tmdb 100 exists in library, with dedupKey "movie-100"
    // tmdb 200 has no matching media item
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      {
        id: "mi-1",
        dedupKey: "movie-100",
        externalIds: [{ externalId: "100" }],
      },
    ]);
    // alice watched the movie
    mockPrisma.watchHistory.findMany.mockResolvedValueOnce([
      { serverUsername: "alice", mediaItem: { dedupKey: "movie-100" } },
    ]);

    const result = await getSeerrRequestStats("user1");

    const alice = result.users[0];
    expect(alice.movieCount).toBe(2);
    expect(alice.moviesWatched).toBe(1);
  });

  it("counts episodes watched vs available for series requests", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [req(1, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 500 })],
    });
    // Series 500 has 3 canonical episodes. Only the series query runs (no movie tmdbIds).
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "ep1", dedupKey: "ep-1", externalIds: [{ externalId: "500" }] },
      { id: "ep2", dedupKey: "ep-2", externalIds: [{ externalId: "500" }] },
      { id: "ep3", dedupKey: "ep-3", externalIds: [{ externalId: "500" }] },
    ]);
    // alice watched ep1 and ep2
    mockPrisma.watchHistory.findMany.mockResolvedValueOnce([
      { serverUsername: "alice", mediaItem: { dedupKey: "ep-1" } },
      { serverUsername: "alice", mediaItem: { dedupKey: "ep-2" } },
    ]);

    const result = await getSeerrRequestStats("user1");

    const alice = result.users[0];
    expect(alice.seriesCount).toBe(1);
    expect(alice.seriesWithAnyEpisodeWatched).toBe(1);
    expect(alice.episodesWatched).toBe(2);
    expect(alice.episodesAvailable).toBe(3);
  });

  it("computes per-type and overall watch totals", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 3 },
      results: [
        // alice requested 2 movies (watched 1) and 1 series (watched 2 of 3 episodes)
        req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        req(2, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 101 }),
        req(3, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 500 }),
      ],
    });
    // Movie 100 watched (canonical), movie 101 not in library
    mockPrisma.mediaItem.findMany
      .mockResolvedValueOnce([
        { id: "m1", dedupKey: "m1-dedup", externalIds: [{ externalId: "100" }] },
      ])
      .mockResolvedValueOnce([
        { id: "e1", dedupKey: "e1-dedup", externalIds: [{ externalId: "500" }] },
        { id: "e2", dedupKey: "e2-dedup", externalIds: [{ externalId: "500" }] },
        { id: "e3", dedupKey: "e3-dedup", externalIds: [{ externalId: "500" }] },
      ]);
    mockPrisma.watchHistory.findMany
      .mockResolvedValueOnce([
        { serverUsername: "alice", mediaItem: { dedupKey: "m1-dedup" } },
      ])
      .mockResolvedValueOnce([
        { serverUsername: "alice", mediaItem: { dedupKey: "e1-dedup" } },
        { serverUsername: "alice", mediaItem: { dedupKey: "e2-dedup" } },
      ]);

    const result = await getSeerrRequestStats("user1");
    const alice = result.users[0];

    expect(alice.moviesWatched).toBe(1);
    expect(alice.episodesWatched).toBe(2);
    expect(alice.episodesAvailable).toBe(3);
    expect(result.totals.moviesWatched).toBe(1);
    expect(result.totals.episodesWatched).toBe(2);
    expect(result.totals.episodesAvailable).toBe(3);
    expect(result.totals.movieCount).toBe(2);
    expect(result.totals.seriesCount).toBe(1);
  });

  it("does not double-count when user appears in multiple instances", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o1", apiKey: "k1", name: "Seerr1" },
      { id: "s2", url: "http://o2", apiKey: "k2", name: "Seerr2" },
    ]);
    // Same plexUsername "alice" on both instances; total should be 3 distinct requests
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({
        pageInfo: { page: 1, pages: 1, results: 2 },
        results: [
          req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
          req(2, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 200 }),
        ],
      })
      .mockResolvedValueOnce({
        pageInfo: { page: 1, pages: 1, results: 1 },
        results: [
          req(3, "movie", { id: 7, username: "alice", plexUsername: "alice" }, { tmdbId: 101 }),
        ],
      });

    const result = await getSeerrRequestStats("user1");

    expect(result.users).toHaveLength(1);
    expect(result.users[0].requestCount).toBe(3);
    expect(result.users[0].movieCount).toBe(2);
    expect(result.users[0].seriesCount).toBe(1);
  });

  it("skips requests with missing requestedBy", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 2 },
      results: [
        {
          ...req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
          requestedBy: null,
        },
        req(2, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 101 }),
      ],
    });

    const result = await getSeerrRequestStats("user1");

    expect(result.users).toHaveLength(1);
    expect(result.users[0].requestCount).toBe(1);
  });

  it("does not query DB when user has no media servers", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockPrisma.mediaServer.findMany.mockResolvedValueOnce([]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
      ],
    });

    const result = await getSeerrRequestStats("user1");

    expect(result.users[0].moviesWatched).toBe(0);
    expect(result.users[0].episodesAvailable).toBe(0);
    // No item or watch-history query attempted
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.watchHistory.findMany).not.toHaveBeenCalled();
  });

  it("sorts users by requestCount descending", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://o", apiKey: "k", name: "Seerr" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 4 },
      results: [
        req(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 1 }),
        req(2, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 2 }),
        req(3, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 3 }),
        req(4, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 4 }),
      ],
    });

    const result = await getSeerrRequestStats("user1");

    expect(result.users[0].seerrUsername).toBe("bob");
    expect(result.users[1].seerrUsername).toBe("alice");
  });
});
