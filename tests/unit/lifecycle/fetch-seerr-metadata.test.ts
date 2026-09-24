import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  seerrInstance: { findMany: vi.fn(), count: vi.fn() },
}));

const mockSeerrClient = vi.hoisted(() => ({
  getRequests: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: function () { return mockSeerrClient; },
}));

import { fetchSeerrMetadata, hasEnabledSeerrInstances } from "@/lib/lifecycle/fetch-seerr-metadata";

let nextId = 1;
function request(overrides: {
  id?: number;
  type?: "movie" | "tv";
  media: { tmdbId?: number | null; tvdbId?: number | null };
  requestedBy?: { plexUsername?: string | null; username?: string | null; email?: string | null };
  createdAt?: string | null;
  updatedAt?: string | null;
  status?: number;
}) {
  return {
    id: overrides.id ?? nextId++,
    type: overrides.type ?? "movie",
    media: overrides.media,
    requestedBy: overrides.requestedBy ?? { plexUsername: "user", username: null, email: null },
    createdAt: overrides.createdAt === undefined ? "2024-01-01" : overrides.createdAt,
    updatedAt: overrides.updatedAt === undefined ? null : overrides.updatedAt,
    status: overrides.status ?? 1,
  };
}

const ONE_INSTANCE = [{ id: "s1", name: "Seerr", url: "http://seerr", apiKey: "key" }];

describe("hasEnabledSeerrInstances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is true when an enabled instance exists", async () => {
    mockPrisma.seerrInstance.count.mockResolvedValue(2);
    await expect(hasEnabledSeerrInstances("u1")).resolves.toBe(true);
    expect(mockPrisma.seerrInstance.count).toHaveBeenCalledWith({
      where: { userId: "u1", enabled: true },
    });
  });

  it("is false when none exist", async () => {
    mockPrisma.seerrInstance.count.mockResolvedValue(0);
    await expect(hasEnabledSeerrInstances("u1")).resolves.toBe(false);
  });
});

