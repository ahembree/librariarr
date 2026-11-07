/**
 * Additional coverage for src/lib/lifecycle/actions.ts — the deletion-safety
 * branches the main actions.test.ts does not reach: Arr resolution refusals
 * (missing/disabled instance, missing id, wrong title/year), tag operations on
 * every Arr family, member-scoped deletes that must refuse rather than widen,
 * and the outcome reporting that `deletedBytes` is computed from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AxiosError } from "axios";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findFirst: vi.fn() },
  sonarrInstance: { findFirst: vi.fn() },
  lidarrInstance: { findFirst: vi.fn() },
  mediaItem: { findMany: vi.fn(), findUnique: vi.fn() },
  mediaItemExternalId: { findMany: vi.fn() },
  library: { findUnique: vi.fn() },
  lifecycleException: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
}));

const mockRadarr = vi.hoisted(() => ({
  getMovieByTmdbId: vi.fn(),
  getMovieById: vi.fn(),
  deleteMovie: vi.fn(),
  updateMovie: vi.fn(),
  deleteMovieFile: vi.fn(),
  triggerMovieSearch: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getMovies: vi.fn(),
  removeTagsFromMovies: vi.fn(),
}));

const mockSonarr = vi.hoisted(() => ({
  getSeriesByTvdbId: vi.fn(),
  deleteSeries: vi.fn(),
  updateSeries: vi.fn(),
  deleteEpisodeFiles: vi.fn(),
  getEpisodes: vi.fn(),
  triggerSeriesSearch: vi.fn(),
  triggerEpisodeSearch: vi.fn(),
  setEpisodesMonitored: vi.fn(),
  setSeasonsMonitored: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getSeries: vi.fn(),
  removeTagsFromSeries: vi.fn(),
}));

const mockLidarr = vi.hoisted(() => ({
  getArtistByMusicBrainzId: vi.fn(),
  deleteArtist: vi.fn(),
  updateArtist: vi.fn(),
  getTracks: vi.fn(),
  getAlbums: vi.fn(),
  deleteTrackFiles: vi.fn(),
  triggerArtistSearch: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getArtists: vi.fn(),
  removeTagsFromArtists: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/lib/arr/radarr-client", () => ({ RadarrClient: function () { return mockRadarr; } }));
vi.mock("@/lib/arr/sonarr-client", () => ({ SonarrClient: function () { return mockSonarr; } }));
vi.mock("@/lib/arr/lidarr-client", () => ({ LidarrClient: function () { return mockLidarr; } }));

import { IntegrationError } from "@/lib/integration-error";
import {
  ArrExecutionContext,
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
      externalIds: [{ source: "MUSICBRAINZ", externalId: "a74b1b7f-71a5-4011-9441-d0b5e4122711" }],
    },
    ...overrides,
  });
}

const MOVIE = { id: 7, title: "Arrival", year: 2016, tmdbId: 329865, tags: [1], monitored: true, hasFile: true, movieFileId: 70, qualityProfileId: 1 };
const SERIES = { id: 2, title: "Severance", year: 2022, tvdbId: 371980, tags: [1], monitored: true, qualityProfileId: 1 };
const ARTIST = { id: 5, artistName: "Radiohead", foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711", tags: [1], monitored: true, qualityProfileId: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.radarrInstance.findFirst.mockResolvedValue(enabled("http://radarr"));
  mockPrisma.sonarrInstance.findFirst.mockResolvedValue(enabled("http://sonarr"));
  mockPrisma.lidarrInstance.findFirst.mockResolvedValue(enabled("http://lidarr"));
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
    ["Sonarr", showAction, mockPrisma.sonarrInstance.findFirst],
    ["Lidarr", artistAction, mockPrisma.lidarrInstance.findFirst],
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
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([{ id: 1, label: "old" }, { id: 2, label: "Keep" }]);
    mockSonarr.createTag.mockResolvedValue({ id: 9, label: "new" });

    await executeAction(showAction({ actionType: "DO_NOTHING", addArrTags: ["keep", "new"], removeArrTags: ["OLD", "missing"] }));

    expect(mockSonarr.createTag).toHaveBeenCalledWith("new");
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { tags: [2, 9] }, expect.objectContaining({ id: 2 }));
  });

  it("DO_NOTHING resolves the Arr family from the instance — Lidarr", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockLidarr.getTags.mockResolvedValue([{ id: 1, label: "old" }]);
    mockLidarr.createTag.mockResolvedValue({ id: 3, label: "fresh" });

    await executeAction(artistAction({ actionType: "DO_NOTHING", addArrTags: ["fresh"], removeArrTags: ["old"] }));

    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { tags: [3] }, expect.objectContaining({ id: 5 }));
  });

  it("DO_NOTHING with an instance no family owns throws", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);
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
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { tags: [2] }, expect.objectContaining({ id: 7 }));
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
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([{ id: 4, label: "Librariarr" }, { id: 5, label: "other" }]);
    mockSonarr.getSeries.mockResolvedValue([{ id: 1, tags: [4, 5] }, { id: 2, tags: [5] }]);

    await cleanupArrTags("arr1", "SERIES", ["librariarr"]);

    // One bulk-editor request for the series carrying it, not a PUT per series.
    expect(mockSonarr.removeTagsFromSeries).toHaveBeenCalledTimes(1);
    expect(mockSonarr.removeTagsFromSeries).toHaveBeenCalledWith([1], [4]);
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
    expect(mockSonarr.deleteTag).toHaveBeenCalledWith(4);
  });

  it("returns early on Sonarr when none of the labels exist", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([]);
    await cleanupArrTags("arr1", "SERIES", ["x"]);
    expect(mockSonarr.getSeries).not.toHaveBeenCalled();
  });

  it("strips the tag from Lidarr artists, then deletes it", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockLidarr.getTags.mockResolvedValue([{ id: 8, label: "cleanup" }]);
    mockLidarr.getArtists.mockResolvedValue([{ id: 1, tags: [8] }, { id: 2, tags: [] }]);

    await cleanupArrTags("arr1", "MUSIC", ["CLEANUP"]);

    expect(mockLidarr.removeTagsFromArtists).toHaveBeenCalledWith([1], [8]);
    expect(mockLidarr.updateArtist).not.toHaveBeenCalled();
    expect(mockLidarr.deleteTag).toHaveBeenCalledWith(8);
  });

  it("returns early on Lidarr when none of the labels exist", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockLidarr.getTags.mockResolvedValue([]);
    await cleanupArrTags("arr1", "MUSIC", ["x"]);
    expect(mockLidarr.getArtists).not.toHaveBeenCalled();
  });
});

describe("whole-record and monitoring executors", () => {
  it("UNMONITOR_SONARR unmonitors the series", async () => {
    await executeAction(showAction({ actionType: "UNMONITOR_SONARR", addImportExclusion: true }));
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { monitored: false }, expect.objectContaining({ id: 2 }));
  });

  it("UNMONITOR_LIDARR unmonitors the artist", async () => {
    await executeAction(artistAction({ actionType: "UNMONITOR_LIDARR", addImportExclusion: true }));
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { monitored: false }, expect.objectContaining({ id: 5 }));
  });

  it("UNMONITOR_DELETE_FILES_RADARR skips the file delete when the movie has no file", async () => {
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, hasFile: false, movieFileId: 0 });
    await executeAction(movieAction({ actionType: "UNMONITOR_DELETE_FILES_RADARR", addImportExclusion: true }));
    expect(mockRadarr.deleteMovieFile).not.toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).not.toHaveBeenCalled();
  });

  it("MONITOR_DELETE_FILES_RADARR re-monitors an unmonitored movie and searches", async () => {
    mockRadarr.getMovieByTmdbId.mockResolvedValueOnce({ ...MOVIE, monitored: false, hasFile: false });
    await executeAction(movieAction({ actionType: "MONITOR_DELETE_FILES_RADARR", addImportExclusion: true, searchAfterAction: true }));
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { monitored: true }, expect.objectContaining({ id: 7 }));
    expect(mockRadarr.deleteMovieFile).not.toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).toHaveBeenCalledWith(7);
  });

  it("DELETE_FILES_RADARR deletes the file and searches, adding no exclusion", async () => {
    await executeAction(movieAction({ actionType: "DELETE_FILES_RADARR", addImportExclusion: true, searchAfterAction: true }));
    expect(mockRadarr.deleteMovieFile).toHaveBeenCalledWith(70);
    expect(mockRadarr.updateMovie).not.toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).toHaveBeenCalledWith(7);
    // Only a whole-record delete adds an import exclusion.
    expect(mockLogger.info).not.toHaveBeenCalledWith("Lifecycle", expect.stringContaining("(with import exclusion)"));
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
    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { qualityProfileId: 4 }, expect.objectContaining({ id: 2 }));
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { qualityProfileId: 4 }, expect.objectContaining({ id: 5 }));
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { qualityProfileId: 4 }, expect.objectContaining({ id: 7 }));
    expect(mockSonarr.triggerSeriesSearch).not.toHaveBeenCalled();
    expect(mockLidarr.triggerArtistSearch).not.toHaveBeenCalled();
    expect(mockRadarr.triggerMovieSearch).not.toHaveBeenCalled();
  });
});

/** An episode row as the library holds it. */
interface LibraryEpisode {
  id: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  originallyAvailableAt: Date | null;
  libraryId?: string;
  seriesKey?: string | null;
  parentTitle?: string | null;
  dedupKey?: string | null;
}

