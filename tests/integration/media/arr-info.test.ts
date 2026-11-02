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
  // The instance URL rides along as the lookup's second argument, so a test
  // can answer per instance instead of relying on the order the parallel
  // lookups happen to start in.
  RadarrClient: vi.fn().mockImplementation(function (url: string) {
    return {
      getMovieByTmdbId: (tmdbId: number) => mockRadarrGetMovieByTmdbId(tmdbId, url),
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
import { apiLogger } from "@/lib/logger";

describe("GET /api/media/[id]/arr-info", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; drop each test's answers so none
    // leaks into the next.
    for (const mock of [
      mockRadarrGetMovieByTmdbId,
      mockRadarrGetQualityProfiles,
      mockRadarrGetTags,
      mockSonarrGetSeriesByTvdbId,
      mockSonarrGetQualityProfiles,
      mockSonarrGetTags,
      mockLidarrGetArtistByMusicBrainzId,
      mockLidarrGetQualityProfiles,
      mockLidarrGetTags,
    ]) {
      mock.mockReset();
    }
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true});
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
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 for non-existent item", async () => {
    const response = await callRouteWithParams(GET, { id: "nonexistent" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("returns empty matches when item has no external ids", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    // An enabled instance exists, so an empty answer can only come from the
    // missing TMDB id.
    await createTestRadarrInstance(userId);
    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([]);
    expect(mockRadarrGetMovieByTmdbId).not.toHaveBeenCalled();
  });

  it("matches movie via TMDB ID to Radarr", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "12345");
    const instance = await createTestRadarrInstance(userId);

    mockRadarrGetMovieByTmdbId.mockResolvedValue({
      id: 99,
      title: "Test Movie",
      tmdbId: 12345,
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
    // Exactly these fields: the profile list itself is not passed through.
    expect(body.matches).toEqual([
      {
        type: "radarr",
        instanceId: instance.id,
        instanceName: "Test Radarr",
        qualityProfileName: "HD-1080p",
        matchedVia: "TMDB",
        externalId: "12345",
        tags: ["action", "sci-fi"],
        arrUrl: "http://radarr.test:7878/movie/12345",
      },
    ]);
    expect(mockRadarrGetMovieByTmdbId).toHaveBeenCalledWith(12345, "http://radarr.test:7878");
  });

  it("matches series via TVDB ID to Sonarr", async () => {
    const server = await createTestServer(userId, { name: "TV Server" });
    const seriesLibrary = await createTestLibrary(server.id, { type: "SERIES" });
    const item = await createTestMediaItem(seriesLibrary.id, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "The Office",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestExternalId(item.id, "TVDB", "67890");
    const instance = await createTestSonarrInstance(userId);

    mockSonarrGetSeriesByTvdbId.mockResolvedValue({
      id: 55,
      title: "The Office",
      titleSlug: "the-office-us",
      tvdbId: 67890,
      qualityProfileId: 3,
      tags: [],
    });
    mockSonarrGetQualityProfiles.mockResolvedValue([
      { id: 3, name: "HD-720p/1080p" },
    ]);

    const response = await callRouteWithParams(GET, { id: item.id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches).toEqual([
      {
        type: "sonarr",
        instanceId: instance.id,
        instanceName: "Test Sonarr",
        qualityProfileName: "HD-720p/1080p",
        matchedVia: "TVDB",
        externalId: "67890",
        tags: [],
        // Linked by the series' title slug.
        arrUrl: "http://sonarr.test:8989/series/the-office-us",
      },
    ]);
    expect(mockSonarrGetSeriesByTvdbId).toHaveBeenCalledWith(67890);
    // An untagged series needs no tag lookup.
    expect(mockSonarrGetTags).not.toHaveBeenCalled();
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

  it("does not query disabled instances, and one failing instance does not hide another's match", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "12345");
    await createTestRadarrInstance(userId, { name: "Off", url: "http://off.test:7878", enabled: false });
    await createTestRadarrInstance(userId, { name: "Down", url: "http://down.test:7878" });
    await createTestRadarrInstance(userId, { name: "Up", url: "http://up.test:7878" });

    mockRadarrGetMovieByTmdbId.mockImplementation(async (_tmdbId: number, url: string) => {
      if (url === "http://down.test:7878") throw new Error("Radarr unreachable");
      return { id: 99, title: "Test Movie", tmdbId: 12345, qualityProfileId: 4, tags: [] };
    });
    mockRadarrGetQualityProfiles.mockResolvedValue([{ id: 4, name: "HD-1080p" }]);

    const response = await callRouteWithParams(GET, { id: item.id });
    const body = await response.json();

    // Only the two enabled instances are asked.
    expect(mockRadarrGetMovieByTmdbId).toHaveBeenCalledTimes(2);
    expect(mockRadarrGetMovieByTmdbId.mock.calls.map((c) => c[1]).sort()).toEqual([
      "http://down.test:7878",
      "http://up.test:7878",
    ]);
    expect(body.matches.map((m: { instanceName: string }) => m.instanceName)).toEqual(["Up"]);
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
    expect(apiLogger.error).toHaveBeenCalledWith(
      "Media",
      "Failed to query Radarr instance Test Radarr",
      { error: "Error: Connection refused" },
    );
  });
});
