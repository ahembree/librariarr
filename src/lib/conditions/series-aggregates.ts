import { resolveSeriesKey } from "@/lib/media/series-key";
import { compareIds } from "@/lib/conditions/compare-ids";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import {
  anyEnabled,
  isArrField,
  isCrossSystemField,
  isSeerrField,
  isSeriesAggregateField,
  isStreamField,
} from "@/lib/conditions/helpers";
import { isStreamQueryField, isStreamQueryGroup } from "@/lib/conditions/stream-query";
import type { ConditionGroup } from "@/lib/conditions/types";

/**
 * Shared series-aggregate computation. Both the rule engine and the query
 * engine need to roll up episode rows into one aggregate-per-series record
 * before they can evaluate the 6 series-aggregate fields
 * (`watchedEpisodePercentage`, `availableEpisodeCount`, etc.).
 */

/** Minimal episode shape we depend on for aggregation. */
export interface AggregableEpisode {
  id: string;
  parentTitle: string | null;
  /**
   * Series identity (see src/lib/media/series-key.ts). Present on rows selected
   * with the `seriesKey` column; when absent it is recomputed from
   * `parentTitle` + `externalIds`. Two same-titled shows with different TVDB
   * ids get different keys, so they aggregate separately.
   */
  seriesKey?: string | null;
  /** Series-level external ids, used only to recompute seriesKey when unset. */
  externalIds?: ReadonlyArray<{ source: string; externalId: string }> | null;
  libraryId: string;
  playCount: number;
  fileSize: bigint | null;
  lastPlayedAt: Date | null;
  addedAt: Date | null;
  originallyAvailableAt: Date | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  title: string;
  summary?: string | null;
  parentSummary?: string | null;
  // Optional — only present when the caller `include`d streams
  streams?: unknown[];
  // Optional — only present when the caller `include`d watchHistory
  watchHistory?: Array<{ serverUsername: string | null }>;
}

/** A series-level aggregate, suitable for in-memory rule evaluation. */
type SeriesAggregate<E extends AggregableEpisode> = Omit<E, "fileSize"> & {
  episodeCount: number;
  /** Sum of all episode `fileSize` (BigInt) serialized as a string, or null when zero. */
  fileSize: string | null;
  watchedEpisodeCount: number;
  latestEpisodeViewDate: Date | null;
  lastEpisodeAddedAt: Date | null;
  lastEpisodeAiredAt: Date | null;
  /** Deduped usernames who played at least one episode (empty when not loaded). */
  watchedByUsers: string[];
  allStreams?: unknown[];
  memberIds: string[];
};

/**
 * Group episodes by `libraryId::parentTitle` and roll each group up into a
 * single representative record with computed series-level fields. Episode
 * lists are sorted by `id` for stable representative selection across syncs.
 */