describe("fetchSeerrMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeerrClient.getRequests.mockReset();
  });

  it("returns empty map when no Seerr instances exist", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([]);
    const result = await fetchSeerrMetadata("u1", "MOVIE");
    expect(result).toEqual({});
  });

  it("fetches and maps movie requests by TMDB ID", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({
          media: { tmdbId: 550, tvdbId: null },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-15",
          updatedAt: "2024-01-16",
          status: 2, // approved
        }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:550"]).toBeDefined();
    expect(result["TMDB:550"].requested).toBe(true);
    expect(result["TMDB:550"].requestCount).toBe(1);
    expect(result["TMDB:550"].requestedBy).toEqual(["john"]);
    expect(result["TMDB:550"].requestDate).toBe("2024-01-15");
    expect(result["TMDB:550"].approvalDate).toBe("2024-01-16");
    expect(result["TMDB:550"].declineDate).toBeNull();
  });

  it("treats COMPLETED (5) and FAILED (4) requests as approved", async () => {
    // Seerr moves an approved request to COMPLETED once its media arrives, so
    // a fulfilled request must still carry an approval date.
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({ media: { tmdbId: 1 }, updatedAt: "2024-05-01", status: 5 }),
        request({ media: { tmdbId: 2 }, updatedAt: "2024-05-02", status: 4 }),
        request({ media: { tmdbId: 3 }, updatedAt: "2024-05-03", status: 1 }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:1"].approvalDate).toBe("2024-05-01");
    expect(result["TMDB:2"].approvalDate).toBe("2024-05-02");
    expect(result["TMDB:3"].approvalDate).toBeNull();
  });

  it("fetches TV requests keyed by both TVDB and TMDB ID, sharing one record", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({
          type: "tv",
          media: { tmdbId: 1000, tvdbId: 2000 },
          requestedBy: { plexUsername: null, username: "jane", email: null },
          createdAt: "2024-02-01",
          status: 1, // pending
        }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "SERIES");

    expect(result["TVDB:2000"]).toBeDefined();
    expect(result["TMDB:1000"]).toBeDefined();
    expect(result["TVDB:2000"]).toBe(result["TMDB:1000"]);
    expect(result["TVDB:2000"].requestedBy).toEqual(["jane"]);
  });

  it("merges TV requests for one show when only some instances know its tvdbId", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "a", name: "A", url: "http://a", apiKey: "k" },
      { id: "b", name: "B", url: "http://b", apiKey: "k" },
    ]);
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({
        results: [
          request({
            type: "tv",
            media: { tmdbId: 100, tvdbId: 200 },
            requestedBy: { plexUsername: "alice" },
            createdAt: "2024-01-01",
          }),
        ],
      })
      .mockResolvedValueOnce({
        results: [
          request({
            type: "tv",
            media: { tmdbId: 100, tvdbId: null },
            requestedBy: { plexUsername: "bob" },
            createdAt: "2023-06-01",
          }),
        ],
      });

    const result = await fetchSeerrMetadata("u1", "SERIES");

    // The TVDB key (tried first by lookupSeerrMeta) must hold bob's request too.
    expect(result["TVDB:200"].requestCount).toBe(2);
    expect(result["TVDB:200"].requestedBy.sort()).toEqual(["alice", "bob"]);
    expect(result["TVDB:200"]).toBe(result["TMDB:100"]);
  });

  it("filters out requests of the other media type", async () => {
    // TMDB movie and TV ids share one numeric space: a TV request leaking into
    // the MOVIE map would mark an unrelated movie as requested.
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({ type: "tv", media: { tmdbId: 550, tvdbId: 9 } }),
        request({ type: "movie", media: { tmdbId: 551 } }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:550"]).toBeUndefined();
    expect(result["TMDB:551"]).toBeDefined();
  });

  it("merges multiple requests for the same TMDB ID, keeping the most recent dates", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({
          media: { tmdbId: 550 },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-15",
          updatedAt: "2024-01-16",
          status: 2,
        }),
        request({
          media: { tmdbId: 550 },
          requestedBy: { plexUsername: "jane", username: null, email: null },
          createdAt: "2024-01-10",
          updatedAt: "2024-01-20",
          status: 5,
        }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:550"].requestCount).toBe(2);
    expect(result["TMDB:550"].requestedBy).toEqual(["john", "jane"]);
    // A re-request after deletion must reset recency, so the latest wins.
    expect(result["TMDB:550"].requestDate).toBe("2024-01-15");
    expect(result["TMDB:550"].approvalDate).toBe("2024-01-20");
  });

  it("does not duplicate the same username in requestedBy", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({ media: { tmdbId: 550 }, requestedBy: { plexUsername: "john" }, createdAt: "2024-01-15" }),
        request({ media: { tmdbId: 550 }, requestedBy: { plexUsername: "john" }, createdAt: "2024-01-20" }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:550"].requestedBy).toEqual(["john"]);
  });

  it("tracks decline date for status 3", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({
          media: { tmdbId: 100 },
          requestedBy: { plexUsername: null, username: null, email: "test@example.com" },
          createdAt: "2024-03-01",
          updatedAt: "2024-03-05",
          status: 3, // declined
        }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:100"].declineDate).toBe("2024-03-05");
    expect(result["TMDB:100"].approvalDate).toBeNull();
  });

  it("falls back to 'Unknown' when no user identifiers are present", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        request({
          media: { tmdbId: 999 },
          requestedBy: { plexUsername: null, username: null, email: null },
          createdAt: null,
        }),
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:999"].requestedBy).toEqual(["Unknown"]);
    expect(result["TMDB:999"].requestDate).toBeNull();
  });

  it("paginates through all results with overlapping pages", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    const all = Array.from({ length: 101 }, (_, i) => request({ id: 1000 - i, media: { tmdbId: i + 1 } }));
    mockSeerrClient.getRequests.mockImplementation(({ take, skip }: { take: number; skip: number }) =>
      Promise.resolve({ results: all.slice(skip, skip + take) }),
    );

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(mockSeerrClient.getRequests).toHaveBeenCalledTimes(2);
    expect(mockSeerrClient.getRequests).toHaveBeenNthCalledWith(1, { take: 100, skip: 0, mediaType: "movie" });
    expect(mockSeerrClient.getRequests).toHaveBeenNthCalledWith(2, { take: 100, skip: 90, mediaType: "movie" });
    expect(Object.keys(result)).toHaveLength(101);
    // Overlapping rows are counted once.
    expect(Object.values(result).every((m) => m.requestCount === 1)).toBe(true);
  });

  it("reports determinate progress from pageInfo.results, ending at 1", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    const all = Array.from({ length: 101 }, (_, i) => request({ id: 5000 - i, media: { tmdbId: i + 1 } }));
    mockSeerrClient.getRequests.mockImplementation(({ take, skip }: { take: number; skip: number }) =>
      Promise.resolve({ results: all.slice(skip, skip + take), pageInfo: { page: 1, pages: 2, results: 101 } }),
    );

    const fractions: number[] = [];
    await fetchSeerrMetadata("u1", "MOVIE", (f) => fractions.push(f));

    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.some((f) => f > 0.9 && f < 1)).toBe(true);
  });

  it("uses 'tv' media type for SERIES", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    mockSeerrClient.getRequests.mockResolvedValue({ results: [] });

    await fetchSeerrMetadata("u1", "SERIES");

    expect(mockSeerrClient.getRequests).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "tv" }),
    );
  });

  it("propagates a failed walk instead of returning a partial map", async () => {
    // A missing request reads as "never requested" — a partial map fails open.
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE_INSTANCE);
    const firstPage = Array.from({ length: 100 }, (_, i) => request({ id: 900 - i, media: { tmdbId: i + 1 } }));
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({ results: firstPage })
      .mockRejectedValueOnce(new Error("Seerr HTTP 502"));

    await expect(fetchSeerrMetadata("u1", "MOVIE")).rejects.toThrow("Seerr HTTP 502");
  });

  it("aggregates across multiple Seerr instances", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", name: "One", url: "http://seerr1", apiKey: "key1" },
      { id: "s2", name: "Two", url: "http://seerr2", apiKey: "key2" },
    ]);
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({
        results: [request({ id: 1, media: { tmdbId: 100 }, requestedBy: { plexUsername: "user1" } })],
      })
      .mockResolvedValueOnce({
        // Same request id on another instance is a different request.
        results: [request({ id: 1, media: { tmdbId: 200 }, requestedBy: { plexUsername: "user2" } })],
      });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["TMDB:100"]).toBeDefined();
    expect(result["TMDB:200"]).toBeDefined();
  });
});
