import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
  createTestRadarrInstance,
  createTestSonarrInstance,
  createTestLidarrInstance,
} from "../../setup/test-helpers";

const m = vi.hoisted(() => ({
  radarrMovie: vi.fn(),
  radarrProfiles: vi.fn(),
  radarrTags: vi.fn(),
  sonarrSeries: vi.fn(),
  sonarrProfiles: vi.fn(),
  sonarrTags: vi.fn(),
  lidarrArtist: vi.fn(),
  lidarrProfiles: vi.fn(),
  lidarrTags: vi.fn(),
  apiError: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: m.apiError },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return { getMovieByTmdbId: m.radarrMovie, getQualityProfiles: m.radarrProfiles, getTags: m.radarrTags };
  }),
}));
vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return { getSeriesByTvdbId: m.sonarrSeries, getQualityProfiles: m.sonarrProfiles, getTags: m.sonarrTags };
  }),
}));
vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return { getArtistByMusicBrainzId: m.lidarrArtist, getQualityProfiles: m.lidarrProfiles, getTags: m.lidarrTags };
  }),
}));

import { GET } from "@/app/api/media/[id]/arr-info/route";

type Match = {
  type: string;
  instanceName: string;
  qualityProfileName: string | null;
  matchedVia: string;
  externalId: string;
  tags: string[];
  arrUrl: string | null;
};

