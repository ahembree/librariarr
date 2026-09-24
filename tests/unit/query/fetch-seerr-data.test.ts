import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  seerrInstance: { findMany: vi.fn() },
}));

const mockGetRequests = vi.hoisted(() => vi.fn());
const constructedWith = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: function (url: string) {
    constructedWith.push(url);
    return { getRequests: (params: unknown) => mockGetRequests(url, params) };
  },
}));

import { fetchSeerrDataForQuery } from "@/lib/query/fetch-seerr-data";

const ONE = [{ id: "s1", name: "Seerr", url: "http://o", apiKey: "k" }];

describe("fetchSeerrDataForQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequests.mockReset();
    constructedWith.length = 0;
  });

  it("throws when no Seerr instance is enabled", async () => {
    // An empty map would make every item read as never requested.
    mockPrisma.seerrInstance.findMany.mockResolvedValue([]);
    await expect(fetchSeerrDataForQuery("u1", ["MOVIE"])).rejects.toThrow(/No enabled Seerr instance/);
    expect(mockPrisma.seerrInstance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", enabled: true } }),
    );
  });

  it("returns {} for a music-only query without touching Seerr", async () => {
    await expect(fetchSeerrDataForQuery("u1", ["MUSIC"])).resolves.toEqual({});
    expect(mockPrisma.seerrInstance.findMany).not.toHaveBeenCalled();
  });

  it("maps movie requests keyed by namespaced TMDB id", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE);
    mockGetRequests.mockResolvedValue({
      results: [
        {
          id: 1,
          type: "movie",
          media: { tmdbId: 550, tvdbId: null },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-15", updatedAt: "2024-01-16", status: 2,
        },
      ],
      pageInfo: { page: 1, pages: 1, results: 1 },
    });

    const result = await fetchSeerrDataForQuery("u1", ["MOVIE"]);

    expect(result.MOVIE["TMDB:550"]).toBeDefined();
    expect(result.MOVIE["TMDB:550"].requestCount).toBe(1);
    expect(result.MOVIE["TMDB:550"].approvalDate).toBe("2024-01-16");
    expect(mockGetRequests).toHaveBeenCalledWith("http://o", { take: 100, skip: 0, mediaType: "movie" });
  });

  it("merges every enabled instance, like lifecycle rules", async () => {
    // A title requested only on the older instance must still read as requested.
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "a", name: "Old", url: "http://a", apiKey: "k" },
      { id: "b", name: "New", url: "http://b", apiKey: "k" },
    ]);
    mockGetRequests.mockImplementation(async (url: string) => ({
      results: url === "http://a"
        ? [{ id: 1, type: "movie", media: { tmdbId: 10 }, requestedBy: { plexUsername: "a" }, createdAt: "2024-01-01", updatedAt: null, status: 1 }]
        : [{ id: 1, type: "movie", media: { tmdbId: 20 }, requestedBy: { plexUsername: "b" }, createdAt: "2024-01-01", updatedAt: null, status: 1 }],
    }));

    const result = await fetchSeerrDataForQuery("u1", ["MOVIE"]);

    expect(constructedWith).toEqual(["http://a", "http://b"]);
    expect(result.MOVIE["TMDB:10"].requestedBy).toEqual(["a"]);
    expect(result.MOVIE["TMDB:20"].requestedBy).toEqual(["b"]);
  });

  it("walks once per instance for both types and routes requests by their own type", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE);
    mockGetRequests.mockResolvedValue({
      results: [
        { id: 1, type: "movie", media: { tmdbId: 550 }, requestedBy: { plexUsername: "a" }, createdAt: "2024-01-01", updatedAt: null, status: 1 },
        { id: 2, type: "tv", media: { tmdbId: 550, tvdbId: 77 }, requestedBy: { plexUsername: "b" }, createdAt: "2024-01-01", updatedAt: null, status: 1 },
      ],
    });

    const result = await fetchSeerrDataForQuery("u1", ["MOVIE", "SERIES"]);

    expect(mockGetRequests).toHaveBeenCalledTimes(1);
    expect(mockGetRequests).toHaveBeenCalledWith("http://o", { take: 100, skip: 0 });
    expect(result.MOVIE["TMDB:550"].requestedBy).toEqual(["a"]);
    expect(result.SERIES["TMDB:550"].requestedBy).toEqual(["b"]);
    expect(result.SERIES["TVDB:77"]).toBe(result.SERIES["TMDB:550"]);
  });

  it("reports progress ending at 1", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue(ONE);
    mockGetRequests.mockResolvedValue({
      results: [],
      pageInfo: { page: 1, pages: 1, results: 0 },
    });

    const fractions: number[] = [];
    await fetchSeerrDataForQuery("u1", ["MOVIE", "SERIES"], (f) => fractions.push(f));

    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
  });
});