/**
 * Serve `mediaItem.findMany` from one library: a lookup by id answers the
 * members, a lookup by library and season answers the season's episodes
 * (`fullyMatchedSeasons`).
 */
function serveLibrary(episodes: LibraryEpisode[]) {
  const rows = episodes.map((e) => ({
    libraryId: "lib1", seriesKey: "tvdb:371980", parentTitle: "Severance", dedupKey: null, externalIds: [], ...e,
  }));
  mockPrisma.mediaItem.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.seasonNumber) {
      const seasons = (where.seasonNumber as { in: number[] }).in;
      const [keyed] = where.OR as [{ seriesKey: { in: string[] } }, { seriesKey: null }];
      return rows.filter((r) => (r.seriesKey === null || keyed.seriesKey.in.includes(r.seriesKey)) && seasons.includes(r.seasonNumber as number));
    }
    const ids = (where.id as { in: string[] }).in;
    return rows.filter((r) => ids.includes(r.id));
  });
  mockPrisma.mediaItemExternalId.findMany.mockResolvedValue([]);
  mockPrisma.library.findUnique.mockResolvedValue({ mediaServer: { userId: "u1" } });
  mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
}

describe("episode-scoped Sonarr Unmonitor and Search (Query page episode view)", () => {
  beforeEach(() => {
    serveLibrary([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
      { id: "e2", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([
      { id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
      { id: 502, seasonNumber: 1, episodeNumber: 2, episodeFileId: 11 },
    ]);
  });

  it("UNMONITOR_SONARR unmonitors only the selected episodes, not the series", async () => {
    await executeAction(showAction({ actionType: "UNMONITOR_SONARR", episodeScope: true, matchedMediaItemIds: ["e2"] }));
    expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([502], false);
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
  });

  it("SEARCH_SONARR searches only the selected episodes, not the series", async () => {
    await executeAction(showAction({ actionType: "SEARCH_SONARR", episodeScope: true, matchedMediaItemIds: ["e2"] }));
    expect(mockSonarr.triggerEpisodeSearch).toHaveBeenCalledWith([502]);
    expect(mockSonarr.triggerSeriesSearch).not.toHaveBeenCalled();
  });

  it("with no members recorded, acts on the action's own episode", async () => {
    serveLibrary([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
      { id: "ep-rep", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: null },
    ]);
    await executeAction(showAction({ actionType: "UNMONITOR_SONARR", episodeScope: true, matchedMediaItemIds: [] }));
    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["ep-rep"] } } }));
    expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([502], false);
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
  });

  it("acts on the episodes that resolve and warns about the rest", async () => {
    serveLibrary([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
      { id: "e2", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: null },
      { id: "e9", seasonNumber: 9, episodeNumber: 9, originallyAvailableAt: null },
    ]);
    await executeAction(showAction({ actionType: "UNMONITOR_SONARR", episodeScope: true, matchedMediaItemIds: ["e2", "e9", "gone"] }));
    expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([502], false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Lifecycle",
      expect.stringMatching(/acting on 1 of 3 episode\(s\) — 1 could not be matched .*, 1 are no longer in the library/),
    );
  });

  it("says the episodes are gone when none is in the library any more", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    await expect(
      executeAction(showAction({ actionType: "SEARCH_SONARR", episodeScope: true, matchedMediaItemIds: ["gone"] })),
    ).rejects.toThrow("are in the library any more");
    expect(mockSonarr.triggerEpisodeSearch).not.toHaveBeenCalled();
    expect(mockSonarr.triggerSeriesSearch).not.toHaveBeenCalled();
  });

  describe("whole seasons (criteria that decide per season)", () => {
    const SEASONS = [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
      { seasonNumber: 3, monitored: true },
    ];
    beforeEach(() => {
      // The library holds S01E01, S01E02 and S02E01; Sonarr also knows S01E03
      // (never downloaded) and S02E02, S03E01.
      serveLibrary([
        { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
        { id: "e2", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: null },
        { id: "s2e1", seasonNumber: 2, episodeNumber: 1, originallyAvailableAt: null },
      ]);
      mockSonarr.getSeriesByTvdbId.mockResolvedValue({ ...SERIES, seasons: SEASONS });
      mockSonarr.getEpisodes.mockResolvedValue([
        { id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
        { id: 502, seasonNumber: 1, episodeNumber: 2, episodeFileId: 11 },
        { id: 503, seasonNumber: 1, episodeNumber: 3, episodeFileId: 0 },
        { id: 601, seasonNumber: 2, episodeNumber: 1, episodeFileId: 12 },
        { id: 602, seasonNumber: 2, episodeNumber: 2, episodeFileId: 0 },
        { id: 701, seasonNumber: 3, episodeNumber: 1, episodeFileId: 0 },
      ]);
    });

    it("unmonitors the season and all its episodes, missing ones included, never the series", async () => {
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "selected", matchedMediaItemIds: ["e1", "e2"],
      }));
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([501, 502, 503], false);
      // The season flag through the season pass: no series PUT to refuse it.
      expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(2, [1], false);
      expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Lifecycle",
        expect.stringContaining("unmonitored season(s) 1 of Sonarr series \"Severance\" whole — 1 Sonarr episode(s) besides the 2 acted on"),
      );
    });

    it("unmonitors only the matched episodes without a season scope (criteria of one episode, e.g. watched)", async () => {
      await executeAction(showAction({ actionType: "UNMONITOR_SONARR", episodeScope: true, matchedMediaItemIds: ["e1", "e2"] }));
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([501, 502], false);
      expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
    });

    it("selected: leaves a season with an unselected held episode monitored", async () => {
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "selected", matchedMediaItemIds: ["e2", "s2e1"],
      }));
      expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(2, [2], false);
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([502, 601, 602], false);
    });

    it("selected: a member's copy on another server covers the season's episode", async () => {
      serveLibrary([
        { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null, dedupKey: "k1" },
        { id: "e1-copy", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null, dedupKey: "k1" },
        { id: "e2", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: null },
      ]);
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "selected", matchedMediaItemIds: ["e1", "e2"],
      }));
      expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(2, [1], false);
    });

    it("matched: judges the season by the rule's criteria, not by the members an earlier action left", async () => {
      // Coverage narrowed the action to E02 (E01 was acted on before): the
      // season's criteria match E01 too, so the season goes whole.
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "matched", matchedMediaItemIds: ["e2"],
      }));
      expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(2, [1], false);
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([502, 501, 503], false);
    });

    it("matched: an excepted episode keeps its season monitored", async () => {
      mockPrisma.lifecycleException.findMany.mockResolvedValue([{ mediaItemId: "e1", mediaItem: { dedupKey: null } }]);
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "matched", matchedMediaItemIds: ["e2"],
      }));
      expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([502], false);
    });

    it("leaves a season whole-alone when one of its members did not resolve in Sonarr (numbered differently)", async () => {
      serveLibrary([
        { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
        // Sonarr's S01E02 aired years earlier: the two number the show differently.
        { id: "e2", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: new Date("2030-01-01T00:00:00Z") },
      ]);
      mockSonarr.getEpisodes.mockResolvedValue([
        { id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
        { id: 502, seasonNumber: 1, episodeNumber: 2, episodeFileId: 11, airDate: "2010-01-01" },
        { id: 503, seasonNumber: 1, episodeNumber: 3, episodeFileId: 0 },
      ]);
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "selected", matchedMediaItemIds: ["e1", "e2"],
      }));
      expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([501], false);
    });

    it("keys a member that predates seriesKey from its title, as its siblings", async () => {
      serveLibrary([
        { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null, seriesKey: null, parentTitle: " Severance " },
        { id: "e2", seasonNumber: 1, episodeNumber: 2, originallyAvailableAt: null, seriesKey: "title:severance" },
        { id: "e3", seasonNumber: 1, episodeNumber: 3, originallyAvailableAt: null, seriesKey: null, parentTitle: "SEVERANCE" },
      ]);
      await executeAction(showAction({
        actionType: "UNMONITOR_SONARR", episodeScope: true, seasonScope: "selected", matchedMediaItemIds: ["e1", "e2"],
      }));
      // E03 belongs to the same show and was not selected: the season stays.
      expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([501, 502], false);
    });

    it("UNMONITOR_DELETE_FILES_SONARR unmonitors the matched seasons, then deletes only the matched files, resolving them once", async () => {
      const outcome = await executeAction(showAction({
        actionType: "UNMONITOR_DELETE_FILES_SONARR", episodeScope: true, seasonScope: "matched", matchedMediaItemIds: ["e1", "e2"],
      }));
      expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
      expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(2, [1], false);
      expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([501, 502, 503], false);
      expect(mockSonarr.deleteEpisodeFiles).toHaveBeenCalledWith([10, 11]);
      expect(outcome.deletedMemberIds).toEqual(["e1", "e2"]);
      expect(mockSonarr.deleteSeries).not.toHaveBeenCalled();
      expect(mockSonarr.getEpisodes).toHaveBeenCalledTimes(1);
    });

    it("UNMONITOR_DELETE_FILES_SONARR episode-scoped with no members changes nothing, and says so", async () => {
      const outcome = await executeAction(showAction({
        actionType: "UNMONITOR_DELETE_FILES_SONARR", episodeScope: true, seasonScope: "matched", matchedMediaItemIds: [],
      }));
      expect(outcome.deletedMemberIds).toEqual([]);
      expect(outcome.notActedOn).toEqual([
        { title: "Severance", reason: "No matched episodes left to act on — nothing was unmonitored or deleted" },
      ]);
      expect(mockSonarr.setEpisodesMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
      expect(mockSonarr.deleteEpisodeFiles).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("refusing to unmonitor or delete without them"));
    });

    it("UNMONITOR_DELETE_FILES_SONARR without episode scope still unmonitors the series", async () => {
      await executeAction(showAction({ actionType: "UNMONITOR_DELETE_FILES_SONARR", matchedMediaItemIds: ["e1", "e2"] }));
      expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { monitored: false }, expect.objectContaining({ id: 2 }));
      expect(mockSonarr.setEpisodesMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
      expect(mockSonarr.deleteEpisodeFiles).toHaveBeenCalledWith([10, 11]);
    });
  });

  it("throws rather than widening to the series when no selected episode resolves in Sonarr", async () => {
    mockSonarr.getEpisodes.mockResolvedValue([{ id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 }]);
    await expect(
      executeAction(showAction({ actionType: "UNMONITOR_SONARR", episodeScope: true, matchedMediaItemIds: ["e2"] })),
    ).rejects.toThrow("nothing was changed");
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
    expect(mockSonarr.triggerSeriesSearch).not.toHaveBeenCalled();
    expect(mockSonarr.setEpisodesMonitored).not.toHaveBeenCalled();
  });
});

