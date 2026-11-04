import { resolveSeriesKey } from "@/lib/media/series-key";
import { compareIds } from "@/lib/conditions/compare-ids";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";

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

/**
 * The episodes of a show that matched as a whole which also match one by one.
 * Shared by the lifecycle engine (`evaluateSeriesScope` with series scope off)
 * and the query engine's series-aggregate path, so the two narrow alike.
 *
 * A series-aggregate field (episode counts, watched %, …) has no value on a
 * single episode, so a rule reading one is evaluated against the show's
 * aggregate, where every per-episode field (resolution, file size, …) reads the
 * representative episode's value. Where the rule is meant per episode, the
 * show's members are narrowed to the episodes that pass on their own, each
 * re-evaluated with the aggregate's series-aggregate values carried over as
 * series-level constants: the aggregate conditions pass for every episode and
 * only the per-episode conditions filter. Kept whole, "Available Episode Count
 * ≥ 20 and Resolution = 4K" on a show whose first episode is 4K returned — and
 * a file delete acted on — every 1080p episode too. A show with no such episode
 * is not a match: it passed only as a whole (a summed file size, say).
 *
 * `matches(episode, seriesFields)` evaluates one episode with the caller's
 * evaluator, `seriesFields` spread last onto the episode's record.
 */
export function episodesMatchingIndividually<E extends { id: string }>(
  episodes: readonly E[],
  aggregate: Record<string, unknown>,
  matches: (episode: E, seriesFields: Record<string, unknown>) => boolean,
): string[] {
  const seriesFields = Object.fromEntries(SERIES_AGGREGATE_FIELDS.map((field) => [field, aggregate[field]]));
  return episodes.filter((episode) => matches(episode, seriesFields)).map((episode) => episode.id);
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
