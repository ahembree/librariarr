/**
 * What every `MediaHoverPopover` is given, built one way per kind of row.
 *
 * The style guide's rule — every popover passes the same universal field set,
 * and a table and a card view of one page pass identical fields — was kept by
 * some thirty-five hand-written `data={{ … }}` objects, which is how a grouped
 * music row in the Query results came to say "episodes". These helpers are the
 * one mapping per row shape. Client-safe.
 */

import { mediaRecordUrl } from "@/lib/media/detail-prefetch";

export interface MediaHoverData {
  title: string;
  year?: number | null;
  summary?: string | null;
  contentRating?: string | null;
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
  duration?: number | null;
  resolution?: string | null;
  dynamicRange?: string | null;
  audioProfile?: string | null;
  /** A track's codec (music-only, like `audioCodecCounts` for a group). */
  audioCodec?: string | null;
  fileSize?: string | null;
  genres?: string[] | null;
  studio?: string | null;
  playCount?: number;
  lastPlayedAt?: string | null;
  addedAt?: string | null;
  seasonCount?: number;
  episodeCount?: number;
  albumCount?: number;
  trackCount?: number;
  audioCodecCounts?: Record<string, number> | null;
  qualityCounts?: Record<string, number> | null;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
}

type Servers = MediaHoverData["servers"];

/** The metadata every row shape carries under the same names. */
interface SharedMetadata {
  year?: number | null;
  summary?: string | null;
  contentRating?: string | null;
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
  genres?: string[] | null;
  studio?: string | null;
  addedAt?: string | null;
  servers?: Servers;
}

function sharedMetadata(row: SharedMetadata): MediaHoverData {
  return {
    title: "",
    year: row.year,
    summary: row.summary,
    contentRating: row.contentRating,
    rating: row.rating,
    ratingImage: row.ratingImage,
    audienceRating: row.audienceRating,
    audienceRatingImage: row.audienceRatingImage,
    genres: row.genres,
    studio: row.studio,
    addedAt: row.addedAt,
    servers: row.servers,
  };
}

/**
 * The popover's `summaryUrl` for a row whose list left the summary out: the
 * item's record, the URL the detail views fetch — so the record the popover
 * fetched (through `detailPrefetch.peek`) is still there for the click.
 */
export function hoverSummaryUrl(mediaItemId: string): string {
  return mediaRecordUrl(mediaItemId);
}

/** A row standing for one item — a film, an episode, a track — or a Query row that may be grouped. */
export interface HoverItemRow extends SharedMetadata {
  title: string;
  type?: string | null;
  duration?: number | null;
  resolution?: string | null;
  dynamicRange?: string | null;
  audioProfile?: string | null;
  audioCodec?: string | null;
  fileSize?: string | null;
  playCount?: number | null;
  lastPlayedAt?: string | null;
  /** Set when the row stands for a group (a show's or an artist's members). */
  matchedEpisodes?: number | null;
  seasonCount?: number | null;
}

/**
 * A flat list or Query row. `title` overrides the row's own (an episode is
 * named "<Show> SxxExx", never by its episode title). A grouped row passes its
 * counts — seasons and episodes for a show, tracks for an artist — never its
 * representative member's own file details; only a track passes its codec.
 */
export function hoverDataFromListItem(row: HoverItemRow, options: { title?: string } = {}): MediaHoverData {
  const grouped = row.matchedEpisodes != null;
  const music = row.type === "MUSIC";
  return {
    ...sharedMetadata(row),
    title: options.title ?? row.title,
    duration: grouped ? undefined : row.duration,
    resolution: grouped ? undefined : row.resolution,
    dynamicRange: grouped ? undefined : row.dynamicRange,
    audioProfile: grouped ? undefined : row.audioProfile,
    audioCodec: music && !grouped ? row.audioCodec : undefined,
    seasonCount: grouped && !music ? row.seasonCount ?? undefined : undefined,
    episodeCount: grouped && !music ? row.matchedEpisodes ?? undefined : undefined,
    trackCount: grouped && music ? row.matchedEpisodes ?? undefined : undefined,
    fileSize: row.fileSize,
    playCount: row.playCount ?? undefined,
    lastPlayedAt: row.lastPlayedAt,
  };
}

/** The aggregate figures the grouped listings (shows, seasons, artists, albums) return. */
interface GroupFigures extends SharedMetadata {
  totalSize?: string | null;
  /** Not every listing sums plays; absent, the popover shows none. */
  totalPlayCount?: number | null;
  lastPlayed?: string | null;
}

export interface SeriesGroupRow extends GroupFigures {
  parentTitle: string;
  seasonCount?: number;
  episodeCount?: number;
  qualityCounts?: Record<string, number> | null;
}

/** A show (`/api/media/series/grouped`). */
export function hoverDataFromSeriesGroup(row: SeriesGroupRow, options: { title?: string } = {}): MediaHoverData {
  return {
    ...sharedMetadata(row),
    title: options.title ?? row.parentTitle,
    seasonCount: row.seasonCount,
    episodeCount: row.episodeCount,
    qualityCounts: row.qualityCounts,
    fileSize: row.totalSize,
    playCount: row.totalPlayCount ?? undefined,
    lastPlayedAt: row.lastPlayed,
  };
}

export interface SeasonRow extends Omit<SeriesGroupRow, "seasonCount"> {
  seasonNumber: number;
}

/** "The Show — Season 2", "The Show — Specials". */
export function seasonHoverTitle(parentTitle: string, seasonNumber: number): string {
  return `${parentTitle} — ${seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`}`;
}

/** A season (`/api/media/series/all-seasons`, a show's seasons). */
export function hoverDataFromSeason(row: SeasonRow): MediaHoverData {
  return hoverDataFromSeriesGroup(
    { ...row, seasonCount: undefined },
    { title: seasonHoverTitle(row.parentTitle, row.seasonNumber) },
  );
}

export interface ArtistGroupRow extends GroupFigures {
  parentTitle: string;
  albumCount?: number;
  trackCount?: number;
  audioCodecCounts?: Record<string, number> | null;
}

/** An artist (`/api/media/music/grouped`). */
export function hoverDataFromArtistGroup(row: ArtistGroupRow): MediaHoverData {
  return {
    ...sharedMetadata(row),
    title: row.parentTitle,
    albumCount: row.albumCount,
    trackCount: row.trackCount,
    audioCodecCounts: row.audioCodecCounts,
    fileSize: row.totalSize,
    playCount: row.totalPlayCount ?? undefined,
    lastPlayedAt: row.lastPlayed,
  };
}

export interface AlbumRow extends GroupFigures {
  albumTitle: string;
  trackCount?: number;
  audioCodecCounts?: Record<string, number> | null;
}

/** An album (`/api/media/music/albums/all`, an artist's albums). */
export function hoverDataFromAlbum(row: AlbumRow): MediaHoverData {
  return {
    ...sharedMetadata(row),
    title: row.albumTitle,
    trackCount: row.trackCount,
    audioCodecCounts: row.audioCodecCounts,
    fileSize: row.totalSize,
    playCount: row.totalPlayCount ?? undefined,
    lastPlayedAt: row.lastPlayed,
  };
}

/**
 * Hover data straight from a `/api/media/[id]` record. The record carries an
 * audio codec for every item, but only a track shows it as its chip — a film
 * keeps its resolution, dynamic range and audio profile.
 */
export function hoverDataFromRecord(record: MediaHoverData & { type?: string | null }): MediaHoverData {
  return record.type === "MUSIC" ? record : { ...record, audioCodec: undefined };
}
