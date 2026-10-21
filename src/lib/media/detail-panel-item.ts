import type { MediaItemWithRelations } from "@/lib/types";

/**
 * What the media detail side panel needs to know about a grouped row — a show,
 * an artist or an album standing for every episode/track under it — beyond
 * the representative item it is stored against. Every page that opens the
 * panel on such a row describes it through this one shape, so the panel reads
 * the same whether it was opened from Matches, Pending, Exceptions, Query or
 * the rule preview.
 */
export interface DetailPanelGroup {
  /** The group's own name: the show, the artist, or "Artist — Album". */
  title: string;
  /** Episodes/tracks the row stands for. */
  memberCount: number;
  /** Total size of the members (stringified BigInt). */
  fileSize?: string | null;
  /**
   * Total plays across the members. Omitted when the row does not know it —
   * the representative item's own count is one episode's, never the group's,
   * so it is cleared rather than shown.
   */
  playCount?: number;
  /** Most recent play across the members. */
  lastPlayedAt?: string | null;
  /** When the group's first member was added. Omitted keeps the record's. */
  addedAt?: string | null;
  /**
   * The group's blurb, when the row carries one (a show's rather than its
   * first episode's). Omitted keeps the representative record's.
   */
  summary?: string | null;
}

export type DetailPanelMediaType = "MOVIE" | "SERIES" | "MUSIC";

export function toDetailPanelMediaType(type: string | null | undefined): DetailPanelMediaType {
  return type === "SERIES" || type === "MUSIC" ? type : "MOVIE";
}

/**
 * The group a listing row stands for, read off the row itself — the shape the
 * Matches, Pending, Query and rule preview listings already give a grouped row
 * (`matchedEpisodes` set, `title` the show/artist). `undefined` for a row that
 * is one item.
 */
export function groupOfRow(row: {
  title: string;
  parentTitle?: string | null;
  matchedEpisodes?: number | null;
  fileSize?: string | null;
  playCount?: number | null;
  lastPlayedAt?: string | null;
  addedAt?: string | null;
  summary?: string | null;
}): DetailPanelGroup | undefined {
  if (!row.matchedEpisodes) return undefined;
  return {
    // A grouped row names its group in `title` with `parentTitle` cleared;
    // one still carrying a parent is the representative episode/track.
    title: row.parentTitle || row.title,
    memberCount: row.matchedEpisodes,
    fileSize: row.fileSize ?? null,
    playCount: row.playCount ?? undefined,
    lastPlayedAt: row.lastPlayedAt ?? null,
    ...(row.addedAt !== undefined && { addedAt: row.addedAt }),
    ...(row.summary !== undefined && { summary: row.summary }),
  };
}

/**
 * The item the panel renders: the record as loaded, with a group's figures
 * laid over it so the header and the playback card describe the whole group
 * rather than the one episode/track it is stored against.
 */
export function buildDetailPanelItem(
  record: MediaItemWithRelations,
  group?: DetailPanelGroup,
): MediaItemWithRelations {
  if (!group) return record;
  return {
    ...record,
    title: group.title,
    parentTitle: null,
    matchedEpisodes: group.memberCount,
    fileSize: group.fileSize ?? record.fileSize,
    playCount: group.playCount ?? 0,
    lastPlayedAt: group.lastPlayedAt ?? null,
    addedAt: group.addedAt !== undefined ? group.addedAt : record.addedAt,
    summary: group.summary !== undefined ? group.summary : record.summary,
  };
}

/** Where the panel's "Open full page" button leads. */
export function detailPanelUrl(mediaType: DetailPanelMediaType, itemId: string, isGroup: boolean): string {
  if (isGroup) {
    if (mediaType === "SERIES") return `/library/series/show/${itemId}`;
    if (mediaType === "MUSIC") return `/library/music/artist/${itemId}`;
  }
  if (mediaType === "SERIES") return `/library/series/episode/${itemId}`;
  if (mediaType === "MUSIC") return `/library/music/track/${itemId}`;
  return `/library/movies/${itemId}`;
}

/**
 * The library type a playback session's item type ("movie", "episode",
 * "track") belongs to; `null` for anything else (a trailer, a photo, live TV).
 */
export function sessionMediaType(type: string | null | undefined): DetailPanelMediaType | null {
  switch (type?.toLowerCase()) {
    case "movie": return "MOVIE";
    case "episode": return "SERIES";
    case "track": return "MUSIC";
    default: return null;
  }
}
