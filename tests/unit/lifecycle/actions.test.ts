import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findUnique: vi.fn() },
  sonarrInstance: { findUnique: vi.fn() },
  lidarrInstance: { findUnique: vi.fn() },
  mediaItem: { findMany: vi.fn() },
}));

const mockRadarrClient = vi.hoisted(() => ({
  getMovieByTmdbId: vi.fn(),
  deleteMovie: vi.fn(),
  updateMovie: vi.fn(),
  addExclusion: vi.fn(),
  deleteMovieFile: vi.fn(),
  triggerMovieSearch: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getMovies: vi.fn(),
  getQualityProfiles: vi.fn(),
}));

const mockSonarrClient = vi.hoisted(() => ({
  getSeriesByTvdbId: vi.fn(),
  deleteSeries: vi.fn(),
  updateSeries: vi.fn(),
  addExclusion: vi.fn(),
  getEpisodeFiles: vi.fn(),
  deleteEpisodeFiles: vi.fn(),
  getEpisodes: vi.fn(),
  triggerSeriesSearch: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getSeries: vi.fn(),
  getQualityProfiles: vi.fn(),
}));

const mockLidarrClient = vi.hoisted(() => ({
  getArtistByMusicBrainzId: vi.fn(),
  deleteArtist: vi.fn(),
  updateArtist: vi.fn(),
  addExclusion: vi.fn(),
  getTrackFiles: vi.fn(),
  deleteTrackFiles: vi.fn(),
  triggerArtistSearch: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getArtists: vi.fn(),
  getQualityProfiles: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: function () { return mockRadarrClient; },
}));
vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: function () { return mockSonarrClient; },
}));
vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: function () { return mockLidarrClient; },
}));
vi.mock("axios", () => ({
  default: { isAxiosError: vi.fn() },
  isAxiosError: vi.fn(),
}));

import { executeAction, extractActionError, cleanupArrTags } from "@/lib/lifecycle/actions";
import type { ActionRecord } from "@/lib/lifecycle/actions";
import axios from "axios";

function makeAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: "action1",
    actionType: "DELETE_RADARR",
    arrInstanceId: "arr1",
    targetQualityProfileId: null,
    addImportExclusion: false,
    searchAfterAction: false,
    matchedMediaItemIds: [],
    addArrTags: [],
    removeArrTags: [],
    mediaItem: {
      id: "item1",
      title: "Test Movie",
      parentTitle: null,
      year: 2024,
      externalIds: [{ source: "TMDB", externalId: "12345" }],
    },
    ...overrides,
  };
}

describe("extractActionError", () => {
  it("returns message from Error instance", () => {
    expect(extractActionError(new Error("something broke"))).toBe("something broke");
  });

  it("returns 'Unknown error' for non-Error values", () => {
    expect(extractActionError("string error")).toBe("Unknown error");
    expect(extractActionError(42)).toBe("Unknown error");
    expect(extractActionError(null)).toBe("Unknown error");
  });

  it("extracts HTTP status and message from Axios error", () => {
    const axiosError = {
      response: {
        status: 404,
        data: { message: "Not found" },
      },
      message: "Request failed",
    };
    vi.mocked(axios.isAxiosError).mockReturnValue(true);
    expect(extractActionError(axiosError)).toBe("HTTP 404: Not found");
  });

  it("extracts string response body from Axios error", () => {
    const axiosError = {
      response: {
        status: 500,
        data: "Internal Server Error",
      },
      message: "Request failed",
    };
    vi.mocked(axios.isAxiosError).mockReturnValue(true);
    expect(extractActionError(axiosError)).toBe("HTTP 500: Internal Server Error");
  });

  it("falls back to error.message when no detail in Axios response", () => {
    const axiosError = {
      response: {
        status: 503,
        data: { other: "field" },
      },
      message: "Service unavailable",
    };
    vi.mocked(axios.isAxiosError).mockReturnValue(true);
    expect(extractActionError(axiosError)).toBe("HTTP 503: Service unavailable");
  });
});

