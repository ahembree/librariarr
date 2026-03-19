import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
  createTestRadarrInstance,
  createTestSonarrInstance,
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

const mockRadarrGetMovieByTmdbId = vi.fn();
const mockRadarrGetQualityProfiles = vi.fn();
const mockRadarrGetTags = vi.fn();

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return {
      getMovieByTmdbId: mockRadarrGetMovieByTmdbId,
      getQualityProfiles: mockRadarrGetQualityProfiles,
      getTags: mockRadarrGetTags,
    };
  }),
}));

const mockSonarrGetSeriesByTvdbId = vi.fn();
const mockSonarrGetQualityProfiles = vi.fn();
const mockSonarrGetTags = vi.fn();

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      getSeriesByTvdbId: mockSonarrGetSeriesByTvdbId,
      getQualityProfiles: mockSonarrGetQualityProfiles,
      getTags: mockSonarrGetTags,
    };
  }),
}));

const mockLidarrGetArtistByMusicBrainzId = vi.fn();
const mockLidarrGetQualityProfiles = vi.fn();
const mockLidarrGetTags = vi.fn();

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      getArtistByMusicBrainzId: mockLidarrGetArtistByMusicBrainzId,
      getQualityProfiles: mockLidarrGetQualityProfiles,
      getTags: mockLidarrGetTags,
    };
  }),
}));

import { GET } from "@/app/api/media/[id]/arr-info/route";

describe("GET /api/media/[id]/arr-info", () => {
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

  it("returns empty matches when item has no external ids", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([]);
    expect(body.plexRatingKey).toBeDefined();
  });

  it("matches movie via TMDB ID to Radarr", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "12345");
    await createTestRadarrInstance(userId);

    mockRadarrGetMovieByTmdbId.mockResolvedValue({
      id: 99,
      qualityProfileId: 4,
      tags: [1, 2],
    });
    mockRadarrGetQualityProfiles.mockResolvedValue([
      { id: 4, name: "HD-1080p" },
      { id: 6, name: "Ultra-HD" },
    ]);
    mockRadarrGetTags.mockResolvedValue([
      { id: 1, label: "action" },
      { id: 2, label: "sci-fi" },
    ]);

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toHaveLength(1);
    const match = body.matches[0];
    expect(match.type).toBe("radarr");
    expect(match.qualityProfileName).toBe("HD-1080p");
    expect(match.qualityProfiles).toBeUndefined();
    expect(match.matchedVia).toBe("TMDB");
    expect(match.externalId).toBe("12345");
  });

  it("matches series via TVDB ID to Sonarr", async () => {
    const item = await createTestMediaItem(libraryId, { type: "SERIES" });
    await createTestExternalId(item.id, "TVDB", "67890");
    await createTestSonarrInstance(userId);

    mockSonarrGetSeriesByTvdbId.mockResolvedValue({
      id: 55,
      qualityProfileId: 3,
      tags: [],
    });
    mockSonarrGetQualityProfiles.mockResolvedValue([
      { id: 3, name: "HD-720p/1080p" },
    ]);

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].type).toBe("sonarr");
    expect(body.matches[0].matchedVia).toBe("TVDB");
  });

  it("returns empty matches when arr client finds no match", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "99999");
    await createTestRadarrInstance(userId);

    mockRadarrGetMovieByTmdbId.mockResolvedValue(null);

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([]);
  });

  it("returns empty matches when no arr instances exist", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "12345");
    // No Radarr instance created

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([]);
  });

  it("handles arr client errors gracefully", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "12345");
    await createTestRadarrInstance(userId);

    mockRadarrGetMovieByTmdbId.mockRejectedValue(new Error("Connection refused"));

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([]);
  });
});
