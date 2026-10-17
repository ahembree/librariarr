import { prisma } from "@/lib/db";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { seriesKeyFromTitle } from "@/lib/media/series-key";
import { artistMbidOf, normalizeArtistTitle, type ArtistExternalIdLike } from "@/lib/media/artist-key";

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
   * id; a target passed without them is guarded by its title alone, which
   * only ever over-blocks (see `musicTargetKeys`).
   */
  externalIds?: ReadonlyArray<ArtistExternalIdLike> | null;
}

/**
 * The group a whole-record action destroys, or null for an item with no group
 * (a movie — its own exception row is checked directly by every caller).
 *
 * SERIES keys on `seriesKey`, not `parentTitle`: the same show on two servers
 * can carry two titles under one TVDB id, and keyed on the title an exception on
 * one copy did not protect the other from a delete of the whole Sonarr series.
 * The fallback for a row with no key is `seriesKeyFromTitle`, the same string
 * `computeSeriesKey` derives, so a legacy row still collides with a backfilled
 * one. MUSIC's group is the normalized artist title, namespaced by type so a
 * same-named show and artist cannot cross — but whether an exception in that
 * group protects a target is decided by `isGroupProtected`, which also reads
 * the artist's MusicBrainz id.
 */
export function protectionKey(item: ProtectionTarget): string | null {
  const key =
    (item.type === "SERIES" ? item.seriesKey : null) ??
    (item.parentTitle ? seriesKeyFromTitle(item.parentTitle) : null);
  return key ? `${item.type}:${key}` : null;
}

/*
 * MUSIC keys. An artist title can name two different artists ("Nirvana",
 * "Bush"), told apart only by their MusicBrainz ids, and coverage of that id
 * can be partial. The rule, pairwise between an exception E and a target T of
 * the same normalized title:
 *
 *   - both carry an id  → protected only when the ids are equal;
 *   - either lacks one  → protected (the title is all there is to go on).
 *
 * Plus: equal ids under DIFFERENT titles (one artist spelled two ways on two
 * servers) are protected — the Lidarr action resolves the one artist by id.
 *
 * Encoded as key sets so the guard stays a set lookup. E contributes
 * `mbid:<id>` + `id-title:<t>` when it has an id, else `bare-title:<t>`; T
 * contributes `mbid:<id>` + `bare-title:<t>` when it has an id, else
 * `bare-title:<t>` + `id-title:<t>`. T is protected iff they share a key.
 */
const MUSIC = "MUSIC";

function musicExceptionKeys(item: ProtectionTarget): string[] {
  const title = item.parentTitle ? normalizeArtistTitle(item.parentTitle) : "";
  const mbid = artistMbidOf(item.externalIds);
  const keys: string[] = [];
  if (mbid) {
    keys.push(`${MUSIC}:mbid:${mbid}`);
    if (title) keys.push(`${MUSIC}:id-title:${title}`);
  } else if (title) {
    keys.push(`${MUSIC}:bare-title:${title}`);
  }
  return keys;
}

function musicTargetKeys(item: ProtectionTarget): string[] {
  const title = item.parentTitle ? normalizeArtistTitle(item.parentTitle) : "";
  const mbid = artistMbidOf(item.externalIds);
  const keys: string[] = [];
  if (mbid) keys.push(`${MUSIC}:mbid:${mbid}`);
  if (title) {
    // Any exception without an id under this title protects it…
    keys.push(`${MUSIC}:bare-title:${title}`);
    // …and, when the target's own id is unknown, any exception under it at all.
    if (!mbid) keys.push(`${MUSIC}:id-title:${title}`);
  }
  return keys;
}

/** The keys an EXCEPTION on `item` puts into the protected set. */
export function exceptionProtectionKeys(item: ProtectionTarget): string[] {
  if (item.type === MUSIC) return musicExceptionKeys(item);
  const key = protectionKey(item);
  return key ? [key] : [];
}

/**
 * Whether a whole-record action on `target` would destroy an excepted item:
 * `protectedSet` is what `findExceptionProtectedGroups` (or
 * `exceptionProtectionKeys` over a set of excepted items) returned. False for
 * an item with no group.
 */
export function isGroupProtected(protectedSet: ReadonlySet<string>, target: ProtectionTarget): boolean {
  if (protectedSet.size === 0) return false;
  if (target.type === MUSIC) return musicTargetKeys(target).some((k) => protectedSet.has(k));
  const key = protectionKey(target);
  return !!key && protectedSet.has(key);
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
  // show or artist comes back under its own key and never matches the caller's.
  const exceptions = await prisma.lifecycleException.findMany({
    where: {
      userId,
      mediaItem: {
        OR: [
          ...(parents.length > 0 ? [{ parentTitle: { in: parents } }] : []),
          ...(seriesKeys.length > 0 ? [{ seriesKey: { in: seriesKeys } }] : []),
          ...(artistMbids.length > 0
            ? [{
                type: MUSIC as MediaType,
                externalIds: { some: { source: "MUSICBRAINZ", externalId: { in: artistMbids } } },
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

  return new Set(exceptions.flatMap((e) => exceptionProtectionKeys(e.mediaItem)));
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
    // Only the candidates are looked up: materialising every copy of every
    // excepted key would cost a whole-library read per call when thousands of
    // episodes are excepted and the caller asks about a handful of items. The
    // keys are intersected here rather than sent as a second IN list: Prisma
    // splits only one oversized list per query, so two large ones together
    // overflow the bind-parameter limit (P2029) and fail the whole run.
    const rows = await prisma.mediaItem.findMany({
      where: {
        id: { in: [...candidates] },
        dedupKey: { not: null },
        library: { mediaServer: { userId } },
      },
      select: { id: true, dedupKey: true },
    });
    for (const r of rows) if (r.dedupKey && dedupKeys.has(r.dedupKey)) excepted.add(r.id);
  }
  return excepted;
}