describe("GET /api/media/[id]/arr-info — music, tags and links", () => {
  let userId: string;
  let libraryId: string;
  let seriesLibraryId: string;
  let musicLibraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; drop each test's answers so none
    // leaks into the next.
    for (const mock of Object.values(m)) mock.mockReset();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
    const server = await createTestServer(userId);
    libraryId = (await createTestLibrary(server.id, { type: "MOVIE" })).id;
    seriesLibraryId = (await createTestLibrary(server.id, { type: "SERIES" })).id;
    musicLibraryId = (await createTestLibrary(server.id, { type: "MUSIC" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function matches(id: string) {
    return (await expectJson<{ matches: Match[] }>(await callRouteWithParams(GET, { id }))).matches;
  }

  it("refuses another user's item with 403", async () => {
    const stranger = await createTestUser({ username: "stranger" });
    const server = await createTestServer(stranger.id);
    const lib = await createTestLibrary(server.id);
    const item = await createTestMediaItem(lib.id);
    await createTestExternalId(item.id, "TMDB", "603");
    await createTestRadarrInstance(userId);
    const res = await callRouteWithParams(GET, { id: item.id });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(m.radarrMovie).not.toHaveBeenCalled();
  });

  describe("music", () => {
    it("returns no matches for a track without an artist MusicBrainz id", async () => {
      const item = await createTestMediaItem(musicLibraryId, { type: "MUSIC" });
      await createTestLidarrInstance(userId);
      expect(await matches(item.id)).toEqual([]);
      expect(m.lidarrArtist).not.toHaveBeenCalled();
    });

    it("matches the artist in Lidarr with its profile, tags and the browser link", async () => {
      const item = await createTestMediaItem(musicLibraryId, { type: "MUSIC" });
      await createTestExternalId(item.id, "MUSICBRAINZ", "mbid-artist");
      const inst = await createTestLidarrInstance(userId, { name: "Lid" });
      await getTestPrisma().lidarrInstance.update({
        where: { id: inst.id },
        data: { externalUrl: "https://lidarr.example.com" },
      });
      m.lidarrArtist.mockResolvedValue({ foreignArtistId: "mbid-artist", qualityProfileId: 2, tags: [1, 99] });
      m.lidarrProfiles.mockResolvedValue([{ id: 1, name: "Any" }, { id: 2, name: "Lossless" }]);
      m.lidarrTags.mockResolvedValue([{ id: 1, label: "keep" }]);

      expect(await matches(item.id)).toEqual([
        expect.objectContaining({
          type: "lidarr",
          instanceName: "Lid",
          qualityProfileName: "Lossless",
          matchedVia: "MUSICBRAINZ",
          externalId: "mbid-artist",
          // Tag 99 has no label and is dropped.
          tags: ["keep"],
          arrUrl: "https://lidarr.example.com/artist/mbid-artist",
        }),
      ]);
      expect(m.lidarrArtist).toHaveBeenCalledWith("mbid-artist");
    });

    it("skips the tag lookup for an untagged artist and reports an unknown profile as null", async () => {
      const item = await createTestMediaItem(musicLibraryId, { type: "MUSIC" });
      await createTestExternalId(item.id, "MUSICBRAINZ", "mb2");
      await createTestLidarrInstance(userId, { url: "http://lidarr.lan:8686" });
      m.lidarrArtist.mockResolvedValue({ foreignArtistId: "mb2", qualityProfileId: 42, tags: [] });
      m.lidarrProfiles.mockResolvedValue([]);
      const [match] = await matches(item.id);
      expect(match.tags).toEqual([]);
      expect(match.qualityProfileName).toBeNull();
      expect(match.arrUrl).toBe("http://lidarr.lan:8686/artist/mb2");
      expect(m.lidarrTags).not.toHaveBeenCalled();
    });

    it("returns nothing when Lidarr does not know the artist or fails", async () => {
      const item = await createTestMediaItem(musicLibraryId, { type: "MUSIC" });
      await createTestExternalId(item.id, "MUSICBRAINZ", "mb3");
      await createTestLidarrInstance(userId, { name: "A" });
      await createTestLidarrInstance(userId, { name: "B" });
      m.lidarrArtist.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("lidarr down"));
      expect(await matches(item.id)).toEqual([]);
      expect(m.lidarrArtist).toHaveBeenCalledTimes(2);
      expect(m.apiError).toHaveBeenCalledWith(
        "Media",
        expect.stringContaining("Lidarr"),
        expect.objectContaining({ error: expect.stringContaining("lidarr down") }),
      );
    });
  });

  it("links a Radarr movie through the external URL and labels its tags", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", "603");
    const inst = await createTestRadarrInstance(userId);
    await getTestPrisma().radarrInstance.update({
      where: { id: inst.id },
      data: { externalUrl: "https://radarr.example.com" },
    });
    m.radarrMovie.mockResolvedValue({ tmdbId: 603, qualityProfileId: 1, tags: [3] });
    m.radarrProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);
    m.radarrTags.mockResolvedValue([{ id: 3, label: "4k-later" }]);
    const [match] = await matches(item.id);
    expect(match.arrUrl).toBe("https://radarr.example.com/movie/603");
    expect(match.tags).toEqual(["4k-later"]);
    expect(m.radarrMovie).toHaveBeenCalledWith(603);
  });

  it("returns nothing for a movie without a TMDB id", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    await createTestExternalId(item.id, "IMDB", "tt0133093");
    await createTestRadarrInstance(userId);
    expect(await matches(item.id)).toEqual([]);
    expect(m.radarrMovie).not.toHaveBeenCalled();
  });

  it("links a Sonarr series by id when it has no title slug, with labelled tags", async () => {
    const item = await createTestMediaItem(seriesLibraryId, { type: "SERIES", parentTitle: "Show" });
    await createTestExternalId(item.id, "TVDB", "81189");
    await createTestSonarrInstance(userId, { url: "http://sonarr.lan:8989" });
    // titleSlug is optional on Sonarr's series resource.
    m.sonarrSeries.mockResolvedValue({ id: 17, title: "Show", tvdbId: 81189, qualityProfileId: 5, tags: [8] });
    m.sonarrProfiles.mockResolvedValue([{ id: 5, name: "WEB" }]);
    m.sonarrTags.mockResolvedValue([{ id: 8, label: "ended" }]);
    const [match] = await matches(item.id);
    expect(match).toEqual(expect.objectContaining({
      type: "sonarr",
      qualityProfileName: "WEB",
      tags: ["ended"],
      arrUrl: "http://sonarr.lan:8989/series/17",
      matchedVia: "TVDB",
    }));
  });

  it("returns nothing for a series without a TVDB id", async () => {
    const item = await createTestMediaItem(seriesLibraryId, { type: "SERIES", parentTitle: "Show" });
    await createTestSonarrInstance(userId);
    expect(await matches(item.id)).toEqual([]);
    expect(m.sonarrSeries).not.toHaveBeenCalled();
  });
});
