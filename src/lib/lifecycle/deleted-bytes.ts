import { prisma } from "@/lib/db";
import type { ActionOutcome } from "@/lib/lifecycle/actions";
import { artistMbidOf, type ArtistExternalIdLike } from "@/lib/media/artist-key";
import type { Prisma } from "@/generated/prisma/client";

export interface DeletedItem {
  libraryId: string;
  parentTitle: string | null;
  seriesKey?: string | null;
  fileSize: bigint | null;
  /** Read for `DELETE_LIDARR`: the artist's MusicBrainz id, when loaded. */
  externalIds?: ReadonlyArray<ArtistExternalIdLike> | null;
}

async function sumFileSizes(ids: string[]): Promise<bigint | null> {
  if (ids.length === 0) return null;
  const rows = await prisma.mediaItem.findMany({
    where: { id: { in: ids } },
    select: { fileSize: true },
  });
  const total = rows.reduce((sum, r) => sum + (r.fileSize ?? BigInt(0)), BigInt(0));
  return total > BigInt(0) ? total : null;
}

/**
 * The rows a whole-record delete removes in the item's library: every episode
 * of the show (`DELETE_SONARR`, keyed by `seriesKey`, the title only for a row
 * without one) or every track of the artist (`DELETE_LIDARR`: the tracks
 * carrying the artist's MusicBrainz id — the id Lidarr deletes the artist by —
 * and the same-titled tracks carrying none). Null for any other action, or an
 * item that names no show or artist.
 */
export function wholeRecordDeleteWhere(actionType: string, item: DeletedItem): Prisma.MediaItemWhereInput | null {
  if (actionType === "DELETE_SONARR" && item.parentTitle) {
    return {
      type: "SERIES",
      libraryId: item.libraryId,
      ...(item.seriesKey ? { seriesKey: item.seriesKey } : { parentTitle: item.parentTitle }),
    };
  }
  if (actionType === "DELETE_LIDARR" && item.parentTitle) {
    // Lidarr deletes the artist it resolves by id: every track carrying that
    // id, plus the artist's tracks that carry none (an untagged album is still
    // on disk under the artist). A same-named artist with ANOTHER id is not
    // counted. Without an id the action cannot resolve an artist at all, so
    // the title is all there is.
    const mbid = artistMbidOf(item.externalIds);
    return {
      type: "MUSIC",
      libraryId: item.libraryId,
      ...(mbid
        ? {
            OR: [
              { externalIds: { some: { source: "MUSICBRAINZ", externalId: mbid } } },
              { parentTitle: item.parentTitle, externalIds: { none: { source: "MUSICBRAINZ" } } },
            ],
          }
        : { parentTitle: item.parentTitle }),
    };
  }
  return null;
}

/**
 * The bytes an executed action freed, for the deletion stats. Shared by the
 * scheduled executor and `executeActionsForItems` so the two cannot count the
 * same action differently.
 *
 * - A whole-record delete removes every episode of the show (`DELETE_SONARR`,
 *   keyed by `seriesKey`, the title only for a row without one) or every track
 *   of the artist (`DELETE_LIDARR`: the tracks carrying the artist's
 *   MusicBrainz id — the id Lidarr deletes the artist by — and the same-titled
 *   tracks carrying none) in the item's library, whatever subset matched.
 * - A member-scoped file delete counts the members the executor reports as
 *   actually deleted (`outcome.deletedMemberIds`): one whose file it skipped,
 *   or could not find in the Arr app, freed nothing.
 * - Otherwise the matched members, or the item itself.
 */
export async function computeDeletedBytes(
  actionType: string,
  item: DeletedItem,
  memberIds: string[],
  outcome?: ActionOutcome | void,
): Promise<bigint | null> {
  if (!actionType.includes("DELETE")) return null;
  const group = wholeRecordDeleteWhere(actionType, item);
  if (group) {
    const agg = await prisma.mediaItem.aggregate({ where: group, _sum: { fileSize: true } });
    return agg._sum.fileSize ?? null;
  }
  if (outcome?.deletedMemberIds) return sumFileSizes(outcome.deletedMemberIds);
  if (memberIds.length > 0) return sumFileSizes(memberIds);
  return item.fileSize ?? null;
}
