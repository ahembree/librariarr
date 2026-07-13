import { prisma } from "@/lib/db";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";

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

/**
 * Exception inviolability for whole-record destructive actions.
 *
 * The standard exception checks cover the action's representative item and its
 * MATCHED members (`matchedMediaItemIds`) — but a whole-record delete destroys
 * every episode/track of the series/artist, including ones the rule never
 * matched and which therefore never enter the member list. An exception on
 * such a non-matching sibling would be silently destroyed.
 *
 * Given candidate action targets, this returns the set of `parentTitle`s
 * (series/artist names) for which ANY item of the same parent and type carries
 * a LifecycleException, so callers can refuse the whole-record action for
 * those. Matching is deliberately by (parentTitle, type) across the user's
 * items — over-blocking a same-titled group elsewhere merely skips a delete
 * (logged), while under-blocking destroys protected content.
 *
 * Movies (parentTitle null) are unaffected: their own exception row is already
 * checked directly by every caller.
 */
export async function findExceptionProtectedParents(
  userId: string,
  items: Array<{ parentTitle: string | null; type: string }>,
): Promise<Set<string>> {
  const parents = [...new Set(items.map((i) => i.parentTitle).filter((t): t is string => !!t))];
  if (parents.length === 0) return new Set();
  const types = [...new Set(items.map((i) => i.type))].filter(
    (t): t is MediaType => (VALID_TYPES as readonly string[]).includes(t),
  );

  const exceptions = await prisma.lifecycleException.findMany({
    where: {
      userId,
      mediaItem: {
        parentTitle: { in: parents },
        ...(types.length > 0 ? { type: { in: types } } : {}),
      },
    },
    select: { mediaItem: { select: { parentTitle: true } } },
  });

  return new Set(
    exceptions
      .map((e) => e.mediaItem.parentTitle)
      .filter((t): t is string => !!t),
  );
}
