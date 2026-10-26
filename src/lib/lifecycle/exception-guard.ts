import { prisma } from "@/lib/db";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { seriesKeyFromTitle } from "@/lib/media/series-key";
import { artistMbidOf, type ArtistExternalIdLike } from "@/lib/media/artist-key";

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
  /**
   * The row's external ids. Read for MUSIC only, for the artist's MusicBrainz
   * id; a track passed without them is guarded by its title alone.
   */
  externalIds?: ReadonlyArray<ArtistExternalIdLike> | null;
}

/**
 * The group a whole-record action destroys, keyed by title (or `seriesKey`),
 * or null for an item with none (a movie — its own exception row is checked
 * directly by every caller).
 *
 * SERIES keys on `seriesKey`, not `parentTitle`: the same show on two servers
 * can carry two titles under one TVDB id, and keyed on the title an exception on
 * one copy did not protect the other from a delete of the whole Sonarr series.
 * The fallback for a row with no key is `seriesKeyFromTitle`, the same string
 * `computeSeriesKey` derives, so a legacy row still collides with a backfilled
 * one. MUSIC keys on the normalized artist title, namespaced by type so a
 * same-named show and artist cannot cross; `protectionKeys` adds its
 * MusicBrainz id.
 */
export function protectionKey(item: ProtectionTarget): string | null {
  const key =
    (item.type === "SERIES" ? item.seriesKey : null) ??
    (item.parentTitle ? seriesKeyFromTitle(item.parentTitle) : null);
  return key ? `${item.type}:${key}` : null;
}

/**
 * Every key a group is known by. An artist is known by its normalized title
 * AND by its MusicBrainz id, and an exception protects a target that shares
 * EITHER: the same id under another spelling is the one Lidarr artist, and the
 * same title is protected whatever the ids say. Telling two same-named artists
 * apart by id here would under-block whenever one artist carries two ids — an
 * id MusicBrainz has merged, which Lidarr resolves to the same artist — and
 * under-blocking deletes protected media, while over-blocking only skips a
 * delete. Empty for an item with no group.
 */
export function protectionKeys(item: ProtectionTarget): string[] {
  const key = protectionKey(item);
  const keys = key ? [key] : [];
  if (item.type === MUSIC) {
    const mbid = artistMbidOf(item.externalIds);
    if (mbid) keys.push(`${MUSIC}:mbid:${mbid}`);
  }
  return keys;
}

/** Whether the item belongs to a group a whole-record action destroys. */
export function hasProtectionGroup(item: ProtectionTarget): boolean {
  return protectionKeys(item).length > 0;
}

/**
 * Whether a whole-record action on `target` would destroy an excepted item:
 * `protectedSet` is what `findExceptionProtectedGroups` (or `protectionKeys`
 * over a set of excepted items) returned. False for an item with no group.
 */
export function isGroupProtected(protectedSet: ReadonlySet<string>, target: ProtectionTarget): boolean {
  if (protectedSet.size === 0) return false;
  return protectionKeys(target).some((k) => protectedSet.has(k));
}

const MUSIC = "MUSIC";

/**
 * Exception inviolability for whole-record destructive actions.
 *
 * The standard exception checks cover the action's representative item and its
 * MATCHED members (`matchedMediaItemIds`) — but a whole-record delete destroys
 * every episode/track of the group, including ones the rule never matched and
 * which therefore never enter the member list. An exception on such a
 * non-matching sibling would be silently destroyed.
 *
 * Returns the protection keys of every exception in the targets' groups;
 * callers test each target with `isGroupProtected`. Over-blocking on the title
 * fallback is deliberate — it only skips a delete (logged) — while
 * under-blocking destroys protected content.
 */
