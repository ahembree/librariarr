/**
 * Sorting for the Watch History page and `GET /api/media/history`, in one module
 * so the two cannot drift: a column is sortable only through
 * `HISTORY_COLUMN_SORT_KEY`, every value of which `HISTORY_SORT_SQL` must cover (a
 * type error otherwise). Client-safe; the SQL fragments use the route's aliases
 * (`wh`, `mi`, `ms`) and only the route interpolates them.
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
 * Title sorts by the displayed text (`getItemTitle`): show/artist, then season and
 * episode for episodes only (a track's are its disc/track index, not shown), then title.
 */
const DISPLAY_LEAD_SQL = `LOWER(CASE WHEN mi."type" IN ('SERIES', 'MUSIC') AND mi."parentTitle" IS NOT NULL THEN mi."parentTitle" ELSE mi."title" END)`;
const EPISODE_SEASON_SQL = `(CASE WHEN mi."type" = 'SERIES' AND mi."parentTitle" IS NOT NULL THEN mi."seasonNumber" END)`;
const EPISODE_NUMBER_SQL = `(CASE WHEN mi."type" = 'SERIES' AND mi."parentTitle" IS NOT NULL THEN mi."episodeNumber" END)`;

/**
 * The Resolution columns sort by the rank of the label shown (`resolutionLabelSql`,
 * the SQL twin of `normalizeResolutionLabel`). "Other" is unranked (NULL, last); the
 * second expression orders the raw values shown, an empty string with the NULLs ("-").
 */
const RESOLUTION_RANKED_LABELS = QUALITY_ORDER.filter((label) => label !== "Other").reverse();

function resolutionSortSql(expr: string): readonly string[] {
  const ranks = RESOLUTION_RANKED_LABELS.map((label, i) => `WHEN '${label}' THEN ${i + 1}`).join(" ");
  return [`(CASE ${resolutionLabelSql(expr)} ${ranks} END)`, `NULLIF(LOWER(${expr}), '')`];
}

/** Media types in the order of the label shown (`MEDIA_TYPE_LABELS`), not the enum's. */
export const HISTORY_TYPE_SORT_ORDER = ["MOVIE", "MUSIC", "SERIES"] as const;
const TYPE_SORT_SQL = `(CASE mi."type" ${HISTORY_TYPE_SORT_ORDER.map((t, i) => `WHEN '${t}' THEN ${i + 1}`).join(" ")} END)`;

/**
 * ORDER BY expressions per sort key, most significant first; the route appends
 * `wh."id"` as tiebreaker. A strict whitelist: `sortBy` itself is never interpolated.
 */
export const HISTORY_SORT_SQL: Record<HistorySortKey, readonly string[]> = {
  watchedAt: ['wh."watchedAt"'],
  serverUsername: ['wh."serverUsername"'],
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
  // Tracearr play columns. `streamResolution` is what reached the client, not the file's.
  percentComplete: ['wh."percentComplete"'],
  isTranscode: ['wh."isTranscode"'],
  player: ['wh."player"'],
  streamResolution: resolutionSortSql('wh."resolution"'),
};

/**
 * Page column id → route sort key; a column absent here is not sortable. One-to-one
 * (pinned by `tests/unit/media/history-sort`): the arrow is placed by the reverse map.
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
 * The ORDER BY expressions for `sortBy`. `Object.hasOwn`: a bare lookup of
 * "constructor" finds a prototype function and would be interpolated into the SQL.
 */
export function historySortSql(sortBy: string): readonly string[] {
  return Object.hasOwn(HISTORY_SORT_SQL, sortBy)
    ? HISTORY_SORT_SQL[sortBy as HistorySortKey]
    : HISTORY_SORT_SQL[DEFAULT_HISTORY_SORT_KEY];
}