describe("executeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.isAxiosError).mockReturnValue(false);
  });

  it("handles DO_NOTHING action type without calling any client", async () => {
    const action = makeAction({ actionType: "DO_NOTHING", addArrTags: [], removeArrTags: [] });
    await executeAction(action);
    expect(mockRadarrClient.deleteMovie).not.toHaveBeenCalled();
    expect(mockSonarrClient.deleteSeries).not.toHaveBeenCalled();
  });

  it("executes SEARCH_RADARR — triggers a movie search without other changes", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [], monitored: true, hasFile: true, movieFileId: 99,
    });

    await executeAction(makeAction({ actionType: "SEARCH_RADARR" }));

    expect(mockRadarrClient.triggerMovieSearch).toHaveBeenCalledWith(1);
    // Must not mutate the movie or delete files — search only.
    expect(mockRadarrClient.updateMovie).not.toHaveBeenCalled();
    expect(mockRadarrClient.deleteMovieFile).not.toHaveBeenCalled();
  });

  it("executes SEARCH_SONARR — triggers a series search", async () => {
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://sonarr", apiKey: "key", enabled: true,
    });
    mockSonarrClient.getSeriesByTvdbId.mockResolvedValue({
      id: 2, title: "Test Show", tvdbId: 67890, tags: [],
    });

    await executeAction(makeAction({
      actionType: "SEARCH_SONARR",
      mediaItem: {
        id: "item1", title: "Test Show", parentTitle: null, year: 2024,
        externalIds: [{ source: "TVDB", externalId: "67890" }],
      },
    }));

    expect(mockSonarrClient.triggerSeriesSearch).toHaveBeenCalledWith(2);
    expect(mockSonarrClient.updateSeries).not.toHaveBeenCalled();
    expect(mockSonarrClient.deleteEpisodeFiles).not.toHaveBeenCalled();
  });

  it("executes SEARCH_LIDARR — triggers an artist search", async () => {
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://lidarr", apiKey: "key", enabled: true,
    });
    mockLidarrClient.getArtistByMusicBrainzId.mockResolvedValue({
      id: 5, artistName: "Test Artist", foreignArtistId: "mb-123", tags: [],
    });

    await executeAction(makeAction({
      actionType: "SEARCH_LIDARR",
      mediaItem: {
        id: "item1", title: "Test Artist", parentTitle: null, year: null,
        externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-123" }],
      },
    }));

    expect(mockLidarrClient.triggerArtistSearch).toHaveBeenCalledWith(5);
    expect(mockLidarrClient.updateArtist).not.toHaveBeenCalled();
    expect(mockLidarrClient.deleteTrackFiles).not.toHaveBeenCalled();
  });

  it("throws on unknown action type", async () => {
    const action = makeAction({ actionType: "TOTALLY_INVALID" });
    await expect(executeAction(action)).rejects.toThrow("Unknown action type: TOTALLY_INVALID");
  });

  it("executes DELETE_RADARR action", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://radarr",
      apiKey: "key",
      enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1,
      title: "Test Movie",
      tmdbId: 12345,
      tags: [],
    });

    await executeAction(makeAction({ actionType: "DELETE_RADARR" }));

    expect(mockRadarrClient.deleteMovie).toHaveBeenCalledWith(1, true, false);
  });

  it("executes DELETE_SONARR action", async () => {
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://sonarr",
      apiKey: "key",
      enabled: true,
    });
    mockSonarrClient.getSeriesByTvdbId.mockResolvedValue({
      id: 2,
      title: "Test Show",
      tvdbId: 67890,
      tags: [],
    });

    const action = makeAction({
      actionType: "DELETE_SONARR",
      mediaItem: {
        id: "item1",
        title: "Test Show",
        parentTitle: null,
        year: 2024,
        externalIds: [{ source: "TVDB", externalId: "67890" }],
      },
    });

    await executeAction(action);

    expect(mockSonarrClient.deleteSeries).toHaveBeenCalledWith(2, true, false);
  });

  it("executes UNMONITOR_RADARR with import exclusion", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://radarr",
      apiKey: "key",
      enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1,
      title: "Test Movie",
      tmdbId: 12345,
      tags: [],
    });

    await executeAction(makeAction({ actionType: "UNMONITOR_RADARR", addImportExclusion: true }));

    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(1, { monitored: false });
    expect(mockRadarrClient.addExclusion).toHaveBeenCalledWith(12345, "Test Movie", 2024);
  });

  it("executes UNMONITOR_DELETE_FILES_RADARR with search after delete", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://radarr",
      apiKey: "key",
      enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1,
      title: "Test Movie",
      tmdbId: 12345,
      hasFile: true,
      movieFileId: 99,
      tags: [],
    });

    await executeAction(makeAction({
      actionType: "UNMONITOR_DELETE_FILES_RADARR",
      searchAfterAction: true,
    }));

    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(1, { monitored: false });
    expect(mockRadarrClient.deleteMovieFile).toHaveBeenCalledWith(99);
    expect(mockRadarrClient.triggerMovieSearch).toHaveBeenCalledWith(1);
  });

  it("executes DELETE_LIDARR action", async () => {
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://lidarr",
      apiKey: "key",
      enabled: true,
    });
    mockLidarrClient.getArtistByMusicBrainzId.mockResolvedValue({
      id: 5,
      artistName: "Test Artist",
      foreignArtistId: "mb-123",
      tags: [],
    });

    const action = makeAction({
      actionType: "DELETE_LIDARR",
      mediaItem: {
        id: "item1",
        title: "Test Artist",
        parentTitle: null,
        year: null,
        externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-123" }],
      },
    });

    await executeAction(action);

    expect(mockLidarrClient.deleteArtist).toHaveBeenCalledWith(5, true, false);
  });

  it("throws when arr instance is not configured", async () => {
    const action = makeAction({ arrInstanceId: null });
    await expect(executeAction(action)).rejects.toThrow("No Arr instance configured");
  });

  it("throws when arr instance is not found", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    await expect(executeAction(makeAction())).rejects.toThrow("Radarr instance not found");
  });

  it("throws when arr instance is disabled", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://radarr",
      apiKey: "key",
      enabled: false,
    });
    await expect(executeAction(makeAction())).rejects.toThrow("Radarr instance is disabled");
  });

  it("throws when external ID is missing", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://radarr",
      apiKey: "key",
      enabled: true,
    });
    const action = makeAction({
      mediaItem: { id: "item1", title: "Movie", parentTitle: null, year: null, externalIds: [] },
    });
    await expect(executeAction(action)).rejects.toThrow("No TMDB ID found for item");
  });

  it("executes tag operations before main action", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1",
      url: "http://radarr",
      apiKey: "key",
      enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1,
      title: "Test Movie",
      tmdbId: 12345,
      tags: [1],
    });
    mockRadarrClient.getTags.mockResolvedValue([{ id: 1, label: "existing" }]);
    mockRadarrClient.createTag.mockResolvedValue({ id: 2, label: "new-tag" });
    mockRadarrClient.updateMovie.mockResolvedValue({});

    await executeAction(makeAction({
      actionType: "DO_NOTHING",
      addArrTags: ["new-tag"],
      removeArrTags: ["existing"],
    }));

    expect(mockRadarrClient.createTag).toHaveBeenCalledWith("new-tag");
    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(1, { tags: [2] });
  });

  it("executes MONITOR_DELETE_FILES_RADARR — re-monitors then deletes files", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [],
      monitored: false, hasFile: true, movieFileId: 99,
    });

    await executeAction(makeAction({ actionType: "MONITOR_DELETE_FILES_RADARR" }));

    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(1, { monitored: true });
    expect(mockRadarrClient.deleteMovieFile).toHaveBeenCalledWith(99);
  });

  it("executes DELETE_FILES_RADARR — only deletes files, no monitor change", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [],
      monitored: true, hasFile: true, movieFileId: 99,
    });

    await executeAction(makeAction({ actionType: "DELETE_FILES_RADARR" }));

    // Should not update monitored status
    expect(mockRadarrClient.updateMovie).not.toHaveBeenCalled();
    expect(mockRadarrClient.deleteMovieFile).toHaveBeenCalledWith(99);
  });

  it("executes UNMONITOR_DELETE_FILES_SONARR with matched episode IDs", async () => {
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://sonarr", apiKey: "key", enabled: true,
    });
    mockSonarrClient.getSeriesByTvdbId.mockResolvedValue({
      id: 2, title: "Test Show", tvdbId: 67890, tags: [],
    });
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
    ]);
    mockSonarrClient.getEpisodes.mockResolvedValue([
      { seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
      { seasonNumber: 1, episodeNumber: 2, episodeFileId: 11 },
      { seasonNumber: 1, episodeNumber: 3, episodeFileId: 12 },
    ]);
    mockSonarrClient.deleteEpisodeFiles.mockResolvedValue(undefined);
    mockSonarrClient.updateSeries.mockResolvedValue({});

    const action = makeAction({
      actionType: "UNMONITOR_DELETE_FILES_SONARR",
      matchedMediaItemIds: ["ep1", "ep2"],
      mediaItem: {
        id: "item1", title: "Test Show", parentTitle: null, year: 2024,
        externalIds: [{ source: "TVDB", externalId: "67890" }],
      },
    });

    await executeAction(action);

    expect(mockSonarrClient.updateSeries).toHaveBeenCalledWith(2, { monitored: false });
    expect(mockSonarrClient.deleteEpisodeFiles).toHaveBeenCalledWith([10, 11]);
  });

  it("executes CHANGE_QUALITY_PROFILE_RADARR when current profile differs", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [], qualityProfileId: 3,
    });

    await executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: 7,
    }));

    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(1, { qualityProfileId: 7 });
    expect(mockRadarrClient.triggerMovieSearch).not.toHaveBeenCalled();
  });

  it("triggers a Radarr search after CHANGE_QUALITY_PROFILE_RADARR when searchAfterAction is true", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [], qualityProfileId: 3,
    });

    await executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: 7,
      searchAfterAction: true,
    }));

    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(1, { qualityProfileId: 7 });
    expect(mockRadarrClient.triggerMovieSearch).toHaveBeenCalledWith(1);
  });

  it("does NOT trigger a Radarr search when CHANGE_QUALITY_PROFILE_RADARR is skipped as no-op", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [], qualityProfileId: 7,
    });

    await executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: 7,
      searchAfterAction: true,
    }));

    expect(mockRadarrClient.updateMovie).not.toHaveBeenCalled();
    expect(mockRadarrClient.triggerMovieSearch).not.toHaveBeenCalled();
  });

  it("skips CHANGE_QUALITY_PROFILE_RADARR when item already on target profile", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [], qualityProfileId: 7,
    });

    await executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: 7,
    }));

    expect(mockRadarrClient.updateMovie).not.toHaveBeenCalled();
  });

  it("propagates Arr error from CHANGE_QUALITY_PROFILE_RADARR when the target profile was deleted on Arr", async () => {
    // Scheduled with a valid id, but the admin removed the profile from
    // Radarr before execution. Arr's PUT returns an error; we expect the
    // error to propagate so the action is recorded as FAILED (rather than
    // silently succeeding). The persistence of targetQualityProfileId on
    // the FAILED row is covered at the route level — here we just verify
    // the executor surfaces the underlying Arr error verbatim.
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    mockRadarrClient.getMovieByTmdbId.mockResolvedValue({
      id: 1, title: "Test Movie", tmdbId: 12345, tags: [], qualityProfileId: 3,
    });
    mockRadarrClient.updateMovie.mockRejectedValueOnce(
      new Error("Radarr 400: Quality profile with id 99 not found")
    );

    await expect(
      executeAction(makeAction({
        actionType: "CHANGE_QUALITY_PROFILE_RADARR",
        targetQualityProfileId: 99,
        searchAfterAction: true,
      }))
    ).rejects.toThrow(/profile.*99.*not found/i);

    // Search must NOT fire when the update itself failed.
    expect(mockRadarrClient.triggerMovieSearch).not.toHaveBeenCalled();
  });

  it("throws on CHANGE_QUALITY_PROFILE_RADARR without target profile", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://radarr", apiKey: "key", enabled: true,
    });
    await expect(executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_RADARR",
      targetQualityProfileId: null,
    }))).rejects.toThrow("No target quality profile configured");
  });

  it("executes CHANGE_QUALITY_PROFILE_SONARR when current profile differs", async () => {
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://sonarr", apiKey: "key", enabled: true,
    });
    mockSonarrClient.getSeriesByTvdbId.mockResolvedValue({
      id: 2, title: "Test Show", tvdbId: 67890, tags: [], qualityProfileId: 1,
    });

    const action = makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_SONARR",
      targetQualityProfileId: 4,
      mediaItem: {
        id: "item1", title: "Test Show", parentTitle: null, year: 2024,
        externalIds: [{ source: "TVDB", externalId: "67890" }],
      },
    });

    await executeAction(action);

    expect(mockSonarrClient.updateSeries).toHaveBeenCalledWith(2, { qualityProfileId: 4 });
    expect(mockSonarrClient.triggerSeriesSearch).not.toHaveBeenCalled();
  });

  it("triggers a Sonarr search after CHANGE_QUALITY_PROFILE_SONARR when searchAfterAction is true", async () => {
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://sonarr", apiKey: "key", enabled: true,
    });
    mockSonarrClient.getSeriesByTvdbId.mockResolvedValue({
      id: 2, title: "Test Show", tvdbId: 67890, tags: [], qualityProfileId: 1,
    });

    await executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_SONARR",
      targetQualityProfileId: 4,
      searchAfterAction: true,
      mediaItem: {
        id: "item1", title: "Test Show", parentTitle: null, year: 2024,
        externalIds: [{ source: "TVDB", externalId: "67890" }],
      },
    }));

    expect(mockSonarrClient.updateSeries).toHaveBeenCalledWith(2, { qualityProfileId: 4 });
    expect(mockSonarrClient.triggerSeriesSearch).toHaveBeenCalledWith(2);
  });

  it("skips CHANGE_QUALITY_PROFILE_SONARR when item already on target profile", async () => {
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://sonarr", apiKey: "key", enabled: true,
    });
    mockSonarrClient.getSeriesByTvdbId.mockResolvedValue({
      id: 2, title: "Test Show", tvdbId: 67890, tags: [], qualityProfileId: 4,
    });

    const action = makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_SONARR",
      targetQualityProfileId: 4,
      mediaItem: {
        id: "item1", title: "Test Show", parentTitle: null, year: 2024,
        externalIds: [{ source: "TVDB", externalId: "67890" }],
      },
    });

    await executeAction(action);

    expect(mockSonarrClient.updateSeries).not.toHaveBeenCalled();
  });

  it("executes CHANGE_QUALITY_PROFILE_LIDARR when current profile differs", async () => {
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://lidarr", apiKey: "key", enabled: true,
    });
    mockLidarrClient.getArtistByMusicBrainzId.mockResolvedValue({
      id: 5, artistName: "Test Artist", foreignArtistId: "mb-123", tags: [], qualityProfileId: 2,
    });

    const action = makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_LIDARR",
      targetQualityProfileId: 6,
      mediaItem: {
        id: "item1", title: "Test Artist", parentTitle: null, year: null,
        externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-123" }],
      },
    });

    await executeAction(action);

    expect(mockLidarrClient.updateArtist).toHaveBeenCalledWith(5, { qualityProfileId: 6 });
    expect(mockLidarrClient.triggerArtistSearch).not.toHaveBeenCalled();
  });

  it("triggers a Lidarr search after CHANGE_QUALITY_PROFILE_LIDARR when searchAfterAction is true", async () => {
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://lidarr", apiKey: "key", enabled: true,
    });
    mockLidarrClient.getArtistByMusicBrainzId.mockResolvedValue({
      id: 5, artistName: "Test Artist", foreignArtistId: "mb-123", tags: [], qualityProfileId: 2,
    });

    await executeAction(makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_LIDARR",
      targetQualityProfileId: 6,
      searchAfterAction: true,
      mediaItem: {
        id: "item1", title: "Test Artist", parentTitle: null, year: null,
        externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-123" }],
      },
    }));

    expect(mockLidarrClient.updateArtist).toHaveBeenCalledWith(5, { qualityProfileId: 6 });
    expect(mockLidarrClient.triggerArtistSearch).toHaveBeenCalledWith(5);
  });

  it("skips CHANGE_QUALITY_PROFILE_LIDARR when item already on target profile", async () => {
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue({
      id: "arr1", url: "http://lidarr", apiKey: "key", enabled: true,
    });
    mockLidarrClient.getArtistByMusicBrainzId.mockResolvedValue({
      id: 5, artistName: "Test Artist", foreignArtistId: "mb-123", tags: [], qualityProfileId: 6,
    });

    const action = makeAction({
      actionType: "CHANGE_QUALITY_PROFILE_LIDARR",
      targetQualityProfileId: 6,
      mediaItem: {
        id: "item1", title: "Test Artist", parentTitle: null, year: null,
        externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-123" }],
      },
    });

    await executeAction(action);

    expect(mockLidarrClient.updateArtist).not.toHaveBeenCalled();
  });
});

