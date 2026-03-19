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
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    const library = await createTestLibrary(server.id);
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRouteWithParams(GET, { id: "any" });
    expect(response.status).toBe(401);
  });

  it("returns 404 for non-existent item", async () => {
    const response = await callRouteWithParams(GET, { id: "nonexistent" });
    expect(response.status).toBe(404);
  });

  it("returns show-level metadata via grandparentRatingKey", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      ratingKey: "ep-100",
    });

    // First call: episode metadata with grandparentRatingKey
    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "ep-100",
      grandparentRatingKey: "show-50",
      summary: "Episode summary",
    });

    // Second call: show metadata
    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "show-50",
      summary: "A great TV show about...",
      Genre: [{ tag: "Drama" }, { tag: "Thriller" }],
      studio: "HBO",
      contentRating: "TV-MA",
      year: 2020,
    });

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary).toBe("A great TV show about...");
    expect(body.genres).toEqual(["Drama", "Thriller"]);
    expect(body.studio).toBe("HBO");
    expect(body.contentRating).toBe("TV-MA");
    expect(body.year).toBe(2020);
  });

  it("falls back to stored data when Plex call fails", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      ratingKey: "ep-200",
      summary: "Stored episode summary",
      year: 2019,
    });

    mockGetItemMetadata.mockRejectedValue(new Error("Plex unavailable"));

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Falls back to stored DB fields
    expect(body.summary).toBeDefined();
  });

  it("falls back when no grandparentRatingKey", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      ratingKey: "ep-300",
    });

    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "ep-300",
      summary: "Standalone episode",
      // No grandparentRatingKey
    });

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("summary");
  });
});
