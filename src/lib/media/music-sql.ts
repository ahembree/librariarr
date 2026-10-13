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
