/**
 * Series identity — the ONE key every series-level grouping in the app uses.
 *
 * Librariarr stores episodes, not shows, so "which show does this episode
 * belong to" has to be derived. Keying that on `parentTitle` collapses two
 * genuinely different shows that share a title (The Office UK 2001 vs The
 * Office US 2005, Battlestar Galactica 1978 vs 2004) into one series
 * everywhere: one row in the library, blended seasons, and — worse — blended
 * `episodeCount` / `watchedEpisodePercentage` / `seriesLastPlayedAt`
 * aggregates feeding destructive lifecycle rules.
 *
 * Every episode already carries the SERIES-level external ids (the sync
 * resolves show-level Guids via `grandparentRatingKey` and persists those to
 * `MediaItemExternalId`, never the episode's own id), so identity is keyed on
 * them, in this order:
 *
 *   1. `tvdb:<id>`  — the series-level TVDB id (what Sonarr correlates on)
 *   2. `tmdb:<id>`  — the series-level TMDB id
 *   3. `title:<lower(trim(parentTitle))>` — no external id at all; this is
 *      exactly the key the series listing used before, so unmatched shows
 *      keep grouping the way they always did
 *
 * This keeps both required properties: the same show on two servers still
 * merges (it shares a TVDB id — the cross-server watch history depends on
 * that), while two different shows with one title finally separate. It is
 * deliberately NOT keyed on `grandparentRatingKey`: that id is per-server, so
 * the same show on two servers would split.
 *
 * The key is persisted as `MediaItem.seriesKey` by the sync (`buildRowParams`
 * in `sync-server.ts`) so SQL can `GROUP BY` / filter on it directly; the
 * routes and the query engine read the column. `resolveSeriesKey` is for
 * in-memory rows that may predate the column (it recomputes the same value
 * from the same inputs, so it cannot disagree with a synced row).
 *
 * `seriesKeySqlExpression` is the SQL twin used by the startup backfill (and
 * copied into migration 0015). Keep the two in lockstep — the integration
 * test in `tests/integration/media/series-key-backfill.test.ts` asserts they
 * agree on seeded rows.
 */

/** Either the sync's parsed-Guid shape or the persisted `MediaItemExternalId` shape. */
export type SeriesExternalIdLike =
  | { source: string; externalId: string }
  | { source: string; id: string };

export const SERIES_KEY_TVDB_PREFIX = "tvdb:";
export const SERIES_KEY_TMDB_PREFIX = "tmdb:";
export const SERIES_KEY_TITLE_PREFIX = "title:";

export interface SeriesKeyInput {
  /** The show name every episode row carries (`grandparentTitle` on the server). */
  parentTitle: string | null | undefined;
  /**
   * SERIES-level external ids only (what `MediaItemExternalId` holds for an
   * episode). Passing an episode's own TVDB id here would give every episode
   * its own "series" — the sync never does that, and neither must a caller.
   */
  externalIds?: ReadonlyArray<SeriesExternalIdLike> | null;
}

function externalIdValue(e: SeriesExternalIdLike): string {
  return "externalId" in e ? e.externalId : e.id;
}

/** First non-blank id for `source` (case-insensitive: the sync stores "TVDB"). */
function findExternalId(ids: ReadonlyArray<SeriesExternalIdLike>, source: "TVDB" | "TMDB"): string | null {
  for (const e of ids) {
    if (e.source.toUpperCase() !== source) continue;
    const value = externalIdValue(e).trim();
    if (value) return value;
  }
  return null;
}

/**
 * The title normalization behind the `title:` fallback — `LOWER(TRIM(x))`,
 * byte-for-byte what the series listing grouped on before external ids were
 * used, so unmatched shows keep their old grouping (and cross-server spelling
 * differences in case/whitespace still merge).
 */
export function normalizeSeriesTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** `title:<normalized>` for a show name, or null when the name is blank. */
export function seriesKeyFromTitle(parentTitle: string): string | null {
  const normalized = normalizeSeriesTitle(parentTitle);
  return normalized ? `${SERIES_KEY_TITLE_PREFIX}${normalized}` : null;
}

/**
 * Compute the series key for an episode: TVDB id, else TMDB id, else the
 * normalized `parentTitle`; null when none of the three exists (such a row is
 * not a series member and is excluded from every series view, exactly as a
 * null `parentTitle` was before).
 */
export function computeSeriesKey(input: SeriesKeyInput): string | null {
  const ids = input.externalIds ?? [];
  const tvdb = findExternalId(ids, "TVDB");
  if (tvdb) return `${SERIES_KEY_TVDB_PREFIX}${tvdb}`;
  const tmdb = findExternalId(ids, "TMDB");
  if (tmdb) return `${SERIES_KEY_TMDB_PREFIX}${tmdb}`;
  return input.parentTitle ? seriesKeyFromTitle(input.parentTitle) : null;
}

/**
 * The key for an in-memory episode row: the stored `seriesKey` when the row
 * carries one, otherwise recomputed from `parentTitle` + the loaded external
 * ids (a row synced before the column existed, or a test fixture). Both come
 * from the same inputs, so a stored key and a recomputed one never differ.
 */
export function resolveSeriesKey(
  item: { seriesKey?: string | null } & SeriesKeyInput,
): string | null {
  return item.seriesKey ?? computeSeriesKey(item);
}

/**
 * SQL twin of `computeSeriesKey` for a `"MediaItem"` row aliased `alias`, used
 * to backfill `seriesKey` set-based. Same precedence (TVDB → TMDB → title),
 * same blank handling (a blank id or title yields NULL for that branch), same
 * case-insensitive source match. `(mediaItemId, source)` is unique, so each
 * subquery returns at most one row.
 */
export function seriesKeySqlExpression(alias: string = "mi"): string {
  const idFor = (source: "TVDB" | "TMDB", prefix: string) =>
    `(SELECT '${prefix}' || NULLIF(TRIM(e."externalId"), '')
        FROM "MediaItemExternalId" e
       WHERE e."mediaItemId" = ${alias}."id"
         AND UPPER(e."source") = '${source}'
         AND NULLIF(TRIM(e."externalId"), '') IS NOT NULL
       LIMIT 1)`;
  return `COALESCE(
    ${idFor("TVDB", SERIES_KEY_TVDB_PREFIX)},
    ${idFor("TMDB", SERIES_KEY_TMDB_PREFIX)},
    '${SERIES_KEY_TITLE_PREFIX}' || NULLIF(LOWER(TRIM(${alias}."parentTitle")), '')
  )`;
}
