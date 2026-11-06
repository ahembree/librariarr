/**
 * SQL fragments shared by the artist and album listings, which aggregate track
 * rows in SQL the way the series listings aggregate episodes (see
 * `series-sql.ts`).
 */

/**
 * The artist a track groups under: the same normalisation
 * `getServerPresenceByGroup("MUSIC")` keys its presence map by, so a group's
 * key looks its servers up directly.
 */
export const ARTIST_KEY_SQL = `LOWER(TRIM(mi."parentTitle"))`;

/** What the album listings show for a track with no album / no artist, and the group it falls in. */
export const UNKNOWN_ALBUM = "Unknown Album";
export const UNKNOWN_ARTIST = "Unknown Artist";

/**
 * The album a track groups under, as every album view groups it — the All
 * Albums tab (`artist::album`), the artist page's album cards, the album page
 * that opens from them and the artist card's `albumCount`: lower-cased and
 * trimmed, a missing or blank title in the "Unknown Album" group. The album
 * page matched the exact stored spellings instead, so an album merged from
 * "Abbey Road" and "abbey road " listed fewer tracks than its card, and the
 * "Unknown Album · 12 tracks" card opened an empty page.
 */
export function albumTitleKeySql(col: string): string {
  return `LOWER(COALESCE(NULLIF(TRIM(${col}), ''), '${UNKNOWN_ALBUM}'))`;
}

/** How an album group is titled: the track's own spelling, or the placeholder for a missing or blank one. */
export function albumTitleDisplaySql(col: string): string {
  return `CASE WHEN NULLIF(TRIM(${col}), '') IS NULL THEN '${UNKNOWN_ALBUM}' ELSE ${col} END`;
}

/** The artist half of an album's key: `ARTIST_KEY_SQL` with the placeholder for a missing artist. */
export function albumArtistKeySql(col: string): string {
  return `LOWER(TRIM(COALESCE(${col}, '${UNKNOWN_ARTIST}')))`;
}

/** SQL `TRIM`: spaces only, where `String.prototype.trim` also strips tabs and newlines. */
const trimSpaces = (s: string) => s.replace(/^ +| +$/g, "");

/**
 * JS twin of `albumTitleKeySql`, for the artist page's fold. Trims spaces only,
 * as SQL `TRIM` does, so the two put a title in the same group.
 */
export function albumTitleKey(albumTitle: string | null): string {
  return (trimSpaces(albumTitle ?? "") || UNKNOWN_ALBUM).toLowerCase();
}

/** JS twin of `albumTitleDisplaySql`. */
export function albumTitleDisplay(albumTitle: string | null): string {
  return albumTitle && trimSpaces(albumTitle) ? albumTitle : UNKNOWN_ALBUM;
}

/**
 * A track's audio-codec chip label: upper-cased, `Unknown` when missing or
 * blank — what the JS fold these listings replaced computed per track.
 */
export function audioCodecLabelSql(col: string): string {
  return `COALESCE(UPPER(NULLIF(${col}, '')), 'Unknown')`;
}

export interface CodecCountRow {
  group_key: string;
  codec: string;
  n: number;
}

/** `(group, codec, count)` rows folded into group → `{ codec: count }`. */
export function foldCodecCounts(rows: readonly CodecCountRow[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const { group_key, codec, n } of rows) {
    let counts = out.get(group_key);
    if (!counts) {
      counts = {};
      out.set(group_key, counts);
    }
    counts[codec] = (counts[codec] ?? 0) + n;
  }
  return out;
}
