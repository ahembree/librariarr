import { describe, it, expect } from "vitest";
import {
  hoverDataFromAlbum,
  hoverDataFromArtistGroup,
  hoverDataFromListItem,
  hoverDataFromRecord,
  hoverDataFromSeason,
  hoverDataFromSeriesGroup,
  hoverSummaryUrl,
  type MediaHoverData,
} from "@/lib/media/hover-data";
import { mediaRecordUrl } from "@/lib/media/detail-prefetch";
import type { MediaListItem } from "@/lib/types";

const servers = [{ serverId: "s1", serverName: "Plex", serverType: "PLEX" }];
const metadata = {
  year: 2010,
  contentRating: "PG-13",
  rating: 8.1,
  ratingImage: "rottentomatoes://image.rating.ripe",
  audienceRating: 9,
  audienceRatingImage: "rottentomatoes://image.rating.upright",
  genres: ["Sci-Fi"],
  studio: "Warner",
  addedAt: "2024-01-01T00:00:00.000Z",
  servers,
};

/** The fields a popover may be given, for asserting nothing else slips in. */
const UNIVERSAL: (keyof MediaHoverData)[] = [
  "title", "year", "summary", "contentRating", "rating", "audienceRating", "ratingImage", "audienceRatingImage",
  "duration", "resolution", "dynamicRange", "audioProfile", "audioCodec", "fileSize", "genres", "studio",
  "playCount", "lastPlayedAt", "addedAt", "servers", "seasonCount", "episodeCount", "albumCount", "trackCount",
  "qualityCounts", "audioCodecCounts",
];

const defined = (data: MediaHoverData) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

describe("hoverDataFromListItem", () => {
  const film = {
    ...metadata,
    id: "m1",
    title: "Inception",
    type: "MOVIE",
    duration: 8_880_000,
    resolution: "4k",
    dynamicRange: "HDR10",
    audioProfile: "Dolby Atmos",
    audioCodec: "truehd",
    fileSize: "123",
    playCount: 3,
    lastPlayedAt: "2024-02-01T00:00:00.000Z",
  };

  it("passes a film's own details, never its audio codec", () => {
    const data = hoverDataFromListItem(film);
    expect(defined(data)).toEqual({
      ...metadata,
      title: "Inception",
      duration: 8_880_000,
      resolution: "4k",
      dynamicRange: "HDR10",
      audioProfile: "Dolby Atmos",
      fileSize: "123",
      playCount: 3,
      lastPlayedAt: "2024-02-01T00:00:00.000Z",
    });
    for (const key of Object.keys(data)) expect(UNIVERSAL).toContain(key);
  });

  it("passes a track's codec and takes a title override", () => {
    const data = hoverDataFromListItem({ ...film, type: "MUSIC", title: "Song" }, { title: "Artist — Song" });
    expect(data.audioCodec).toBe("truehd");
    expect(data.title).toBe("Artist — Song");
  });

  it("gives a grouped show its counts instead of its representative episode's details", () => {
    const data = hoverDataFromListItem({ ...film, type: "SERIES", matchedEpisodes: 20, seasonCount: 2 });
    expect(data).toMatchObject({ seasonCount: 2, episodeCount: 20 });
    expect(data.trackCount).toBeUndefined();
    for (const key of ["duration", "resolution", "dynamicRange", "audioProfile", "audioCodec"] as const) {
      expect(data[key]).toBeUndefined();
    }
  });

  it("counts a grouped artist's members as tracks, not episodes", () => {
    const data = hoverDataFromListItem({ ...film, type: "MUSIC", matchedEpisodes: 40 });
    expect(data).toMatchObject({ trackCount: 40 });
    expect(data.episodeCount).toBeUndefined();
    expect(data.seasonCount).toBeUndefined();
    expect(data.audioCodec).toBeUndefined();
  });

  it("takes a flat list row as it comes (no summary on it)", () => {
    const row = { ...film, summary: undefined } as unknown as MediaListItem;
    expect(hoverDataFromListItem(row).summary).toBeUndefined();
  });
});

describe("grouped rows", () => {
  const figures = { ...metadata, summary: "A show.", totalSize: "999", lastPlayed: "2024-03-01T00:00:00.000Z" };

  it("maps a show, with plays only when its listing sums them", () => {
    const show = { ...figures, parentTitle: "The Show", seasonCount: 3, episodeCount: 30, qualityCounts: { "1080P": 30 } };
    expect(defined(hoverDataFromSeriesGroup(show))).toEqual({
      ...metadata,
      title: "The Show",
      summary: "A show.",
      seasonCount: 3,
      episodeCount: 30,
      qualityCounts: { "1080P": 30 },
      fileSize: "999",
      lastPlayedAt: "2024-03-01T00:00:00.000Z",
    });
    expect(hoverDataFromSeriesGroup({ ...show, totalPlayCount: 12 }).playCount).toBe(12);
  });

  it("names a season after its show, Specials for season 0", () => {
    const season = { ...figures, parentTitle: "The Show", seasonNumber: 2, episodeCount: 10, totalPlayCount: 4 };
    const data = hoverDataFromSeason(season);
    expect(data).toMatchObject({ title: "The Show — Season 2", episodeCount: 10, playCount: 4, fileSize: "999" });
    expect(data.seasonCount).toBeUndefined();
    expect(hoverDataFromSeason({ ...season, seasonNumber: 0 }).title).toBe("The Show — Specials");
  });

  it("maps an artist and an album with their music counts", () => {
    const artist = hoverDataFromArtistGroup({
      ...figures,
      parentTitle: "Artist",
      albumCount: 2,
      trackCount: 20,
      audioCodecCounts: { flac: 20 },
    });
    expect(artist).toMatchObject({ title: "Artist", albumCount: 2, trackCount: 20, audioCodecCounts: { flac: 20 } });
    expect(artist.episodeCount).toBeUndefined();
    const album = hoverDataFromAlbum({ ...figures, albumTitle: "Album", trackCount: 9, totalPlayCount: 5 });
    expect(album).toMatchObject({ title: "Album", trackCount: 9, playCount: 5, fileSize: "999" });
  });
});

describe("hoverDataFromRecord and hoverSummaryUrl", () => {
  it("keeps a track's codec and strips anyone else's", () => {
    expect(hoverDataFromRecord({ title: "x", type: "MUSIC", audioCodec: "flac" }).audioCodec).toBe("flac");
    expect(hoverDataFromRecord({ title: "x", type: "MOVIE", audioCodec: "aac" }).audioCodec).toBeUndefined();
  });

  it("points the summary at the record URL the detail views fetch", () => {
    expect(hoverSummaryUrl("abc")).toBe(mediaRecordUrl("abc"));
  });
});