describe("cleanupArrTags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when tagLabels is empty", async () => {
    await cleanupArrTags("arr1", "MOVIE", []);
    expect(mockPrisma.radarrInstance.findUnique).not.toHaveBeenCalled();
  });

  it("removes tags from Radarr movies and deletes the tag", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue({
      url: "http://radarr",
      apiKey: "key",
    });
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue(null);
    mockRadarrClient.getTags.mockResolvedValue([
      { id: 1, label: "lifecycle" },
      { id: 2, label: "other" },
    ]);
    mockRadarrClient.getMovies.mockResolvedValue([
      { id: 10, tags: [1, 2] },
      { id: 11, tags: [2] },
    ]);
    mockRadarrClient.updateMovie.mockResolvedValue({});
    mockRadarrClient.deleteTag.mockResolvedValue(undefined);

    await cleanupArrTags("arr1", "MOVIE", ["lifecycle"]);

    // Movie 10 has tag 1 removed, movie 11 unaffected
    expect(mockRadarrClient.updateMovie).toHaveBeenCalledWith(10, { tags: [2] });
    expect(mockRadarrClient.updateMovie).toHaveBeenCalledTimes(1);
    expect(mockRadarrClient.deleteTag).toHaveBeenCalledWith(1);
  });

  it("throws when arr instance is not found", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue(null);

    await expect(cleanupArrTags("arr1", "MOVIE", ["tag"])).rejects.toThrow(
      "Arr instance not found",
    );
  });
});
