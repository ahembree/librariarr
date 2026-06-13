import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  seerrInstance: { findFirst: vi.fn() },
}));

const mockSeerrClient = vi.hoisted(() => ({
  getRequests: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: function () { return mockSeerrClient; },
}));

import { fetchSeerrDataForQuery } from "@/lib/query/fetch-seerr-data";

describe("fetchSeerrDataForQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns {} when the selected instance is not found or disabled", async () => {
    mockPrisma.seerrInstance.findFirst.mockResolvedValue(null);
    const result = await fetchSeerrDataForQuery("u1", "s1", ["MOVIE"]);
    expect(result).toEqual({});
  });

  it("maps movie requests keyed by namespaced TMDB id", async () => {
    mockPrisma.seerrInstance.findFirst.mockResolvedValue({ id: "s1", url: "http://o", apiKey: "k" });
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
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

  it("reports combined progress across MOVIE and SERIES sweeps, ending at 1", async () => {
    mockPrisma.seerrInstance.findFirst.mockResolvedValue({ id: "s1", url: "http://o", apiKey: "k" });
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
