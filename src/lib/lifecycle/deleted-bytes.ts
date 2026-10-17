import { prisma } from "@/lib/db";
import type { ActionOutcome } from "@/lib/lifecycle/actions";
import { artistMbidOf, type ArtistExternalIdLike } from "@/lib/media/artist-key";

interface DeletedItem {
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
  if (actionType === "DELETE_SONARR" && item.parentTitle) {
    const agg = await prisma.mediaItem.aggregate({
      where: {
        type: "SERIES",
        libraryId: item.libraryId,
        ...(item.seriesKey ? { seriesKey: item.seriesKey } : { parentTitle: item.parentTitle }),
      },
      _sum: { fileSize: true },
    });
    return agg._sum.fileSize ?? null;
  }
  if (actionType === "DELETE_LIDARR" && item.parentTitle) {
    // Lidarr deletes the artist it resolves by id: every track carrying that
    // id, plus the artist's tracks that carry none (an untagged album is still
    // on disk under the artist). A same-named artist with ANOTHER id is not
    // counted. Without an id the action cannot resolve an artist at all, so
    // the title is all there is.
    const mbid = artistMbidOf(item.externalIds);
    const agg = await prisma.mediaItem.aggregate({
      where: {
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
      },
      _sum: { fileSize: true },
    });
    return agg._sum.fileSize ?? null;
  }
  if (outcome?.deletedMemberIds) return sumFileSizes(outcome.deletedMemberIds);
  if (memberIds.length > 0) return sumFileSizes(memberIds);
  return item.fileSize ?? null;
}
