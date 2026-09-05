import { prisma } from "@/lib/db";

/**
 * Series/artist group aggregation for the routes that display matches.
 *
 * A SERIES or MUSIC match is stored against ONE representative `MediaItem` —
 * an episode or a track — while the thing the user matched is the whole show or
 * artist. Detection records the group in `RuleMatch.itemData` (title = the show,
 * `parentTitle` cleared, plus `memberIds` for every episode), but a route that
 * re-fetches the `MediaItem` row by id gets the representative episode back
 * instead, with the episode's own title and its single file size.
 *
 * That shape difference is visible: `MediaTable` picks its title format off
 * `matchedEpisodes`, so a row without it falls into the per-episode branch and
 * renders "The Show — Pilot" where a properly aggregated row renders
 * "The Show". The rules-preview table merges rows from two endpoints, so the
 * mismatch showed up as removed series rendering differently from added ones.
 *
 * These helpers are shared by every such route so the two can't drift again.
 * Totals are recomputed from the members' CURRENT rows rather than read out of
 * the stored snapshot, so a preview reflects the library as it is now.
 */

export interface GroupMemberStats {
  fileSize: bigint;
  playCount: number;
  lastPlayedAt: Date | null;
}

export interface GroupTotals {
  fileSize: bigint;
  playCount: number;
  lastPlayedAt: Date | null;
  matchedEpisodes: number;
}

/**
 * Fetch the per-member stats needed to roll groups up, for every member id
 * across a whole page of matches in one query. Ids that no longer exist are
 * simply absent from the map — a member deleted since detection contributes
 * nothing rather than failing the request.
 */
export async function loadGroupMemberStats(
  memberIds: string[],
): Promise<Map<string, GroupMemberStats>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return new Map();
  const members = await prisma.mediaItem.findMany({
    where: { id: { in: unique } },
    select: { id: true, fileSize: true, playCount: true, lastPlayedAt: true },
  });
  return new Map(
    members.map((m) => [
      m.id,
      { fileSize: m.fileSize ?? BigInt(0), playCount: m.playCount, lastPlayedAt: m.lastPlayedAt },
    ]),
  );
}

/**
 * Roll a match's member ids up into group-level totals. Returns `null` when
 * there is no group to aggregate — a movie match, or a match stored before
 * member ids were recorded — so callers leave the item's own values alone
 * rather than zeroing them.
 */
export function aggregateGroupMembers(
  memberIds: string[],
  stats: Map<string, GroupMemberStats>,
): GroupTotals | null {
  if (memberIds.length === 0) return null;
  let fileSize = BigInt(0);
  let playCount = 0;
  let lastPlayedAt: Date | null = null;
  for (const id of memberIds) {
    const member = stats.get(id);
    if (!member) continue;
    fileSize += member.fileSize;
    playCount += member.playCount;
    if (member.lastPlayedAt && (!lastPlayedAt || member.lastPlayedAt > lastPlayedAt)) {
      lastPlayedAt = member.lastPlayedAt;
    }
  }
  return { fileSize, playCount, lastPlayedAt, matchedEpisodes: memberIds.length };
}

/**
 * The member ids a `RuleMatch`'s stored `itemData` recorded. Empty for movies
 * and for anything stored without them.
 */
export function memberIdsFromItemData(itemData: unknown): string[] {
  const ids = (itemData as Record<string, unknown> | null)?.memberIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}