export async function findExceptionProtectedGroups(
  userId: string,
  items: ProtectionTarget[],
): Promise<Set<string>> {
  const parents = [...new Set(items.map((i) => i.parentTitle).filter((t): t is string => !!t))];
  const seriesKeys = [...new Set(items.map((i) => i.seriesKey).filter((k): k is string => !!k))];
  const artistMbids = [
    ...new Set(
      items
        .filter((i) => i.type === MUSIC)
        .map((i) => artistMbidOf(i.externalIds))
        .filter((m): m is string => !!m),
    ),
  ];
  if (parents.length === 0 && seriesKeys.length === 0 && artistMbids.length === 0) return new Set();
  const types = [...new Set(items.map((i) => i.type))].filter(
    (t): t is MediaType => (VALID_TYPES as readonly string[]).includes(t),
  );

  // Search every column a group can be found by: `parentTitle` alone misses an
  // exception filed under the other server's title for the same show (or
  // artist, by its MusicBrainz id), `seriesKey` alone misses one on a row that
  // predates the column. Each hit is then re-keyed, so a same-titled DIFFERENT
  // show comes back under its own key and never matches the caller's.
  //
  // In slices: the three lists share one statement, and a library-wide target
  // set (every artist of a music library) would put them past Postgres'
  // bind-parameter limit together. A third of a slice per list keeps any one
  // statement under it; the keys found are the union over the slices.
  const per = Math.floor(GROUP_LIST_CHUNK / 3);
  const slices = Math.max(parents.length, seriesKeys.length, artistMbids.length);
  const keys = new Set<string>();
  for (let at = 0; at < slices; at += per) {
    const parentSlice = parents.slice(at, at + per);
    const seriesKeySlice = seriesKeys.slice(at, at + per);
    const mbidSlice = artistMbids.slice(at, at + per);
    const exceptions = await prisma.lifecycleException.findMany({
      where: {
        userId,
        mediaItem: {
          OR: [
            // Case-insensitively, as the keys compare: an exception filed under
            // "nirvana" on one server protects "Nirvana" on another.
            ...(parentSlice.length > 0 ? [{ parentTitle: { in: parentSlice, mode: "insensitive" as const } }] : []),
            ...(seriesKeySlice.length > 0 ? [{ seriesKey: { in: seriesKeySlice } }] : []),
            ...(mbidSlice.length > 0
              ? [{
                  type: MUSIC as MediaType,
                  externalIds: { some: { source: "MUSICBRAINZ", externalId: { in: mbidSlice } } },
                }]
              : []),
          ],
          ...(types.length > 0 ? { type: { in: types } } : {}),
        },
      },
      select: {
        mediaItem: {
          select: {
            parentTitle: true,
            seriesKey: true,
            type: true,
            externalIds: { where: { source: "MUSICBRAINZ" }, select: { source: true, externalId: true } },
          },
        },
      },
    });
    for (const e of exceptions) for (const key of protectionKeys(e.mediaItem)) keys.add(key);
  }
  return keys;
}

/** Values per `findExceptionProtectedGroups` statement, across its three lists. */
const GROUP_LIST_CHUNK = 15_000;

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
    // Only the candidates are looked up: materialising every copy of every
    // excepted key would cost a whole-library read per call when thousands of
    // episodes are excepted and the caller asks about a handful of items. The
    // keys are intersected here rather than sent as a second list. The ids go
    // as ONE array parameter (`= ANY($1)`), never an IN list: with the owner
    // filter beside it Prisma did not split the list, and a track-scope music
    // rule set matching 38k tracks passed Postgres' 32,767 bind-parameter
    // limit (P2029) and failed the whole run.
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; dedupKey: string }>>(
      `SELECT mi."id", mi."dedupKey"
         FROM "MediaItem" mi
         JOIN "Library" l ON l."id" = mi."libraryId"
         JOIN "MediaServer" ms ON ms."id" = l."mediaServerId"
        WHERE mi."id" = ANY($1::text[])
          AND mi."dedupKey" IS NOT NULL
          AND ms."userId" = $2`,
      [...candidates],
      userId,
    );
    for (const r of rows) if (dedupKeys.has(r.dedupKey)) excepted.add(r.id);
  }
  return excepted;
}
