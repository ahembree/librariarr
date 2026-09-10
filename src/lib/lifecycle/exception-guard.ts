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

export interface ProtectionTarget {
  parentTitle: string | null;
  /** `MediaItem.seriesKey` — set on SERIES rows, null on movies/tracks. */
  seriesKey?: string | null;
  type: string;
}

/**
 * The group a whole-record action destroys, as the guard's lookup key. Both
 * halves of the guard — the exception lookup and the caller's check — go
 * through this so they cannot key on different things.
 *
 * SERIES keys on `seriesKey`, not `parentTitle`: the same show on two servers
 * can carry two titles under one TVDB id, and keyed on the title an exception on
 * one copy did not protect the other from a delete of the whole Sonarr series.
 * The fallback for a row with no key is `seriesKeyFromTitle`, the same string
 * `computeSeriesKey` derives, so a legacy row still collides with a backfilled
 * one. MUSIC keeps the normalized artist title (there is no artist-identity
 * column), namespaced by type so a same-named show and artist cannot cross.
 * Null for an item with no group (a movie — its own exception row is checked
 * directly by every caller).
 */
export function protectionKey(item: ProtectionTarget): string | null {
  const key =
    (item.type === "SERIES" ? item.seriesKey : null) ??
    (item.parentTitle ? seriesKeyFromTitle(item.parentTitle) : null);
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
 * Returns the `protectionKey`s for which ANY item of the same group carries a
 * `LifecycleException`; callers look their own targets up through
 * `protectionKey`. Over-blocking on the title fallback is deliberate — it only
 * skips a delete (logged) — while under-blocking destroys protected content.
 */
export async function findExceptionProtectedGroups(
  userId: string,
  items: ProtectionTarget[],
): Promise<Set<string>> {
  const parents = [...new Set(items.map((i) => i.parentTitle).filter((t): t is string => !!t))];
  const seriesKeys = [...new Set(items.map((i) => i.seriesKey).filter((k): k is string => !!k))];
  if (parents.length === 0 && seriesKeys.length === 0) return new Set();
  const types = [...new Set(items.map((i) => i.type))].filter(
    (t): t is MediaType => (VALID_TYPES as readonly string[]).includes(t),
  );

  // Search both columns: `parentTitle` alone misses an exception filed under the
  // other server's title for the same show, `seriesKey` alone misses one on a
  // row that predates the column. Each hit is then re-keyed through
  // `protectionKey`, so a same-titled DIFFERENT show comes back under its own
  // key and never matches the caller's.
  const exceptions = await prisma.lifecycleException.findMany({
    where: {
      userId,
      mediaItem: {
        OR: [
          ...(parents.length > 0 ? [{ parentTitle: { in: parents } }] : []),
          ...(seriesKeys.length > 0 ? [{ seriesKey: { in: seriesKeys } }] : []),
        ],
        ...(types.length > 0 ? { type: { in: types } } : {}),
      },
    },
    select: {
      mediaItem: { select: { parentTitle: true, seriesKey: true, type: true } },
    },
  });

  return new Set(
    exceptions
      .map((e) => protectionKey(e.mediaItem))
      .filter((k): k is string => !!k),
  );
}