export function aggregateEpisodesIntoSeries<E extends AggregableEpisode>(
  episodes: E[],
  options: { includeStreams?: boolean } = {},
): Array<SeriesAggregate<E>> {
  const { includeStreams = false } = options;

  const seriesMap = new Map<string, E[]>();
  for (const ep of episodes) {
    // Per-library series identity. Keeping the libraryId prefix means the same
    // show on two servers stays as two aggregates (each with its own episode
    // count) that the multi-server caller collapses by Arr id — merging them
    // here would double-count episodes. Within a library, keying on seriesKey
    // (not the ambiguous parentTitle) splits two same-titled shows.
    const key = `${ep.libraryId}::${resolveSeriesKey(ep) ?? ep.libraryId}`;
    const group = seriesMap.get(key);
    if (group) {
      group.push(ep);
    } else {
      seriesMap.set(key, [ep]);
    }
  }

  const aggregated: Array<SeriesAggregate<E>> = [];

  for (const [, eps] of seriesMap) {
    eps.sort((a, b) => compareIds(a.id, b.id));
    const representative = eps[0];

    const totalPlays = eps.reduce((sum, ep) => sum + ep.playCount, 0);
    const totalSize = eps.reduce(
      (sum, ep) => sum + (ep.fileSize ?? BigInt(0)),
      BigInt(0),
    );
    const latestPlayed = eps.reduce<Date | null>((latest, ep) => {
      if (!ep.lastPlayedAt) return latest;
      if (!latest || ep.lastPlayedAt > latest) return ep.lastPlayedAt;
      return latest;
    }, null);
    const earliestAdded = eps.reduce<Date | null>((earliest, ep) => {
      if (!ep.addedAt) return earliest;
      if (!earliest || ep.addedAt < earliest) return ep.addedAt;
      return earliest;
    }, null);

    const watchedCount = eps.filter((ep) => ep.playCount > 0).length;

    const latestEpisodeAdded = eps.reduce<Date | null>((latest, ep) => {
      if (!ep.addedAt) return latest;
      if (!latest || ep.addedAt > latest) return ep.addedAt;
      return latest;
    }, null);

    const latestEpisodeAired = eps.reduce<Date | null>((latest, ep) => {
      if (!ep.originallyAvailableAt) return latest;
      if (!latest || ep.originallyAvailableAt > latest) return ep.originallyAvailableAt;
      return latest;
    }, null);

    // Newest episode by season/episode number — its lastPlayedAt is the
    // "latestEpisodeViewDate" (i.e. did the user watch the latest episode?)
    const sortedByNewest = [...eps].sort((a, b) => {
      const seasonDiff = (b.seasonNumber ?? 0) - (a.seasonNumber ?? 0);
      if (seasonDiff !== 0) return seasonDiff;
      return (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0);
    });
    const latestEpisodeViewDate = sortedByNewest[0]?.lastPlayedAt ?? null;

    const allStreams = includeStreams
      ? eps.flatMap((ep) => (Array.isArray(ep.streams) ? ep.streams : []))
      : undefined;

    // Deduped raw usernames who played any episode in this series. Casing
    // is preserved (the rule evaluator lowercases at compare time). Empty
    // when no episode has watchHistory loaded (the caller didn't ask for
    // it). The `watchedByUser` rule evaluator distinguishes by checking
    // `Array.isArray(item.watchedByUsers)` — so we always emit the field.
    const watchedByUsers = Array.from(
      new Set(
        eps.flatMap((ep) =>
          Array.isArray(ep.watchHistory)
            ? ep.watchHistory.map((h) => h.serverUsername).filter((u): u is string => !!u)
            : [],
        ),
      ),
    );

    aggregated.push({
      ...representative,
      // Use series name as title so "title" rules match against the series.
      title: representative.parentTitle ?? representative.title,
      // Use series-level summary instead of episode summary.
      summary: representative.parentSummary ?? representative.summary,
      // Clear episode-specific fields — this is a series-level aggregate.
      // Evaluation reads the show's name as its parentTitle
      // (serializeSeriesAggregateForEval → withGroupParentTitle).
      parentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      playCount: totalPlays,
      fileSize: totalSize > BigInt(0) ? totalSize.toString() : null,
      lastPlayedAt: latestPlayed,
      addedAt: earliestAdded,
      episodeCount: eps.length,
      watchedEpisodeCount: watchedCount,
      latestEpisodeViewDate,
      lastEpisodeAddedAt: latestEpisodeAdded,
      lastEpisodeAiredAt: latestEpisodeAired,
      watchedByUsers,
      allStreams,
      memberIds: eps.map((ep) => ep.id),
    } as SeriesAggregate<E>);
  }

  return aggregated;
}

/**
 * A group record — a show rolled up from its episodes, an artist from its
 * tracks — as rule evaluation reads it.
 *
 * The group is stored and shown as itself: `title` is the show or the artist
 * and `parentTitle` is cleared. Every match snapshot consumer relies on that
 * shape (`matchIdentityChange`, `isGroupSnapshot`, the action's title
 * snapshot), so the records the engines return keep it. "Artist / Series"
 * (`parentTitle`) means the series name or the artist, though, so a group
 * answers it with its own name. Read as NULL it made `parentTitle equals "X"`
 * match no show, and every negated form (Not Equals, Not Contains, a NOT group)
 * match every show and artist — on a Delete from Sonarr / Lidarr rule set,
 * everything else the rules selected.
 */
export function withGroupParentTitle<T extends { title?: unknown }>(
  record: T,
): T & { parentTitle: string | null } {
  return { ...record, parentTitle: typeof record.title === "string" ? record.title : null };
}

/**
 * Whether a record the engines returned is a group record (see
 * `withGroupParentTitle`): a show or artist that carries its members, with the
 * name as its title and no parent.
 */
export function isGroupRecord(record: Record<string, unknown>): boolean {
  return Array.isArray(record.memberIds) && record.parentTitle == null && typeof record.title === "string";
}

/** The series-aggregate fields (`isSeriesAggregate` in the registry). */
const SERIES_AGGREGATE_FIELDS = CONDITION_FIELDS.filter((f) => f.isSeriesAggregate).map((f) => f.value);

// ─── A group judged through its members ───────────────────────────────────
//
// A show (its episodes) or an artist (its tracks) evaluated as a whole is ONE
// record. Some of its fields have a value for the whole group; every other
// per-item field (resolution, codecs, year, genres, duration, …) has one value
// per member and none for the group. Reading those off a single representative
// member (the lowest id) made "Resolution = 4K" match a show only when its
// first episode was 4K. A group matches a rule when at least ONE member
// satisfies the whole rule, each member seen as the group record carrying that
// member's own values for those fields. NOT forms follow: "NOT Resolution =
// 4K" matches a show with at least one episode that is not 4K.

