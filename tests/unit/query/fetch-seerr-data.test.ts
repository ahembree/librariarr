import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  seerrInstance: { findFirst: vi.fn() },
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

import { fetchSeerrDataForQuery } from "@/lib/query/fetch-seerr-data";

describe("fetchSeerrDataForQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeerrClient.getRequests.mockReset();
  });

  it("throws when the selected instance is not found or disabled", async () => {
    // An empty map would make every item read as never requested.
    mockPrisma.seerrInstance.findFirst.mockResolvedValue(null);
    await expect(fetchSeerrDataForQuery("u1", "s1", ["MOVIE"])).rejects.toThrow(/disabled or no longer exists/);
  });

  it("maps movie requests keyed by namespaced TMDB id", async () => {
    mockPrisma.seerrInstance.findFirst.mockResolvedValue({ id: "s1", name: "Seerr", url: "http://o", apiKey: "k" });
    mockSeerrClient.getRequests.mockResolvedValue({
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

    const result = await fetchSeerrDataForQuery("u1", "s1", ["MOVIE"]);

    expect(result.MOVIE["TMDB:550"]).toBeDefined();
    expect(result.MOVIE["TMDB:550"].requestCount).toBe(1);
    expect(result.MOVIE["TMDB:550"].approvalDate).toBe("2024-01-16");
    expect(mockSeerrClient.getRequests).toHaveBeenCalledWith({ take: 100, skip: 0, mediaType: "movie" });
  });

  it("walks once for both types and routes requests by their own type", async () => {
    mockPrisma.seerrInstance.findFirst.mockResolvedValue({ id: "s1", name: "Seerr", url: "http://o", apiKey: "k" });
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        { id: 1, type: "movie", media: { tmdbId: 550 }, requestedBy: { plexUsername: "a" }, createdAt: "2024-01-01", updatedAt: null, status: 1 },
        { id: 2, type: "tv", media: { tmdbId: 550, tvdbId: 77 }, requestedBy: { plexUsername: "b" }, createdAt: "2024-01-01", updatedAt: null, status: 1 },
      ],
    });

    const result = await fetchSeerrDataForQuery("u1", "s1", ["MOVIE", "SERIES"]);

    expect(mockSeerrClient.getRequests).toHaveBeenCalledTimes(1);
    expect(mockSeerrClient.getRequests).toHaveBeenCalledWith({ take: 100, skip: 0 });
    expect(result.MOVIE["TMDB:550"].requestedBy).toEqual(["a"]);
    expect(result.SERIES["TMDB:550"].requestedBy).toEqual(["b"]);
    expect(result.SERIES["TVDB:77"]).toBe(result.SERIES["TMDB:550"]);
  });

  it("reports progress ending at 1", async () => {
    mockPrisma.seerrInstance.findFirst.mockResolvedValue({ id: "s1", name: "Seerr", url: "http://o", apiKey: "k" });
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [],
      pageInfo: { page: 1, pages: 1, results: 0 },
    });

    const fractions: number[] = [];
    await fetchSeerrDataForQuery("u1", "s1", ["MOVIE", "SERIES"], (f) => fractions.push(f));

    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1);
  });
});