describe("a file delete the app outlives (recycle bin on another mount)", () => {
  /** The client's timeout on a delete, as `createIntegrationHttp` reports it. */
  const timedOut = (app: string, url: string) =>
    new IntegrationError(app, {
      isAxiosError: true, name: "AxiosError", message: "timeout", code: "ECONNABORTED",
      config: { url, method: "delete" }, toJSON: () => ({}),
    } as unknown as AxiosError);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Sonarr: deletes a long show's files a chunk at a time and confirms the one that timed out", async () => {
    const episodes = Array.from({ length: 30 }, (_, i) => ({
      id: `e${i + 1}`, seasonNumber: 1, episodeNumber: i + 1, originallyAvailableAt: null,
    }));
    mockPrisma.mediaItem.findMany.mockResolvedValue(episodes);
    const sonarrEpisodes = episodes.map((e, i) => ({ id: 500 + i, seasonNumber: 1, episodeNumber: i + 1, episodeFileId: 1000 + i }));
    mockSonarr.getEpisodes.mockResolvedValueOnce(sonarrEpisodes);
    // The first chunk outlives the request; Sonarr has removed its files by the first look.
    mockSonarr.deleteEpisodeFiles.mockRejectedValueOnce(timedOut("Sonarr", "/api/v3/episodefile/bulk"));
    mockSonarr.getEpisodes.mockResolvedValueOnce(sonarrEpisodes.map((ep, i) => (i < 25 ? { ...ep, episodeFileId: 0 } : ep)));

    const onStep = vi.fn();
    const run = executeAction(
      showAction({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: episodes.map((e) => e.id) }),
      onStep,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await run;

    expect(mockSonarr.deleteEpisodeFiles.mock.calls.map(([ids]) => ids.length)).toEqual([25, 5]);
    expect(outcome.deletedMemberIds).toHaveLength(30);
    // The progress bar moves with the files, and says when it waits on Sonarr.
    expect(onStep.mock.calls).toEqual([
      ["Delete Files Only (Sonarr)"],
      ["Delete Files Only (Sonarr) — 0 of 30 files deleted", 0],
      ["Delete Files Only (Sonarr) — waiting for Sonarr to finish deleting (0 of 30 files deleted)", 0],
      ["Delete Files Only (Sonarr) — 25 of 30 files deleted", 25 / 30],
      ["Delete Files Only (Sonarr) — 30 of 30 files deleted", 1],
    ]);
  });

  it("Radarr: confirms a movie file delete that timed out by reading the movie back", async () => {
    mockRadarr.deleteMovieFile.mockRejectedValueOnce(timedOut("Radarr", "/api/v3/moviefile/70"));
    mockRadarr.getMovieById.mockResolvedValue({ ...MOVIE, hasFile: false, movieFileId: 0 });

    const run = executeAction(movieAction({ actionType: "DELETE_FILES_RADARR" }));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run).resolves.toBeDefined();
    expect(mockRadarr.deleteMovieFile).toHaveBeenCalledTimes(1);
    expect(mockRadarr.getMovieById).toHaveBeenCalledWith(7);
  });

  it("fails, never re-sending the delete, when the file is still there after the wait", async () => {
    mockRadarr.deleteMovieFile.mockRejectedValueOnce(timedOut("Radarr", "/api/v3/moviefile/70"));
    mockRadarr.getMovieById.mockResolvedValue({ ...MOVIE });

    const run = executeAction(movieAction({ actionType: "DELETE_FILES_RADARR" }));
    const failed = expect(run).rejects.toThrow(/^Radarr stopped deleting with 1 of 1 movie file/);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await failed;
    expect(mockRadarr.deleteMovieFile).toHaveBeenCalledTimes(1);
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
      // It ran but changed nothing: the run must not read as a clean success.
      expect(outcome.notActedOn).toEqual([expect.objectContaining({ reason: expect.stringMatching(/^No matched episodes left to act on/) })]);
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
  });

  it("matches an episode whose air dates disagree when both sources give it the same real title", async () => {
    // A week apart (a pre-emption), same episode: the title settles it.
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e10", title: "Going Down With the Ship", parentTitle: "Survivor", seasonNumber: 15, episodeNumber: 10, originallyAvailableAt: new Date("2007-11-29T00:00:00Z") },
      { id: "e11", title: "The Unhappy Tribe", parentTitle: "Survivor", seasonNumber: 15, episodeNumber: 11, originallyAvailableAt: new Date("2007-12-06T00:00:00Z") },
      // A placeholder title proves nothing.
      { id: "e12", title: "Episode 12", parentTitle: "Survivor", seasonNumber: 15, episodeNumber: 12, originallyAvailableAt: new Date("2007-12-13T00:00:00Z") },
      { id: "e13", title: "Untitled", parentTitle: "Survivor", seasonNumber: 15, episodeNumber: 13, originallyAvailableAt: new Date("2007-12-16T00:00:00Z") },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([
      { id: 1510, seasonNumber: 15, episodeNumber: 10, episodeFileId: 10, airDate: "2007-11-22", title: "Going Down with the Ship!" },
      { id: 1511, seasonNumber: 15, episodeNumber: 11, episodeFileId: 11, airDate: "2007-11-29", title: "Another Episode Entirely" },
      { id: 1512, seasonNumber: 15, episodeNumber: 12, episodeFileId: 12, airDate: "2007-12-06", title: "Episode 12" },
      { id: 1513, seasonNumber: 15, episodeNumber: 13, episodeFileId: 13, airDate: "2007-12-13", title: "Untitled" },
    ]);

    const outcome = await executeAction(showAction({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["e10", "e11", "e12", "e13"] }));

    expect(mockSonarr.deleteEpisodeFiles).toHaveBeenCalledWith([10]);
    expect(outcome.deletedMemberIds).toEqual(["e10"]);
    expect(mockLogger.info).toHaveBeenCalledWith("Lifecycle", expect.stringContaining('Matching S15E10 of Sonarr series 2 by its title "Going Down With the Ship"'));
    expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining('Skipping S15E11 of Sonarr series 2: the media server\'s air date (2007-12-06) does not match Sonarr\'s (2007-11-29), and the titles ("The Unhappy Tribe" / "Another Episode Entirely")'));
    expect(mockLogger.warn).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Skipping S15E12"));
    // The action ran; the two it left alone are reported with their reasons.
    expect(outcome.notActedOn).toEqual([
      {
        title: "Survivor S15E11",
        reason: expect.stringMatching(/^The media server and Sonarr may number this show differently: the air dates differ \(2007-12-06 \/ 2007-11-29\) and the titles do not match \("The Unhappy Tribe" \/ "Another Episode Entirely"\)$/),
      },
      { title: "Survivor S15E12", reason: expect.stringContaining("may number this show differently") },
      { title: "Survivor S15E13", reason: expect.stringContaining("may number this show differently") },
    ]);
  });

  it("reports the episodes it left alone: gone from the library, unnumbered, missing in Sonarr, or sharing a file", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "a", title: "A", parentTitle: "Severance", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
      { id: "b", title: "B", parentTitle: "Severance", seasonNumber: null, episodeNumber: null, originallyAvailableAt: null },
      { id: "c", title: "C", parentTitle: "Severance", seasonNumber: 9, episodeNumber: 9, originallyAvailableAt: null },
    ]);
    // S01E01 shares its file with S01E02, which did not match.
    mockSonarr.getEpisodes.mockResolvedValue([
      { id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
      { id: 502, seasonNumber: 1, episodeNumber: 2, episodeFileId: 10 },
    ]);

    const outcome = await executeAction(showAction({ actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["a", "b", "c", "gone"] }));

    expect(mockSonarr.deleteEpisodeFiles).not.toHaveBeenCalled();
    expect(outcome.notActedOn).toEqual([
      { title: "Severance — 1 episode", reason: "No longer in the library (removed since the action was scheduled)" },
      { title: "Severance — B", reason: "The media server gives it no season or episode number" },
      { title: "Severance S09E09", reason: "Sonarr has no S09E09 for this series" },
      { title: "Severance S01E01", reason: "Its file also holds S01E02, which did not match — the file was kept" },
    ]);
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

  it("MONITOR_DELETE_FILES_SONARR monitors an unmonitored series", async () => {
    mockSonarr.getSeriesByTvdbId.mockResolvedValueOnce({ ...SERIES, monitored: false });
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([{ id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 }]);

    await executeAction(showAction({ actionType: "MONITOR_DELETE_FILES_SONARR", matchedMediaItemIds: ["e1"], addImportExclusion: true }));

    expect(mockSonarr.updateSeries).toHaveBeenCalledWith(2, { monitored: true }, expect.objectContaining({ id: 2 }));
    expect(mockSonarr.triggerEpisodeSearch).not.toHaveBeenCalled();
  });

  it("UNMONITOR_DELETE_FILES_SONARR reports matched episode count", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e1", seasonNumber: 1, episodeNumber: 1, originallyAvailableAt: null },
    ]);
    mockSonarr.getEpisodes.mockResolvedValue([{ id: 501, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 }]);

    await executeAction(showAction({ actionType: "UNMONITOR_DELETE_FILES_SONARR", matchedMediaItemIds: ["e1"], addImportExclusion: true }));

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

  it("leaves a track with no stored album title unresolved, though Lidarr has its title", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({ albumTitle: null, episodeNumber: null })]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true },
    ]);
    // No album title → no album → unresolved: a title alone is never matched across albums.
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
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { monitored: false }, expect.objectContaining({ id: 5 }));
    expect(mockLidarr.deleteTrackFiles).toHaveBeenCalledWith([101]);
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
    expect(outcome.deletedMemberIds).toEqual(["t1"]);
  });

  it("MONITOR_DELETE_FILES_LIDARR re-monitors an unmonitored artist and searches", async () => {
    mockLidarr.getArtistByMusicBrainzId.mockResolvedValueOnce({ ...ARTIST, monitored: false });
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({})]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1", mediumNumber: 1 },
    ]);
    await executeAction(artistAction({
      actionType: "MONITOR_DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"], addImportExclusion: true, searchAfterAction: true,
    }));
    expect(mockLidarr.updateArtist).toHaveBeenCalledWith(5, { monitored: true }, expect.objectContaining({ id: 5 }));
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
  });

  it("DELETE_FILES_LIDARR searches when asked", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([track({})]);
    mockLidarr.getTracks.mockResolvedValue([
      { id: 1, albumId: 10, trackFileId: 101, title: "Airbag", hasFile: true, trackNumber: "1", mediumNumber: 1 },
    ]);
    await executeAction(artistAction({
      actionType: "DELETE_FILES_LIDARR", matchedMediaItemIds: ["t1"], addImportExclusion: true, searchAfterAction: true,
    }));
    expect(mockLidarr.triggerArtistSearch).toHaveBeenCalledWith(5);
  });
});