/**
 * Fields a group record answers with ONE value for the whole show or artist
 * (series scope, artist scope): its name (`title`, and `parentTitle` through
 * `withGroupParentTitle`), the play total, the latest play, the earliest
 * addition, the summed size, everyone who watched any member, the union of the
 * members' streams (stream fields and stream queries), the cross-system values
 * folded across the members (`foldCrossSystemData`), the group's own external
 * ids (its Arr identity, which the Arr and Seerr lookups key on), the series
 * aggregates and every Arr or Seerr field (one record per group).
 */
const GROUP_VALUE_FIELDS = new Set([
  "title",
  "parentTitle",
  "playCount",
  "lastPlayedAt",
  "addedAt",
  "fileSize",
  "watchedByUser",
  "hasExternalId",
]);

/**
 * Whether a group record answers `field` with one value for the whole group;
 * every other field is answered per member (`memberValuesOf`).
 */
export function isGroupValueField(field: string): boolean {
  return (
    GROUP_VALUE_FIELDS.has(field) ||
    isStreamField(field) ||
    isStreamQueryField(field) ||
    isCrossSystemField(field) ||
    isSeriesAggregateField(field) ||
    isArrField(field) ||
    isSeerrField(field)
  );
}

/** The record key a condition field reads where it differs from the field's name. */
const FIELD_COLUMN: Record<string, string> = { genre: "genres", country: "countries" };

/**
 * The columns of a member a group record takes from that member: those of every
 * condition field the group does not answer as a whole (`isGroupValueField`).
 */
export const MEMBER_VALUE_COLUMNS: readonly string[] = CONDITION_FIELDS
  .filter((f) => !isGroupValueField(f.value))
  .map((f) => FIELD_COLUMN[f.value] ?? f.value);

/** A member's own values for the per-member fields (`MEMBER_VALUE_COLUMNS`). */
export function memberValuesOf(member: object): Record<string, unknown> {
  const row = member as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const column of MEMBER_VALUE_COLUMNS) {
    if (column in row) values[column] = row[column];
  }
  return values;
}

/**
 * Whether any enabled rule reads a field a group answers per member. When none
 * does, every member sees the same record, and a group is evaluated once.
 */
export function readsMemberValues(groups: ConditionGroup[]): boolean {
  return anyEnabled(groups, (rule) => !isGroupValueField(rule.field));
}

/** What `matchGroupThroughMembers` selected a group on. */
export interface GroupSelection {
  /** The record the rule held for: the group record, seen through the member. */
  record: Record<string, unknown>;
  /** That member's per-member values (empty when the group was evaluated once). */
  memberValues: Record<string, unknown>;
}

/**
 * Whether a group matches, and through which member: the first member, lowest
 * id first (`compareIds`), for which the group record carrying that member's
 * own per-member values (`memberValuesOf`) satisfies the rule, or `null` when
 * none does. Shared by the series- and artist-scope engines and Test Media.
 *
 * With `perMember` false (`readsMemberValues`: no rule reads a per-member
 * field) every member would see the same record, so the group record is
 * evaluated once, as it is.
 *
 * The caller stores and reports the selection — the group carrying the
 * selected member's values — so the match shows the values it was selected
 * on, not the representative's.
 */
export function matchGroupThroughMembers<M extends { id: string }>(
  group: Record<string, unknown>,
  members: readonly M[],
  matches: (record: Record<string, unknown>) => boolean,
  perMember: boolean,
): GroupSelection | null {
  if (!perMember) return matches(group) ? { record: group, memberValues: {} } : null;
  for (const member of [...members].sort((a, b) => compareIds(a.id, b.id))) {
    const memberValues = memberValuesOf(member);
    const record = { ...group, ...memberValues };
    if (matches(record)) return { record, memberValues };
  }
  return null;
}

/**
 * Fields every episode of a show answers alike when a per-episode rule set
 * (series scope off) is forced through the series path by a series-aggregate
 * field: the aggregates, injected as constants, and the Arr and Seerr fields,
 * read from the show's one record. Everything else is the episode's own —
 * including the fields a whole show answers as a group (`isGroupValueField`:
 * title, play count, size, streams, watchers, cross-system values, external
 * ids), because series scope off asks about episodes.
 */
function isSeriesConstantField(field: string): boolean {
  return isSeriesAggregateField(field) || isArrField(field) || isSeerrField(field);
}

/**
 * Whether any enabled rule reads a field an episode answers on its own
 * (`isSeriesConstantField`), or a stream query (an episode's own streams).
 * When none does, every episode of a show passes or fails alike.
 */
export function readsEpisodeValues(groups: ConditionGroup[]): boolean {
  return anyEnabled(groups, (rule) => !isSeriesConstantField(rule.field), (group) => isStreamQueryGroup(group));
}

