import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  seerrInstance: { findMany: vi.fn() },
}));

const mockSeerrClient = vi.hoisted(() => ({
  getRequests: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: function () { return mockSeerrClient; },
}));

import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";

describe("fetchSeerrMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty map when no Seerr instances exist", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([]);
    const result = await fetchSeerrMetadata("u1", "MOVIE");
    expect(result).toEqual({});
  });

  it("fetches and maps movie requests by TMDB ID", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
          media: { tmdbId: 550, tvdbId: null },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-15",
          updatedAt: "2024-01-16",
          status: 2, // approved
        },
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["550"]).toBeDefined();
    expect(result["550"].requested).toBe(true);
    expect(result["550"].requestCount).toBe(1);
    expect(result["550"].requestedBy).toEqual(["john"]);
    expect(result["550"].requestDate).toBe("2024-01-15");
    expect(result["550"].approvalDate).toBe("2024-01-16");
    expect(result["550"].declineDate).toBeNull();
  });

  it("fetches TV requests keyed by both TVDB and TMDB ID", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
          media: { tmdbId: 1000, tvdbId: 2000 },
          requestedBy: { plexUsername: null, username: "jane", email: null },
          createdAt: "2024-02-01",
          updatedAt: null,
          status: 1, // pending
        },
      ],
    });

    const result = await fetchSeerrMetadata("u1", "SERIES");

    // Should be keyed by both TVDB ID and TMDB ID
    expect(result["2000"]).toBeDefined();
    expect(result["1000"]).toBeDefined();
    expect(result["2000"].requestedBy).toEqual(["jane"]);
    expect(result["1000"].requestedBy).toEqual(["jane"]);
  });

  it("merges multiple requests for the same TMDB ID", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
          media: { tmdbId: 550 },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-15",
          updatedAt: "2024-01-16",
          status: 2,
        },
        {
          media: { tmdbId: 550 },
          requestedBy: { plexUsername: "jane", username: null, email: null },
          createdAt: "2024-01-10",
          updatedAt: "2024-01-20",
          status: 2,
        },
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["550"].requestCount).toBe(2);
    expect(result["550"].requestedBy).toEqual(["john", "jane"]);
    // Should use earliest request date
    expect(result["550"].requestDate).toBe("2024-01-10");
    // Should use earliest approval date
    expect(result["550"].approvalDate).toBe("2024-01-16");
  });

  it("does not duplicate the same username in requestedBy", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
          media: { tmdbId: 550 },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-15",
          updatedAt: null,
          status: 1,
        },
        {
          media: { tmdbId: 550 },
          requestedBy: { plexUsername: "john", username: null, email: null },
          createdAt: "2024-01-20",
          updatedAt: null,
          status: 1,
        },
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["550"].requestedBy).toEqual(["john"]);
  });

  it("tracks decline date for status 3", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
          media: { tmdbId: 100 },
          requestedBy: { plexUsername: null, username: null, email: "test@example.com" },
          createdAt: "2024-03-01",
          updatedAt: "2024-03-05",
          status: 3, // declined
        },
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["100"].declineDate).toBe("2024-03-05");
    expect(result["100"].approvalDate).toBeNull();
  });

  it("falls back to 'Unknown' when no user identifiers are present", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({
      results: [
        {
          media: { tmdbId: 999 },
          requestedBy: { plexUsername: null, username: null, email: null },
          createdAt: null,
          updatedAt: null,
          status: 1,
        },
      ],
    });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["999"].requestedBy).toEqual(["Unknown"]);
    expect(result["999"].requestDate).toBeNull();
  });

  it("paginates through all results", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);

    // First page: exactly 100 results (hasMore = true)
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      media: { tmdbId: i + 1 },
      requestedBy: { plexUsername: "user", username: null, email: null },
      createdAt: "2024-01-01",
      updatedAt: null,
      status: 1,
    }));
    // Second page: fewer than 100 results (hasMore = false)
    const secondPage = [
      {
        media: { tmdbId: 101 },
        requestedBy: { plexUsername: "user", username: null, email: null },
        createdAt: "2024-01-01",
        updatedAt: null,
        status: 1,
      },
    ];

    mockSeerrClient.getRequests
      .mockResolvedValueOnce({ results: firstPage })
      .mockResolvedValueOnce({ results: secondPage });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(mockSeerrClient.getRequests).toHaveBeenCalledTimes(2);
    expect(mockSeerrClient.getRequests).toHaveBeenCalledWith({ take: 100, skip: 0, mediaType: "movie" });
    expect(mockSeerrClient.getRequests).toHaveBeenCalledWith({ take: 100, skip: 100, mediaType: "movie" });
    expect(Object.keys(result)).toHaveLength(101);
  });

  it("uses 'tv' media type for SERIES", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr", apiKey: "key" },
    ]);
    mockSeerrClient.getRequests.mockResolvedValue({ results: [] });

    await fetchSeerrMetadata("u1", "SERIES");

    expect(mockSeerrClient.getRequests).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "tv" }),
    );
  });

  it("aggregates across multiple Seerr instances", async () => {
    mockPrisma.seerrInstance.findMany.mockResolvedValue([
      { id: "s1", url: "http://overseerr1", apiKey: "key1" },
      { id: "s2", url: "http://overseerr2", apiKey: "key2" },
    ]);
    mockSeerrClient.getRequests
      .mockResolvedValueOnce({
        results: [
          {
            media: { tmdbId: 100 },
            requestedBy: { plexUsername: "user1", username: null, email: null },
            createdAt: "2024-01-01",
            updatedAt: null,
            status: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            media: { tmdbId: 200 },
            requestedBy: { plexUsername: "user2", username: null, email: null },
            createdAt: "2024-02-01",
            updatedAt: null,
            status: 1,
          },
        ],
      });

    const result = await fetchSeerrMetadata("u1", "MOVIE");

    expect(result["100"]).toBeDefined();
    expect(result["200"]).toBeDefined();
  });
});
