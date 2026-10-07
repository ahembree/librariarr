/**
 * Sorting for the Watch History page (`/library/history`) and its route
 * (`GET /api/media/history`), in one module so the two cannot drift.
 *
 * The page sorts server-side: a header click maps the column id to a `sortBy`
 * key, and the route maps that key to an ORDER BY. Each half used to keep its
 * own map, and they disagreed — HDR / Video Codec / Audio were clickable but
 * had no route key (the route silently fell back to Watched At while the arrow
 * sat on the clicked header), and User and Server both sent `serverUsername`,
 * so the reverse lookup put the arrow on Server and a Server click sorted by
 * username. Now the page derives each column's sortability from
 * `HISTORY_COLUMN_SORT_KEY`, every value of which is a `HistorySortKey` the
 * route's `HISTORY_SORT_SQL` must cover (a `Record` over that union, so a
 * missing entry is a type error), and the reverse map is built from a map that
 * a unit test pins as one-to-one.
 *
 * Client-safe: plain data plus one relative import of the dependency-free
 * `resolution.ts`. The SQL strings are fixed fragments over the route's own
 * aliases (`wh` WatchHistory, `mi` MediaItem, `ms` MediaServer) and are only
 * ever interpolated by the route.
 */

import { QUALITY_ORDER, resolutionLabelSql } from "../resolution";

export const HISTORY_SORT_KEYS = [
  "watchedAt",
  "serverUsername",
  "serverName",
  "deviceName",
  "platform",
  "title",
  "type",
  "year",
  "resolution",
  "dynamicRange",
  "videoCodec",
  "audioCodec",
  "duration",
  "fileSize",
  "percentComplete",
  "isTranscode",
  "player",
  "streamResolution",
] as const;

export type HistorySortKey = (typeof HISTORY_SORT_KEYS)[number];

export const DEFAULT_HISTORY_SORT_KEY: HistorySortKey = "watchedAt";

/**
 * The Title column shows `"<Show> - SxxExx - <episode>"` for an episode,
 * `"<Artist> - <track>"` for a track and the bare title otherwise
 * (`getItemTitle` on the page), so sorting on `titleSort` — the item's OWN
 * sort title — scattered a show's episodes by episode name across the list.
 * These keys order by the text actually displayed: the show/artist (only for
 * the types whose display leads with it), then — for episodes only — season
 * and episode number (zero-padded on screen, so numeric order IS the displayed
 * order), then the row's own title. A track's `seasonNumber`/`episodeNumber`
 * hold its disc/track index, which the display does not show, so they are
 * deliberately not used for music.
 */
const DISPLAY_LEAD_SQL = `LOWER(CASE WHEN mi."type" IN ('SERIES', 'MUSIC') AND mi."parentTitle" IS NOT NULL THEN mi."parentTitle" ELSE mi."title" END)`;
const EPISODE_SEASON_SQL = `(CASE WHEN mi."type" = 'SERIES' AND mi."parentTitle" IS NOT NULL THEN mi."seasonNumber" END)`;
const EPISODE_NUMBER_SQL = `(CASE WHEN mi."type" = 'SERIES' AND mi."parentTitle" IS NOT NULL THEN mi."episodeNumber" END)`;

/**
 * The Resolution columns show the normalized label (`formatResolution` on the
 * page: "4K", "1080P", …, the raw text only for an unrecognised value), so
 * they sort by that label's RANK, lowest to highest when ascending. Sorting
 * the raw column ordered "1080, 2160, 480, 4k, 720, sd" — text order — and put
 * "2160" and "4k", both shown as 4K, at opposite ends of the list. The label
 * comes from `resolutionLabelSql`, the SQL twin of the page's
 * `normalizeResolutionLabel`, so the two cannot disagree about which label a
 * value gets. "Other" has no rank (NULL — last in both directions, like every
 * other unknown here); the second expression orders the unrecognised raw
 * values the page then shows among themselves, an empty string with the
 * NULLs since the page renders both as "-". The CASE is evaluated per row, so
 * this sort costs more than a plain column (measured ~120 ms extra over 150k
 * plays) — only when someone actually sorts by resolution.
 */
const RESOLUTION_RANKED_LABELS = QUALITY_ORDER.filter((label) => label !== "Other").reverse();

function resolutionSortSql(expr: string): readonly string[] {
  const ranks = RESOLUTION_RANKED_LABELS.map((label, i) => `WHEN '${label}' THEN ${i + 1}`).join(" ");
  return [`(CASE ${resolutionLabelSql(expr)} ${ranks} END)`, `NULLIF(LOWER(${expr}), '')`];
}

/**
 * Media types in the order of the label the Type column shows ("Movie",
 * "Music", "Series" — `MEDIA_TYPE_LABELS`), not the enum's declaration order
 * (MOVIE, SERIES, MUSIC) that sorting the enum column gives. A unit test pins
 * this list to the labels.
 */
