/**
 * Per-episode criteria — Season Number, Episode Number and Seasons Behind
 * Latest (`episodeLevel` in the field registry).
 *
 * `seasonNumber` and `episodeNumber` are `MediaItem` columns and compile to
 * Phase 1 WHERE like any numeric column. `seasonsBehindLatest` has no column:
 * it is how many season numbers an episode's season lies behind the newest
 * numbered season of its show in the same library — 0 for the newest season,
 * 1 for the one before, and so on. Specials (season 0) and episodes without a
 * season number have no value (NULL). The show is the episode's `seriesKey`
 * within its library, the per-library identity both rule engines group on, so
 * the same show on two servers is measured against each library's own copy.
 *
 * Both engines attach the value to every SERIES candidate before Phase 2
 * (`attachSeasonsBehindLatest`); `hasSeasonsBehindLatestRules` forces Phase 2
 * and the WHERE builder returns `{}` for the field.
 *
 * The fields are answerable only for an episode. A series aggregate has no
 * season or episode number, so:
 *  - a lifecycle rule set using one must have series scope off (refused by the
 *    rule set routes, `checkLifecycleRuleEvaluability` and the rule builder);
 *  - where a series aggregate is still evaluated (a series-aggregate field forces
 *    the aggregate path), the aggregate gate treats these rules as satisfied
 *    (`EPISODE_LEVEL_FIELDS` as the evaluators' `relaxedFields`) and the
 *    per-episode pass that follows decides which episodes match.
 *
 * A grouped match (one row per show) carries `episodeFieldValues`, the distinct
 * values of each field across its matched episodes (`summarizeEpisodeFields`),
 * so the matched criteria and actual values a match reports describe the
 * episodes it selected.
 */
import { prisma } from "@/lib/db";
import { resolveSeriesKey } from "@/lib/media/series-key";
import { SEASONS_BEHIND_LATEST_FIELD } from "./helpers";

/** Key of a show within one library, as the latest-season map stores it. */
export function latestSeasonKey(libraryId: string, seriesKey: string): string {
  return `${libraryId}::${seriesKey}`;
}

/**
 * The newest numbered season (season > 0) of every show in the given
 * libraries, keyed by `latestSeasonKey`. One row per show.
 */
export async function loadLatestSeasons(libraryIds: string[]): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  const ids = [...new Set(libraryIds)];
  if (ids.length === 0) return latest;
  const rows = await prisma.$queryRaw<Array<{ libraryId: string; seriesKey: string; latest: number }>>`
    SELECT "libraryId", "seriesKey", MAX("seasonNumber")::int AS latest
    FROM "MediaItem"
    WHERE type = 'SERIES'
      AND "libraryId" = ANY(${ids}::text[])
      AND "seriesKey" IS NOT NULL
      AND "seasonNumber" > 0
    GROUP BY "libraryId", "seriesKey"
  `;
  for (const row of rows) latest.set(latestSeasonKey(row.libraryId, row.seriesKey), row.latest);
  return latest;
}

/** Seasons behind the newest season, or null for a special, an unnumbered episode or an unknown show. */
export function seasonsBehindLatestOf(
  seasonNumber: number | null | undefined,
  latestSeason: number | null | undefined,
): number | null {
  if (seasonNumber == null || seasonNumber <= 0 || latestSeason == null) return null;
  return Math.max(0, latestSeason - seasonNumber);
}

interface EpisodeLike {
  type?: unknown;
  libraryId?: unknown;
  seasonNumber?: unknown;
  seriesKey?: unknown;
  parentTitle?: unknown;
  externalIds?: unknown;
}

function seriesKeyOf(item: EpisodeLike): string | null {
  return resolveSeriesKey({
    seriesKey: (item.seriesKey as string | null | undefined) ?? null,
    parentTitle: (item.parentTitle as string | null | undefined) ?? null,
    externalIds: Array.isArray(item.externalIds)
      ? (item.externalIds as Array<{ source: string; externalId: string }>)
      : null,
  });
}

/**
 * Set `seasonsBehindLatest` on every item (in place): the value for a SERIES
 * episode, null for anything else. One query for the items' libraries.
 */
export async function attachSeasonsBehindLatest<T extends object>(items: T[]): Promise<T[]> {
  const episodes = items.filter((i) => (i as EpisodeLike).type === "SERIES");
  const libraryIds = episodes
    .map((i) => (i as EpisodeLike).libraryId)
    .filter((id): id is string => typeof id === "string");
  const latest = libraryIds.length > 0 ? await loadLatestSeasons(libraryIds) : new Map<string, number>();
  for (const item of items) {
    const ep = item as EpisodeLike;
    let value: number | null = null;
    if (ep.type === "SERIES" && typeof ep.libraryId === "string") {
      const key = seriesKeyOf(ep);
      value = key
        ? seasonsBehindLatestOf(ep.seasonNumber as number | null, latest.get(latestSeasonKey(ep.libraryId, key)))
        : null;
    }
    (item as Record<string, unknown>)[SEASONS_BEHIND_LATEST_FIELD] = value;
  }
  return items;
}

/** Distinct values of each per-episode field across a group's episodes (null included when present). */
export type EpisodeFieldValues = Record<string, Array<number | null>>;

const SUMMARIZED_FIELDS = ["seasonNumber", "episodeNumber", SEASONS_BEHIND_LATEST_FIELD] as const;

/**
 * The distinct values of each per-episode field across `episodes`, sorted,
 * null last. `seasonsBehindLatest` is summarized only when the episodes carry
 * it (it is attached only for a rule set that reads it).
 */
export function summarizeEpisodeFields(episodes: ReadonlyArray<Record<string, unknown>>): EpisodeFieldValues {
  const out: EpisodeFieldValues = {};
  for (const field of SUMMARIZED_FIELDS) {
    if (field === SEASONS_BEHIND_LATEST_FIELD && !episodes.some((e) => field in e)) continue;
    const seen = new Set<number | null>();
    for (const ep of episodes) {
      const v = ep[field];
      seen.add(typeof v === "number" && Number.isFinite(v) ? v : null);
    }
    out[field] = [...seen].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  }
  return out;
}

/** The group's distinct values for one per-episode field, or undefined when the record is not a summarized group. */
export function episodeFieldValuesOf(
  item: Record<string, unknown>,
  field: string,
): Array<number | null> | undefined {
  const summary = item.episodeFieldValues as EpisodeFieldValues | undefined;
  if (!summary || typeof summary !== "object") return undefined;
  const values = summary[field];
  return Array.isArray(values) ? values : undefined;
}

/**
 * Display text for a list of per-episode values: consecutive runs collapse to
 * ranges ("1–3, 5"); a null member reads "none".
 */
export function formatEpisodeFieldValues(values: ReadonlyArray<number | null>): string {
  const nums = [...new Set(values.filter((v): v is number => v !== null))].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
    i = j + 1;
  }
  if (values.some((v) => v === null)) parts.push("none");
  return parts.length > 0 ? parts.join(", ") : "none";
}
