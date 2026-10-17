import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

const mockGetItemMetadata = vi.fn();

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      getItemMetadata: mockGetItemMetadata,
    };
  }),
}));

import { GET } from "@/app/api/media/[id]/series-summary/route";

describe("GET /api/media/[id]/series-summary", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // Drop any answer a previous test queued or left in place.
    mockGetItemMetadata.mockReset();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true});
    const server = await createTestServer(userId);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRouteWithParams(GET, { id: "any" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 for non-existent item", async () => {
    const response = await callRouteWithParams(GET, { id: "nonexistent" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mockGetItemMetadata).not.toHaveBeenCalled();
  });

  it("returns show-level metadata via grandparentRatingKey", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "The Show",
      seasonNumber: 1,
      episodeNumber: 1,
      ratingKey: "48213",
      summary: "Episode summary",
    });

    // First call: episode metadata with grandparentRatingKey
    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "48213",
      type: "episode",
      title: "Pilot",
      grandparentTitle: "The Show",
      grandparentRatingKey: "48190",
      summary: "Episode summary",
    });

    // Second call: show metadata
    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "48190",
      type: "show",
      title: "The Show",
      summary: "A great TV show about...",
      Genre: [{ tag: "Drama" }, { tag: "Thriller" }],
      studio: "HBO",
      contentRating: "TV-MA",
      year: 2020,
    });

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: "A great TV show about...",
      genres: ["Drama", "Thriller"],
      studio: "HBO",
      contentRating: "TV-MA",
      year: 2020,
    });
    expect(mockGetItemMetadata.mock.calls).toEqual([["48213"], ["48190"]]);
  });

  it("falls back to stored data when Plex call fails", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      ratingKey: "48214",
      summary: "Stored episode summary",
      year: 2019,
      genres: ["Drama"],
      studio: "AMC",
      contentRating: "TV-14",
    });

    mockGetItemMetadata.mockRejectedValue(new Error("Plex unavailable"));

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    // Falls back to stored DB fields
    expect(await response.json()).toEqual({
      summary: "Stored episode summary",
      genres: ["Drama"],
      studio: "AMC",
      contentRating: "TV-14",
      year: 2019,
    });
  });

  it("falls back when no grandparentRatingKey", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      ratingKey: "48215",
      summary: "Stored summary",
      year: 2018,
    });

    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "48215",
      summary: "Standalone episode",
      // No grandparentRatingKey
    });

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    // The stored row's fields, not the live episode's, and no second lookup.
    expect(await response.json()).toEqual({
      summary: "Stored summary",
      genres: [],
      studio: null,
      contentRating: null,
      year: 2018,
    });
    expect(mockGetItemMetadata).toHaveBeenCalledTimes(1);
  });
});