export const HISTORY_TYPE_SORT_ORDER = ["MOVIE", "MUSIC", "SERIES"] as const;
const TYPE_SORT_SQL = `(CASE mi."type" ${HISTORY_TYPE_SORT_ORDER.map((t, i) => `WHEN '${t}' THEN ${i + 1}`).join(" ")} END)`;

/**
 * ORDER BY expressions per sort key, most significant first; the route applies
 * the requested direction to each and appends `wh."id"` as the total-order
 * tiebreaker. A strict whitelist — the route never interpolates `sortBy` itself.
 */
export const HISTORY_SORT_SQL: Record<HistorySortKey, readonly string[]> = {
  watchedAt: ['wh."watchedAt"'],
  serverUsername: ['wh."serverUsername"'],
  // The Server column shows the server's name, so it sorts by it — it used to
  // send `serverUsername` and sort by the user instead.
  serverName: ['ms."name"'],
  deviceName: ['wh."deviceName"'],
  platform: ['wh."platform"'],
  title: [DISPLAY_LEAD_SQL, EPISODE_SEASON_SQL, EPISODE_NUMBER_SQL, 'LOWER(mi."title")'],
  type: [TYPE_SORT_SQL],
  year: ['mi."year"'],
  resolution: resolutionSortSql('mi."resolution"'),
  dynamicRange: ['mi."dynamicRange"'],
  videoCodec: ['mi."videoCodec"'],
  // The Audio column reads "<codec> <n>ch", so channels break a codec tie.
  audioCodec: ['mi."audioCodec"', 'mi."audioChannels"'],
  duration: ['mi."duration"'],
  fileSize: ['mi."fileSize"'],
  // Tracearr-sourced play columns. `streamResolution` is deliberately a
  // separate key from `resolution`: the latter is the FILE's resolution on the
  // MediaItem, this one is the resolution actually delivered to the client,
  // and a transcoded 4K file streamed at 1080p differs on the two.
  percentComplete: ['wh."percentComplete"'],
  isTranscode: ['wh."isTranscode"'],
  player: ['wh."player"'],
  streamResolution: resolutionSortSql('wh."resolution"'),
};

/**
 * Page column id → route sort key. A column absent from this map is rendered
 * non-sortable, so a header can never be clickable without a real server sort
 * behind it. Must stay one-to-one (pinned by `tests/unit/media/history-sort`):
 * the page maps the active `sortBy` back to a column to place the arrow.
 */
export const HISTORY_COLUMN_SORT_KEY: Readonly<Record<string, HistorySortKey>> = {
  title: "title",
  type: "type",
  serverUsername: "serverUsername",
  watchedAt: "watchedAt",
  year: "year",
  resolution: "resolution",
  dynamicRange: "dynamicRange",
  videoCodec: "videoCodec",
  audioCodec: "audioCodec",
  duration: "duration",
  fileSize: "fileSize",
  deviceName: "deviceName",
  platform: "platform",
  server: "serverName",
  transcode: "isTranscode",
  completion: "percentComplete",
  player: "player",
  streamResolution: "streamResolution",
};

const SORT_KEY_TO_COLUMN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(HISTORY_COLUMN_SORT_KEY).map(([col, key]) => [key, col]),
);

/** Whether a page column has a server-side sort behind it. */
export function isHistorySortableColumn(columnId: string): boolean {
  return Object.hasOwn(HISTORY_COLUMN_SORT_KEY, columnId);
}

/** The route sort key for a header click; unknown columns sort by Watched At. */
export function historySortKeyForColumn(columnId: string): HistorySortKey {
  return Object.hasOwn(HISTORY_COLUMN_SORT_KEY, columnId)
    ? HISTORY_COLUMN_SORT_KEY[columnId]
    : DEFAULT_HISTORY_SORT_KEY;
}

/** The column carrying the sort arrow for the active `sortBy`. */
export function historyColumnForSortKey(sortKey: string): string {
  return Object.hasOwn(SORT_KEY_TO_COLUMN, sortKey) ? SORT_KEY_TO_COLUMN[sortKey] : "watchedAt";
}

/**
 * The ORDER BY expressions for a requested `sortBy`. `Object.hasOwn`, not a
 * bare lookup: `HISTORY_SORT_SQL["constructor"]` resolves up the prototype
 * chain to a function, which would slip past a `?? default` and be
 * interpolated into the SQL (a 500 rather than the documented fallback).
 */
export function historySortSql(sortBy: string): readonly string[] {
  return Object.hasOwn(HISTORY_SORT_SQL, sortBy)
    ? HISTORY_SORT_SQL[sortBy as HistorySortKey]
    : HISTORY_SORT_SQL[DEFAULT_HISTORY_SORT_KEY];
}
