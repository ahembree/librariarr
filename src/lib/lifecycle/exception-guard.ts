import { prisma } from "@/lib/db";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { seriesKeyFromTitle } from "@/lib/media/series-key";

type MediaType = "MOVIE" | "SERIES" | "MUSIC";
const VALID_TYPES: readonly MediaType[] = ["MOVIE", "SERIES", "MUSIC"];

/**
 * Whether an action destroys the WHOLE Arr record (series/artist/movie) rather
 * than acting only on the matched member episodes/tracks. DELETE_SONARR and
 * DELETE_LIDARR remove every episode/track of the group — including ones the
 * rule never matched.
 */
export function isWholeRecordDestructiveAction(actionType: string): boolean {
  return isDestructiveActionType(actionType) && !actionHonorsMemberIds(actionType);
}

/** The item shape both halves of the guard identify a group by. */
export interface ProtectionTarget {
  parentTitle: string | null;
  /** `MediaItem.seriesKey` — present on SERIES rows, null on movies/tracks. */
  seriesKey?: string | null;
  type: string;
}

/**
 * The group identity a whole-record action would destroy, and the guard's
 * lookup key.
 *
 * SERIES keys on `seriesKey`, never on `parentTitle`, because this is the one
 * place where under-blocking DESTROYS protected content. The same show on two
 * servers can legitimately carry two titles ("The Office" vs "The Office (US)")
 * while sharing one TVDB-derived key — and keyed on the title, an exception
 * placed on one server's copy did not protect the other from a DELETE_SONARR
 * that removes the whole Sonarr series. That is also the identity every other
 * series-grouping path in the app uses (see "Series identity" in CLAUDE.md).
 *
 * The title fallback is `seriesKeyFromTitle`, the SAME string `computeSeriesKey`
 * produces when a row has no provider ids, so a legacy row that predates the
 * column still collides with a backfilled one.
 *
 * MUSIC keeps the normalized artist title — there is no artist-identity column
 * — and is namespaced by type so a same-named show and artist cannot cross.
 * Returns null for an item with no group to protect (a movie: its own exception
 * row is checked directly by every caller).
 */
export function protectionKey(item: ProtectionTarget): string | null {
  if (item.type === "SERIES") {
    const key =
      item.seriesKey ?? (item.parentTitle ? seriesKeyFromTitle(item.parentTitle) : null);
    return key ? `SERIES:${key}` : null;
  }
  const key = item.parentTitle ? seriesKeyFromTitle(item.parentTitle) : null;
  return key ? `${item.type}:${key}` : null;
}

/**
 * Exception inviolability for whole-record destructive actions.
 *
 * The standard exception checks cover the action's representative item and its
 * MATCHED members (`matchedMediaItemIds`) — but a whole-record delete destroys
 * every episode/track of the group, including ones the rule never matched and
 * which therefore never enter the member list. An exception on such a
 * non-matching sibling would be silently destroyed.
 *
 * Given candidate action targets, this returns the set of `protectionKey`s for
 * which ANY item of the same group carries a `LifecycleException`, so callers
 * can refuse the whole-record action for those. Callers must look their own
 * targets up through `protectionKey` as well — passing the key through both
 * halves is what stops the two from keying on different things.
 *
 * Over-blocking is still deliberately preferred: a group resolved to the title
 * fallback blocks anything else that resolves to the same title, which merely
 * skips a delete (logged), while under-blocking destroys protected content.
 *
 * Movies (parentTitle null) are unaffected: their own exception row is already
 * checked directly by every caller.
 */
export async function findExceptionProtectedGroups(
  userId: string,
  items: ProtectionTarget[],
): Promise<Set<string>> {
  const wanted = new Set<string>();
  for (const item of items) {
    const key = protectionKey(item);
    if (key) wanted.add(key);
  }
  if (wanted.size === 0) return new Set();

  const parents = [...new Set(items.map((i) => i.parentTitle).filter((t): t is string => !!t))];
  const seriesKeys = [...new Set(items.map((i) => i.seriesKey).filter((k): k is string => !!k))];
  const types = [...new Set(items.map((i) => i.type))].filter(
    (t): t is MediaType => (VALID_TYPES as readonly string[]).includes(t),
  );

  // Both columns are searched, then every candidate is re-keyed through
  // `protectionKey` and intersected with what the caller asked about. Matching
  // on `parentTitle` alone would miss an exception filed under the other
  // server's title for the same show; matching on `seriesKey` alone would miss
  // one on a row that predates the column. Fetching the union and deciding in
  // one place keeps the SQL from having to encode the precedence twice.
  const orClauses = [
    ...(parents.length > 0 ? [{ parentTitle: { in: parents } }] : []),
    ...(seriesKeys.length > 0 ? [{ seriesKey: { in: seriesKeys } }] : []),
  ];
  if (orClauses.length === 0) return new Set();

  const exceptions = await prisma.lifecycleException.findMany({
    where: {
      userId,
      mediaItem: {
        OR: orClauses,
        ...(types.length > 0 ? { type: { in: types } } : {}),
      },
    },
    select: {
      mediaItem: { select: { parentTitle: true, seriesKey: true, type: true } },
    },
  });

  const protectedKeys = new Set<string>();
  for (const exception of exceptions) {
    const key = protectionKey(exception.mediaItem);
    // Only keys the caller actually asked about: the OR above can return an
    // exception on a same-titled DIFFERENT show, which must not block this one.
    if (key && wanted.has(key)) protectedKeys.add(key);
  }
  return protectedKeys;
}
