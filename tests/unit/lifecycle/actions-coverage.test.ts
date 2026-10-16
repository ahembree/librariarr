/**
 * Additional coverage for src/lib/lifecycle/actions.ts — the deletion-safety
 * branches the main actions.test.ts does not reach: Arr resolution refusals
 * (missing/disabled instance, missing id, wrong title/year), tag operations on
 * every Arr family, member-scoped deletes that must refuse rather than widen,
 * and the outcome reporting that `deletedBytes` is computed from.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findUnique: vi.fn() },
  sonarrInstance: { findUnique: vi.fn() },
  lidarrInstance: { findUnique: vi.fn() },
  mediaItem: { findMany: vi.fn() },
}));

const mockRadarr = vi.hoisted(() => ({
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
}));

const mockSonarr = vi.hoisted(() => ({
  getSeriesByTvdbId: vi.fn(),
  deleteSeries: vi.fn(),
  updateSeries: vi.fn(),
  addExclusion: vi.fn(),
  deleteEpisodeFiles: vi.fn(),
  getEpisodes: vi.fn(),
  triggerSeriesSearch: vi.fn(),
  triggerEpisodeSearch: vi.fn(),
  setEpisodesMonitored: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getSeries: vi.fn(),
}));

const mockLidarr = vi.hoisted(() => ({
  getArtistByMusicBrainzId: vi.fn(),
  deleteArtist: vi.fn(),
  updateArtist: vi.fn(),
  addExclusion: vi.fn(),
  getTracks: vi.fn(),
  getAlbums: vi.fn(),
  deleteTrackFiles: vi.fn(),
  triggerArtistSearch: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getArtists: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/lib/arr/radarr-client", () => ({ RadarrClient: function () { return mockRadarr; } }));
vi.mock("@/lib/arr/sonarr-client", () => ({ SonarrClient: function () { return mockSonarr; } }));
vi.mock("@/lib/arr/lidarr-client", () => ({ LidarrClient: function () { return mockLidarr; } }));

import {
  executeAction,
  describeActionError,
  extractActionError,
  cleanupArrTags,
  validateArrItem,
  normalizeTitle,
  type ActionRecord,
} from "@/lib/lifecycle/actions";

const enabled = (url: string) => ({ id: "arr1", url, apiKey: "key", enabled: true });

function movieAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: "a1",
    actionType: "DELETE_RADARR",
    arrInstanceId: "arr1",
    targetQualityProfileId: null,
    addImportExclusion: false,
    searchAfterAction: false,
    matchedMediaItemIds: [],
    addArrTags: [],
    removeArrTags: [],
    targetTitle: "Arrival",
    mediaItem: {
      id: "m1", title: "Arrival", parentTitle: null, year: 2016,
      externalIds: [{ source: "TMDB", externalId: "329865" }],
    },
    ...overrides,
  };
}

function showAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return movieAction({
    actionType: "DELETE_SONARR",
    targetTitle: "Severance",
    mediaItem: {
      id: "ep-rep", title: "Good News About Hell", parentTitle: "Severance", year: 2022,
      externalIds: [{ source: "TVDB", externalId: "371980" }],
    },
    ...overrides,
  });
}

function artistAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return movieAction({
    actionType: "DELETE_LIDARR",
    targetTitle: "Radiohead",
    mediaItem: {
      id: "t-rep", title: "Airbag", parentTitle: "Radiohead", year: null,
      externalIds: [{ source: "MUSICBRAINZ", externalId: "a74b1b7f" }],
    },
    ...overrides,
  });
}

const MOVIE = { id: 7, title: "Arrival", year: 2016, tmdbId: 329865, tags: [1], monitored: true, hasFile: true, movieFileId: 70, qualityProfileId: 1 };
const SERIES = { id: 2, title: "Severance", year: 2022, tvdbId: 371980, tags: [1], monitored: true, qualityProfileId: 1 };
const ARTIST = { id: 5, artistName: "Radiohead", foreignArtistId: "a74b1b7f", tags: [1], monitored: true, qualityProfileId: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.radarrInstance.findUnique.mockResolvedValue(enabled("http://radarr"));
  mockPrisma.sonarrInstance.findUnique.mockResolvedValue(enabled("http://sonarr"));
  mockPrisma.lidarrInstance.findUnique.mockResolvedValue(enabled("http://lidarr"));
  mockRadarr.getMovieByTmdbId.mockResolvedValue({ ...MOVIE });
  mockSonarr.getSeriesByTvdbId.mockResolvedValue({ ...SERIES });
  mockLidarr.getArtistByMusicBrainzId.mockResolvedValue({ ...ARTIST });
});

describe("describeActionError / extractActionError", () => {
  it("uses an IntegrationError's message when it carries no HTTP status", () => {
    const ie = Object.assign(new Error("connect ECONNREFUSED"), { name: "IntegrationError", status: null, detail: null });
    expect(describeActionError(ie)).toBe("connect ECONNREFUSED");
  });

  it("falls back to the IntegrationError message when the status has no detail", () => {
    const ie = Object.assign(new Error("Radarr returned 500"), { name: "IntegrationError", status: 500, detail: null });
    expect(describeActionError(ie)).toBe("HTTP 500: Radarr returned 500");
    expect(extractActionError(ie)).toBe("HTTP 500: Radarr returned 500");
  });

  it("returns 'Unknown error' for a plain object", () => {
    expect(describeActionError({ foo: 1 })).toBe("Unknown error");
  });
});

describe("validateArrItem", () => {
  it("refuses a remake whose release year is two or more years off, before comparing titles", () => {
    expect(() => validateArrItem("Dune", "Dune", "Radarr movie", "1", 1984, 2021)).toThrow(/year mismatch/);
  });

  it("allows a ±1 year release drift", () => {
    expect(() => validateArrItem("Dune", "Dune", "Radarr movie", "1", 2021, 2022)).not.toThrow();
  });

  it("ignores a zero year (unknown) on either side", () => {
    expect(() => validateArrItem("Dune", "Dune", "Radarr movie", "1", 0, 2021)).not.toThrow();
  });

  it("accepts a partial title match only when both titles are long enough and similar in length", () => {
    expect(() => validateArrItem("Agents of SHIELD", "Marvel's Agents of SHIELD", "Sonarr series", "1")).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Partial title match"));
    expect(() => validateArrItem("It", "It Follows", "Radarr movie", "1")).toThrow(/title mismatch/);
    expect(() => validateArrItem("Avatar", "Avatar The Way of Water", "Radarr movie", "1")).toThrow(/title mismatch/);
  });

  it("normalizes articles, years, ampersands and diacritics", () => {
    expect(normalizeTitle("Matrix, The")).toBe("matrix");
    expect(normalizeTitle("Fish & Chips (2024)")).toBe("fish and chips");
    expect(normalizeTitle("Abramović")).toBe("abramovic");
  });
});

describe("Arr resolution refusals", () => {
  it.each([
    ["Sonarr", showAction, mockPrisma.sonarrInstance.findUnique],
    ["Lidarr", artistAction, mockPrisma.lidarrInstance.findUnique],
  ])("%s: refuses with no instance configured, a missing instance, or a disabled one", async (_name, make, find) => {
    await expect(executeAction(make({ arrInstanceId: null }))).rejects.toThrow("No Arr instance configured");
    find.mockResolvedValueOnce(null);
    await expect(executeAction(make())).rejects.toThrow(/instance not found/);
    find.mockResolvedValueOnce({ id: "arr1", url: "u", apiKey: "k", enabled: false });
    await expect(executeAction(make())).rejects.toThrow(/instance is disabled/);
  });

  it("Sonarr: refuses without a TVDB id and when the series is not in Sonarr", async () => {
    const noId = showAction();
    noId.mediaItem.externalIds = [{ source: "TMDB", externalId: "1" }];
    await expect(executeAction(noId)).rejects.toThrow("No TVDB ID found for item");
    mockSonarr.getSeriesByTvdbId.mockResolvedValueOnce(null);
    await expect(executeAction(showAction())).rejects.toThrow("Series not found in Sonarr");
    expect(mockSonarr.deleteSeries).not.toHaveBeenCalled();
  });

  it("Lidarr: refuses without a MusicBrainz id, when the artist is missing, or titled differently", async () => {
    const noId = artistAction();
    noId.mediaItem.externalIds = [];
    await expect(executeAction(noId)).rejects.toThrow("No MusicBrainz ID found for item");
    mockLidarr.getArtistByMusicBrainzId.mockResolvedValueOnce(null);
    await expect(executeAction(artistAction())).rejects.toThrow("Artist not found in Lidarr");
    mockLidarr.getArtistByMusicBrainzId.mockResolvedValueOnce({ ...ARTIST, artistName: "Coldplay" });
    await expect(executeAction(artistAction())).rejects.toThrow(/title mismatch/);
    expect(mockLidarr.deleteArtist).not.toHaveBeenCalled();
  });

  it("Radarr: refuses when the movie is not in Radarr, or is a different-year remake", async () => {
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce(null);
    await expect(executeAction(movieAction())).rejects.toThrow("Movie not found in Radarr");
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, year: 1990 });
    await expect(executeAction(movieAction())).rejects.toThrow(/year mismatch/);
    expect(mockRadarr.deleteMovie).not.toHaveBeenCalled();
  });

  it("skips title validation when the action asks for it", async () => {
    mockLidarr.getArtistByMusicBrainzId.mockResolvedValueOnce({ ...ARTIST, artistName: "Totally Different" });
    await executeAction(artistAction({ skipTitleValidation: true }));
    expect(mockLidarr.deleteArtist).toHaveBeenCalledWith(5, true, false);
  });
});

describe("tag operations", () => {
  it("refuses tag ops with no Arr instance", async () => {
    await expect(executeAction(movieAction({ arrInstanceId: null, addArrTags: ["x"] })))
      .rejects.toThrow("No Arr instance configured for tag operations");
  });

  it("refuses tag ops on an action type it cannot attribute to an Arr app", async () => {
    await expect(executeAction(movieAction({ actionType: "SOMETHING_ELSE", addArrTags: ["x"] })))
      .rejects.toThrow("Unsupported actionType for tag operations: SOMETHING_ELSE");
  });

  it("DO_NOTHING resolves the Arr family from the instance — Sonarr", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([{ id: 1, label: "old" }, { id: 2, label: "Keep" }]);
    mockSonarr.createTag.mockResolvedValue({ id: 9, label: "new" });

    await executeAction(showAction({ actionType: "DO_NOTHING", addArrTags: ["keep", "new"], removeArrTags: ["OLD", "missing"] }));

    expect(mockSonarr.createTag).toHaveBeenCalledWith("new");
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { tags: [2, 9] });
  });

  it("DO_NOTHING resolves the Arr family from the instance — Lidarr", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue(null);
    mockLidarr.getTags.mockResolvedValue([{ id: 1, label: "old" }]);
    mockLidarr.createTag.mockResolvedValue({ id: 3, label: "fresh" });

    await executeAction(artistAction({ actionType: "DO_NOTHING", addArrTags: ["fresh"], removeArrTags: ["old"] }));

    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { tags: [3] });
  });

  it("DO_NOTHING with an instance no family owns throws", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findUnique.mockResolvedValue(null);
    await expect(executeAction(movieAction({ actionType: "DO_NOTHING", addArrTags: ["x"] })))
      .rejects.toThrow("Arr instance not found");
  });

  it("does not write when the tag set is unchanged (Radarr, Sonarr, Lidarr)", async () => {
    mockRadarr.getTags.mockResolvedValue([{ id: 1, label: "keep" }]);
    mockSonarr.getTags.mockResolvedValue([{ id: 1, label: "keep" }]);
    mockLidarr.getTags.mockResolvedValue([{ id: 1, label: "keep" }]);

    await executeAction(movieAction({ actionType: "SEARCH_RADARR", addArrTags: ["keep"], removeArrTags: ["absent"] }));
    await executeAction(showAction({ actionType: "SEARCH_SONARR", addArrTags: ["keep"] }));
    await executeAction(artistAction({ actionType: "SEARCH_LIDARR", addArrTags: ["Keep"] }));

    expect(mockRadarr.updateMovie).not.toHaveBeenCalled();
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
    expect(mockLidarr.updateArtist).not.toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).toHaveBeenCalledWith(7);
    expect(mockSonarr.triggerSeriesSearch).toHaveBeenCalledWith(2);
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
  });

  it("logs both added and removed tags and reports the step", async () => {
    mockRadarr.getTags.mockResolvedValue([{ id: 1, label: "a" }, { id: 2, label: "b" }]);
    const steps: string[] = [];
    await executeAction(movieAction({ actionType: "UNMONITOR_RADARR", addArrTags: ["b"], removeArrTags: ["a"] }), (s) => steps.push(s));
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { tags: [2] });
    expect(steps[0]).toBe("Updating tags");
    expect(mockLogger.info).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("+tags: b; -tags: a"));
  });
});

describe("cleanupArrTags", () => {
  it("returns early on Radarr when none of the labels exist", async () => {
    mockRadarr.getTags.mockResolvedValue([{ id: 1, label: "other" }]);
    await cleanupArrTags("arr1", "MOVIE", ["gone"]);
    expect(mockRadarr.getMovies).not.toHaveBeenCalled();
    expect(mockRadarr.deleteTag).not.toHaveBeenCalled();
  });

  it("strips the tag from every Sonarr series that carries it, then deletes it", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([{ id: 4, label: "Librariarr" }, { id: 5, label: "other" }]);
    mockSonarr.getSeries.mockResolvedValue([{ id: 1, tags: [4, 5] }, { id: 2, tags: [5] }]);

    await cleanupArrTags("arr1", "SERIES", ["librariarr"]);

    expect(mockSonarr.updateSeries).toHaveBeenCalledTimes(1);
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(1, { tags: [5] });
    expect(mockSonarr.deleteTag).toHaveBeenCalledWith(4);
  });

  it("returns early on Sonarr when none of the labels exist", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([]);
    await cleanupArrTags("arr1", "SERIES", ["x"]);
    expect(mockSonarr.getSeries).not.toHaveBeenCalled();
  });

  it("strips the tag from Lidarr artists, then deletes it", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue(null);
    mockLidarr.getTags.mockResolvedValue([{ id: 8, label: "cleanup" }]);
    mockLidarr.getArtists.mockResolvedValue([{ id: 1, tags: [8] }, { id: 2, tags: [] }]);

    await cleanupArrTags("arr1", "MUSIC", ["CLEANUP"]);

    expect(mockLidarr.updateArtist).toHaveBeenCalledTimes(1);
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(1, { tags: [] });
    expect(mockLidarr.deleteTag).toHaveBeenCalledWith(8);
  });

  it("returns early on Lidarr when none of the labels exist", async () => {
    mockPrisma.radarrInstance.findUnique.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findUnique.mockResolvedValue(null);
    mockLidarr.getTags.mockResolvedValue([]);
    await cleanupArrTags("arr1", "MUSIC", ["x"]);
    expect(mockLidarr.getArtists).not.toHaveBeenCalled();
  });
});

describe("whole-record and monitoring executors", () => {
  it("UNMONITOR_SONARR adds the exclusion by TVDB id", async () => {
    await executeAction(showAction({ actionType: "UNMONITOR_SONARR", addImportExclusion: true }));
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { monitored: false });
    expect(mockSonarr.addExclusion).toHaveBeenCalledWith(371980, "Severance");
  });

  it("UNMONITOR_SONARR without an exclusion leaves the exclusion list alone", async () => {
    await executeAction(showAction({ actionType: "UNMONITOR_SONARR" }));
    expect(mockSonarr.addExclusion).not.toHaveBeenCalled();
  });

  it("UNMONITOR_LIDARR adds the exclusion by foreign artist id", async () => {
    await executeAction(artistAction({ actionType: "UNMONITOR_LIDARR", addImportExclusion: true }));
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { monitored: false });
    expect(mockLidarr.addExclusion).toHaveBeenCalledWith("a74b1b7f", "Radiohead");
  });

  it("UNMONITOR_RADARR uses the item's year when Radarr has none, and 0 when neither does", async () => {
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, year: null });
    await executeAction(movieAction({ actionType: "UNMONITOR_RADARR", addImportExclusion: true }));
    expect(mockRadarr.addExclusion).toHaveBeenLastCalledWith(329865, "Arrival", 2016);

    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, year: null });
    const a = movieAction({ actionType: "UNMONITOR_RADARR", addImportExclusion: true });
    a.mediaItem.year = null;
    await executeAction(a);
    expect(mockRadarr.addExclusion).toHaveBeenLastCalledWith(329865, "Arrival", 0);
  });

  it("UNMONITOR_DELETE_FILES_RADARR skips the file delete when the movie has no file", async () => {
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, hasFile: false, movieFileId: 0 });
    await executeAction(movieAction({ actionType: "UNMONITOR_DELETE_FILES_RADARR", addImportExclusion: true }));
    expect(mockRadarr.deleteMovieFile).not.toHaveBeenCalled();
    expect(mockRadarr.addExclusion).toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).not.toHaveBeenCalled();
  });

  it("MONITOR_DELETE_FILES_RADARR re-monitors an unmonitored movie, excludes and searches", async () => {
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, monitored: false, hasFile: false });
    await executeAction(movieAction({ actionType: "MONITOR_DELETE_FILES_RADARR", addImportExclusion: true, searchAfterAction: true }));
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { monitored: true });
    expect(mockRadarr.deleteMovieFile).not.toHaveBeenCalled();
    expect(mockRadarr.addExclusion).toHaveBeenCalledWith(329865, "Arrival", 2016);
    expect(mockRadarr.triggerMovieSearch).toHaveBeenCalledWith(7);
  });

  it("DELETE_FILES_RADARR excludes, deletes the file and searches", async () => {
    await executeAction(movieAction({ actionType: "DELETE_FILES_RADARR", addImportExclusion: true, searchAfterAction: true }));
    expect(mockRadarr.deleteMovieFile).toHaveBeenCalledWith(70);
    expect(mockRadarr.updateMovie).not.toHaveBeenCalled();
    expect(mockRadarr.addExclusion).toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).toHaveBeenCalledWith(7);
    expect(mockLogger.info).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("(with import exclusion)"));
  });

  it("quality-profile changes on Sonarr and Lidarr refuse without a target profile, before resolving", async () => {
    await expect(executeAction(showAction({ actionType: "CHANGE_QUALITY_PROFILE_SONARR" }))).rejects.toThrow("No target quality profile configured");
    await expect(executeAction(artistAction({ actionType: "CHANGE_QUALITY_PROFILE_LIDARR" }))).rejects.toThrow("No target quality profile configured");
    expect(mockSonarr.getSeriesByTvdbId).not.toHaveBeenCalled();
    expect(mockLidarr.getArtistByMusicBrainzId).not.toHaveBeenCalled();
  });

  it("quality-profile change without searchAfterAction does not search", async () => {
    await executeAction(showAction({ actionType: "CHANGE_QUALITY_PROFILE_SONARR", targetQualityProfileId: 4 }));
    await executeAction(artistAction({ actionType: "CHANGE_QUALITY_PROFILE_LIDARR", targetQualityProfileId: 4 }));
    await executeAction(movieAction({ actionType: "CHANGE_QUALITY_PROFILE_RADARR", targetQualityProfileId: 4 }));
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { qualityProfileId: 4 });
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { qualityProfileId: 4 });
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { qualityProfileId: 4 });
    expect(mockSonarr.triggerSeriesSearch).not.toHaveBeenCalled();
    expect(mockLidarr.triggerArtistSearch).not.toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).not.toHaveBeenCalled();
  });
});

describe("Sonarr member-scoped file deletes", () => {
  it.each(["DELETE_FILES_SONARR", "UNMONITOR_DELETE_FILES_SONARR", "MONITOR_DELETE_FILES_SONARR"])(
    "%s with no matched episodes deletes NOTHING rather than the whole series",
    async (actionType) => {
      const outcome = await executeAction(showAction({ actionType, matchedMediaItemIds: [] }));
      expect(mockSonarr.getEpisodes).not.toHaveBeenCalled();
      expect(mockSonarr.deleteEpisodeFiles).not.toHaveBeenCalled();
      expect(mockSonarr.deleteSeries).not.toHaveBeenCalled();
      expect(outcome.deletedMemberIds).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("refusing to delete all episode files"));
    },
  );

  it("skips null-numbered, unresolved and date-contradicted episodes, and deletes only the rest", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "ok", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: new Date("2022-02-18T00:00:00Z") },
      { id: "nulls", seasonNumber: null, episodeNumber: 2, originallyAvailableAt: null },
      { id: "absent", seasonNumber: 9, episodeNumber: 9, originallyAvailableAt: null },
      { id: "reordered", seasonNumber: 1, episodeNumber: 3, originallyAvailableAt: new Date("2019-01-01T00:00:00Z") },
      { id: "nofile", seasonNumber: 1, episodeNumber: 4, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([
      { id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10, airDate: "2022-02-18" },
      { id: 503, seasonNumber: 1, episodeNumber: 3, episodeFileId: 12, airDate: "2022-03-04" },
      { id: 504, seasonNumber: 1, episodeNumber: 4, episodeFileId: 0, airDate: "not-a-date" },
    ]);

    const outcome = await executeAction(showAction({
      actionType: "DELETE_FILES_SONARR",
      matchedMediaItemIds: ["ok", "nulls", "absent", "reordered", "nofile", "gone-from-db"],
      addImportExclusion: true,
      searchAfterAction: true,
    }));

    expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Episode lookup mismatch"));
    expect(mockSonarr.deleteEpisodeFiles).toHaveBeenCalledWith([10]);
    expect(outcome.deletedMemberIds).toEqual(["ok"]);
    // The episode whose file is already gone is still searched.
    expect(mockSonarr.triggerEpisodeSearch).toHaveBeenCalledWith([501, 504]);
    expect(mockSonarr.addExclusion).toHaveBeenCalledWith(371980, "Severance");
  });

  it("deletes nothing (without throwing) when every matched episode is file-less", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([{ id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 0 }]);

    const outcome = await executeAction(showAction({ actionType: "MONITOR_DELETE_FILES_SONARR", matchedMediaItemIds: ["e1"] }));

    expect(mockSonarr.deleteEpisodeFiles).not.toHaveBeenCalled();
    expect(outcome.deletedMemberIds).toEqual([]);
    expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([501], true);
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled(); // series already monitored
  });

  it("MONITOR_DELETE_FILES_SONARR monitors an unmonitored series and adds an exclusion", async () => {
    mockSonarr.getSeriesByTvdbId.mockResolvedValueOnce({ ...SERIES, monitored: false });
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([{ id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 }]);

    await executeAction(showAction({ actionType: "MONITOR_DELETE_FILES_SONARR", matchedMediaItemIds: ["e1"], addImportExclusion: true }));

    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { monitored: true });
    expect(mockSonarr.addExclusion).toHaveBeenCalledWith(371980, "Severance");
    expect(mockSonarr.triggerEpisodeSearch).not.toHaveBeenCalled();
  });

  it("UNMONITOR_DELETE_FILES_SONARR adds the exclusion and reports matched episode count", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([{ id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 }]);

    await executeAction(showAction({ actionType: "UNMONITOR_DELETE_FILES_SONARR", matchedMediaItemIds: ["e1"], addImportExclusion: true }));

    expect(mockSonarr.addExclusion).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("1 matched episodes"));
  });
});

describe("Lidarr member-scoped file deletes", () => {
  const ALBUMS = [{ id: 10, title: "OK Computer" }, { id: 11, title: "Kid A" }, { id: 12, title: "Kid A" }];
  const track = (over: Record<string, unknown>) => ({
    id: "t1", albumTitle: "OK Computer", title: "Airbag", seasonNumber: 1, episodeNumber: 1, externalIds: [], ...over,
  });

  beforeEach(() => {
    mockLidarr.getAlbums.mockResolvedValue(ALBUMS);
  });

  it("skips (no throw, no delete) when none of the members is a stored track", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    const outcome = await executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["x"] }));
    expect(mockLidarr.getTracks).not.toHaveBeenCalled();
    expect(mockLidarr.deleteTrackFiles).not.toHaveBeenCalled();
    expect(mockLidarr.deleteArtist).not.toHaveBeenCalled();
    expect(outcome.deletedMemberIds).toEqual([]);
  });

  it("uses the action's own item as the member when no member list was recorded", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({ id: "t-rep" })]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1", mediumNumber: 1 },
    ]);
    const outcome = await executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: [] }));
    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["t-rep"] }, type: "MUSIC" },
    }));
    expect(outcome.deletedMemberIds).toEqual(["t-rep"]);
  });

  it("an MBID that names two Lidarr tracks resolves to none", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      track({ externalIds: [{ source: "MBID", externalId: "REC-1" }] }),
    ]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, foreignRecordingId: "rec-1" },
      { id: 2, albumId: 11, trackFileId: 102, title: "Airbag (Live)", hasFile: true, foreignTrackId: "rec-1" },
    ]);
    await expect(executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"] })))
      .rejects.toThrow(/None of the 1 matched track\(s\)/);
    expect(mockLidarr.deleteTrackFiles).not.toHaveBeenCalled();
  });

  it("an MBID with no Lidarr hit falls back to album + position", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      track({ externalIds: [{ source: "MUSICBRAINZ_TRACK", externalId: "nope" }] }),
    ]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1" },
    ]);
    const outcome = await executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"] }));
    expect(mockLidarr.deleteTrackFiles).toHaveBeenCalledWith([101]);
    expect(outcome.deletedMemberIds).toEqual(["t1"]);
  });

  it("an album title shared by two Lidarr albums is ambiguous, so nothing is deleted", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({ albumTitle: "Kid A", title: "Idioteque" })]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 11, trackFileId: 101, title: "Idioteque", hasFile: true, trackNumber: "1" },
    ]);
    await expect(executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"] })))
      .rejects.toThrow(/nothing was deleted/);
  });

  it("a track without a stored album or position falls back to exact title on the album", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({ albumTitle: null, episodeNumber: null })]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true },
    ]);
    // No album title → no album → unresolved.
    await expect(executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"] })))
      .rejects.toThrow(/nothing was deleted/);
  });

  it("never deletes a file that also backs an unmatched track, and returns without throwing", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({ episodeNumber: null })]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true },
      { id: 2, albumId: 10, trackFileId: 101, title: "Paranoid Android", hasFile: true },
      { id: 3, albumId: 10, trackFileId: 0, title: "No File", hasFile: false },
    ]);
    const outcome = await executeAction(artistAction({ actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"] }));
    expect(mockLidarr.deleteTrackFiles).not.toHaveBeenCalled();
    expect(outcome.deletedMemberIds).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("could not correlate any matched track"));
  });

  it("UNMONITOR_DELETE_FILES_LIDARR unmonitors, deletes, excludes and searches", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({})]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1", mediumNumber: 1 },
    ]);
    const outcome = await executeAction(artistAction({
      actionType: "UNMONITOR_DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"], addImportExclusion: true, searchAfterAction: true,
    }));
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { monitored: false });
    expect(mockLidarr.deleteTrackFiles).toHaveBeenCalledWith([101]);
    expect(mockLidarr.addExclusion).toHaveBeenCalledWith("a74b1b7f", "Radiohead");
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
    expect(outcome.deletedMemberIds).toEqual(["t1"]);
  });

  it("MONITOR_DELETE_FILES_LIDARR re-monitors an unmonitored artist, excludes and searches", async () => {
    mockLidarr.getArtistByMusicBrainzId.mockResolvedValueOnce({ ...ARTIST, monitored: false });
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({})]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1", mediumNumber: 1 },
    ]);
    await executeAction(artistAction({
      actionType: "MONITOR_DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"], addImportExclusion: true, searchAfterAction: true,
    }));
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { monitored: true });
    expect(mockLidarr.addExclusion).toHaveBeenCalled();
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
  });

  it("DELETE_FILES_LIDARR adds the exclusion and searches when asked", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({})]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1", mediumNumber: 1 },
    ]);
    await executeAction(artistAction({
      actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"], addImportExclusion: true, searchAfterAction: true,
    }));
    expect(mockLidarr.addExclusion).toHaveBeenCalled();
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
  });
});