/**
 * The episodes of a show that match one by one, each with the show's
 * series-aggregate values carried over as constants. Shared by the lifecycle
 * engine (`evaluateSeriesScope` with series scope off) and the query engine's
 * series-aggregate path, so the two select alike.
 *
 * A series-aggregate field (episode counts, watched %, …) has no value on a
 * single episode, so a rule reading one routes a per-episode rule set (series
 * scope off) or a query through the show's aggregate. The rule is still meant
 * per episode: the show is a match when at least one episode passes on its
 * own, and its members are exactly those episodes. The aggregate conditions
 * pass or fail alike for every episode and the per-episode conditions filter.
 * The show's own record is no gate: it read every per-episode field off its
 * representative episode, so "Available Episode Count ≥ 20 and Resolution =
 * 4K" missed a show whose first episode is 1080p and the others 4K. A show
 * with no such episode is not a match, even one passing only as a whole (a
 * summed file size, say).
 *
 * `matches(episode, seriesFields)` evaluates one episode with the caller's
 * evaluator, `seriesFields` spread last onto the episode's record. With
 * `perEpisode` false (`readsEpisodeValues`: the rule reads only aggregates, Arr
 * and Seerr fields) every episode would answer alike, so only the first is
 * evaluated and the show keeps all its episodes or none. Episodes are passed
 * lowest id first, so the first `matches` call to pass is the first member.
 */
export function episodesMatchingIndividually<E extends { id: string }>(
  episodes: readonly E[],
  aggregate: Record<string, unknown>,
  matches: (episode: E, seriesFields: Record<string, unknown>) => boolean,
  perEpisode: boolean = true,
): string[] {
  const seriesFields = Object.fromEntries(SERIES_AGGREGATE_FIELDS.map((field) => [field, aggregate[field]]));
  if (!perEpisode) {
    if (episodes.length === 0 || !matches(episodes[0], seriesFields)) return [];
    return episodes.map((episode) => episode.id);
  }
  return episodes.filter((episode) => matches(episode, seriesFields)).map((episode) => episode.id);
}

// From the global symbol registry, so every bundle's copy of this module reads
// the same key.
const EVALUATED_AS = Symbol.for("librariarr.conditions.evaluatedAs");

/**
 * Attach to a match record the record its rules were evaluated on, where the
 * two differ: a show matched through its episodes with series scope off is
 * stored as the show (its name, play total, summed size) but was selected on
 * its first matching episode's own values. The matched criteria and actual
 * values (`getMatchedCriteriaForItems`, `getActualValuesForAllRules`) read this
 * record, so they report what the match was selected on. Non-enumerable: a
 * spread or `JSON.stringify` never copies it, so a stored snapshot, a preview
 * row or an API response never carries it.
 */
export function withEvaluatedRecord<T extends object>(record: T, evaluated: Record<string, unknown>): T {
  Object.defineProperty(record, EVALUATED_AS, { value: evaluated, enumerable: false, configurable: true });
  return record;
}

/** The record attached by `withEvaluatedRecord`, if any. */
export function evaluatedRecordOf(record: object): Record<string, unknown> | undefined {
  return (record as { [EVALUATED_AS]?: Record<string, unknown> })[EVALUATED_AS];
}

/**
 * Convert a `SeriesAggregate` into the plain object shape that the in-memory
 * rule evaluator expects (ISO date strings, computed `watchedEpisodePercentage`,
 * `availableEpisodeCount` alias for `episodeCount`, flattened `streams`, and
 * the show's name as its `parentTitle` — `withGroupParentTitle`).
 */
export function serializeSeriesAggregateForEval(
  series: SeriesAggregate<AggregableEpisode>,
): Record<string, unknown> {
  return {
    ...withGroupParentTitle(series),
    fileSize: series.fileSize,
    lastPlayedAt: toIsoOrNull(series.lastPlayedAt),
    addedAt: toIsoOrNull(series.addedAt),
    streams: series.allStreams ?? [],
    // MAX(lastPlayedAt) across all episodes — exposed as the "Series Last Played"
    // aggregate field (distinct from per-episode lastPlayedAt and from
    // latestEpisodeViewDate, which is the newest episode's play date).
    seriesLastPlayedAt: toIsoOrNull(series.lastPlayedAt),
    latestEpisodeViewDate: toIsoOrNull(series.latestEpisodeViewDate),
    availableEpisodeCount: series.episodeCount,
    watchedEpisodeCount: series.watchedEpisodeCount,
    watchedEpisodePercentage: series.episodeCount > 0
      ? (series.watchedEpisodeCount / series.episodeCount) * 100
      : 0,
    lastEpisodeAddedAt: toIsoOrNull(series.lastEpisodeAddedAt),
    lastEpisodeAiredAt: toIsoOrNull(series.lastEpisodeAiredAt),
    watchedByUsers: series.watchedByUsers,
  };
}

function toIsoOrNull(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}