describe("one record per action, one tag list per run", () => {
  it("resolves the record once for the tags and the main action, and PUTs the tags it wrote", async () => {
    mockRadarr.getTags.mockResolvedValue([{ id: 1, label: "old" }, { id: 2, label: "keep" }]);
    mockRadarr.updateMovie.mockImplementation(async (_id: number, patch: object, current: object) => ({ ...current, ...patch }));

    await executeAction(movieAction({ actionType: "UNMONITOR_RADARR", addArrTags: ["keep"], removeArrTags: ["old"] }));

    expect(mockRadarr.getMovieByTmdbId).toHaveBeenCalledTimes(1);
    expect(mockRadarr.updateMovie).toHaveBeenCalledTimes(2);
    expect(mockRadarr.updateMovie.mock.calls[0][1]).toEqual({ tags: [2] });
    // The unmonitor PUT goes over the record the tag PUT left, so it keeps the new tags.
    expect(mockRadarr.updateMovie.mock.calls[1][2]).toMatchObject({ tags: [2] });
    expect(mockRadarr.updateMovie.mock.calls[1][1]).toEqual({ monitored: false });
  });

  it("keeps the record as sent when the PUT answers with less than a record", async () => {
    mockRadarr.getTags.mockResolvedValue([{ id: 2, label: "keep" }]);
    mockRadarr.updateMovie.mockResolvedValue({});
    await executeAction(movieAction({ actionType: "UNMONITOR_RADARR", addArrTags: ["keep"] }));
    expect(mockRadarr.updateMovie.mock.calls[1][2]).toMatchObject({ id: 7, tags: [1, 2] });
  });

  it("reads each instance's tags and family once per run, remembering a tag it created", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);
    mockSonarr.getTags.mockResolvedValue([]);
    mockSonarr.createTag.mockResolvedValue({ id: 9, label: "leaving" });
    mockSonarr.updateSeries.mockImplementation(async (_id: number, patch: object, current: object) => ({ ...current, ...patch }));
    const ctx = new ArrExecutionContext();
    const tagOnly = showAction({ actionType: "DO_NOTHING", addArrTags: ["leaving"] });

    await executeAction(tagOnly, undefined, ctx);
    await executeAction(tagOnly, undefined, ctx);

    expect(mockSonarr.getTags).toHaveBeenCalledTimes(1);
    expect(mockSonarr.createTag).toHaveBeenCalledTimes(1);
    expect(mockSonarr.updateSeries).toHaveBeenLastCalledWith(2, { tags: [1, 9] }, expect.objectContaining({ id: 2 }));
    // The family probe ran once; the instance row is still read per action.
    expect(mockPrisma.radarrInstance.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.sonarrInstance.findFirst).toHaveBeenCalledTimes(3);
  });

  it("asks for the tags again after a failed read", async () => {
    mockRadarr.getTags.mockRejectedValueOnce(new Error("Radarr 500")).mockResolvedValue([{ id: 2, label: "keep" }]);
    mockRadarr.updateMovie.mockResolvedValue({ ...MOVIE });
    const ctx = new ArrExecutionContext();
    const action = movieAction({ actionType: "DO_NOTHING", addArrTags: ["keep"] });
    await expect(executeAction(action, undefined, ctx)).rejects.toThrow("Radarr 500");
    await executeAction(action, undefined, ctx);
    expect(mockRadarr.getTags).toHaveBeenCalledTimes(2);
  });

  it("stops acting on an instance disabled mid-run", async () => {
    const ctx = new ArrExecutionContext();
    await executeAction(movieAction({ actionType: "SEARCH_RADARR" }), undefined, ctx);
    mockPrisma.radarrInstance.findFirst.mockResolvedValue({ ...enabled("http://radarr"), enabled: false });
    await expect(executeAction(movieAction({ actionType: "SEARCH_RADARR" }), undefined, ctx)).rejects.toThrow(
      "Radarr instance is disabled",
    );
  });
});
