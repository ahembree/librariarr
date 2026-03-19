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

import { GET } from "@/app/api/media/[id]/artist-summary/route";

describe("GET /api/media/[id]/artist-summary", () => {
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
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
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

  it("returns artist-level metadata via grandparentRatingKey", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "MUSIC",
      ratingKey: "track-100",
    });

    // First call: track metadata with grandparentRatingKey
    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "track-100",
      grandparentRatingKey: "artist-50",
      summary: "Track summary",
    });

    // Second call: artist metadata
    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "artist-50",
      summary: "A legendary rock band formed in...",
      Genre: [{ tag: "Rock" }, { tag: "Alternative" }],
      studio: "Record Label",
      contentRating: null,
      year: 1990,
    });

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary).toBe("A legendary rock band formed in...");
    expect(body.genres).toEqual(["Rock", "Alternative"]);
    expect(body.year).toBe(1990);
  });

  it("falls back to stored data when Plex call fails", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "MUSIC",
      ratingKey: "track-200",
      summary: "Stored track summary",
    });

    mockGetItemMetadata.mockRejectedValue(new Error("Plex unavailable"));

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("summary");
  });

  it("falls back when no grandparentRatingKey", async () => {
    const item = await createTestMediaItem(libraryId, {
      type: "MUSIC",
      ratingKey: "track-300",
    });

    mockGetItemMetadata.mockResolvedValueOnce({
      ratingKey: "track-300",
      summary: "Standalone track",
    });

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("summary");
  });
});
