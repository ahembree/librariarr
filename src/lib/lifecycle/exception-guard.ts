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

/**
 * The ids among `candidateIds` that a `LifecycleException` protects: one filed
 * on the item itself, or on any other copy of it — the same `dedupKey` — on
 * any of the user's servers or libraries.
 *
 * An action resolves its Arr record by external id, so it acts on the one
 * record every copy of a title is backed by, and an exception filed on
 * whichever copy the user happened to be looking at must hold for the others.
 * Keyed on the id alone it did not: the Matches page shows a multi-server
 * title as ONE row (detection collapses the copies onto one representative),
 * excluding that row filed the exception on the representative, and the next
 * run matched the other copy, scheduled a fresh action for it, and deleted the
 * title the user had just excluded. `dedupKey` is the same identity the
 * library already uses to present those copies as one title. Over-blocking on
 * it only skips an action; under-blocking destroys protected media.
 */
export async function findExceptedItemIds(
  userId: string,
  candidateIds: Iterable<string>,
): Promise<Set<string>> {
  const candidates = new Set(candidateIds);
  const excepted = new Set<string>();
  if (candidates.size === 0) return excepted;

  const exceptions = await prisma.lifecycleException.findMany({
    where: { userId },
    select: { mediaItemId: true, mediaItem: { select: { dedupKey: true } } },
  });
  const dedupKeys = new Set<string>();
  for (const e of exceptions) {
    if (candidates.has(e.mediaItemId)) excepted.add(e.mediaItemId);
    const key = e.mediaItem?.dedupKey;
    if (key) dedupKeys.add(key);
  }
  if (dedupKeys.size > 0) {
    const copies = await prisma.mediaItem.findMany({
      where: { dedupKey: { in: [...dedupKeys] }, library: { mediaServer: { userId } } },
      select: { id: true },
    });
    for (const c of copies) if (candidates.has(c.id)) excepted.add(c.id);
  }
  return excepted;
}
