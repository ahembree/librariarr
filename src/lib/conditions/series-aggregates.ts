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
export type SeriesAggregate<E extends AggregableEpisode> = Omit<E, "fileSize"> & {
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
    const key = `${ep.libraryId}::${ep.parentTitle ?? ep.libraryId}`;
    const group = seriesMap.get(key);
    if (group) {
      group.push(ep);
    } else {
      seriesMap.set(key, [ep]);
    }
  }

  const aggregated: Array<SeriesAggregate<E>> = [];

  for (const [, eps] of seriesMap) {
    eps.sort((a, b) => a.id.localeCompare(b.id));
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
 * Convert a `SeriesAggregate` into the plain object shape that the in-memory
 * rule evaluator expects (ISO date strings, computed `watchedEpisodePercentage`,
 * `availableEpisodeCount` alias for `episodeCount`, flattened `streams`).
 */
export function serializeSeriesAggregateForEval(
  series: SeriesAggregate<AggregableEpisode>,
): Record<string, unknown> {
  return {
    ...series,
    fileSize: series.fileSize,
    lastPlayedAt: toIsoOrNull(series.lastPlayedAt),
    addedAt: toIsoOrNull(series.addedAt),
    streams: series.allStreams ?? [],
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
