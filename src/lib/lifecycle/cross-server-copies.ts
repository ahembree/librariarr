import { prisma } from "@/lib/db";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";
import { actionHonorsMemberIds } from "@/lib/lifecycle/action-types";

/** The external-id source a rule set's Arr family resolves its records by. */
export function arrIdSourceFor(type: "MOVIE" | "SERIES" | "MUSIC"): string {
  return type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
}

/**
 * The external id each item's Arr app resolves it by (`arrIdSourceFor`), keyed
 * by item id: read from the item's own `externalIds` where it carries them,
 * and — unless `loadMissing` is false — loaded in one query for the items that
 * carry none (the engine returns `externalIds` only when a rule needed them).
 * An item with no such id is absent from the map. The one place detection's
 * collapse key, the id detection records on a match and the id scheduling
 * records on an action are read, so the three cannot disagree.
 */
export async function arrExternalIdsOf(
  type: "MOVIE" | "SERIES" | "MUSIC",
  items: Record<string, unknown>[],
  opts: { loadMissing?: boolean } = {},
): Promise<Map<string, string>> {
  const source = arrIdSourceFor(type);
  const ids = new Map<string, string>();
  const missing: string[] = [];
  for (const item of items) {
    if (!Array.isArray(item.externalIds)) {
      missing.push(item.id as string);
      continue;
    }
    const found = (item.externalIds as Array<{ source?: unknown; externalId?: unknown } | null>)
      .find((e) => e?.source === source)?.externalId;
    if (typeof found === "string") ids.set(item.id as string, found);
  }
  if (missing.length > 0 && opts.loadMissing !== false) {
    const rows = await prisma.mediaItemExternalId.findMany({
      where: { mediaItemId: { in: missing }, source },
      select: { mediaItemId: true, externalId: true },
    });
    for (const r of rows) ids.set(r.mediaItemId, r.externalId);
  }
  return ids;
}

/**
 * Whether a track-scope music rule set folds every matched track of an artist
 * into ONE match (its tracks recorded as members). Every Lidarr action but the
 * member-scoped file deletes acts on the ARTIST, so one action per track ran
 * the same artist action once per track — a whole-artist delete succeeded once
 * and failed "not found" for the rest, and the deletion ceiling counted every
 * track — on one server as on several. Mirrors `collapseActionItems` on the
 * query page. "Do Nothing" keeps one match per track.
 */
export function groupsTracksByArtist(opts: {
  type: "MOVIE" | "SERIES" | "MUSIC";
  trackScope: boolean;
  actionArmed: boolean;
  actionType?: string | null;
}): boolean {
  return (
    opts.type === "MUSIC" &&
    opts.trackScope &&
    opts.actionArmed &&
    !!opts.actionType &&
    opts.actionType !== "DO_NOTHING" &&
    !actionHonorsMemberIds(opts.actionType)
  );
}

/**
 * The cross-server identity detection collapses copies of one title by: the
 * external id the rule set's Arr family resolves its record by, for every item
 * that can be collapsed — keyed by item id; an item absent from the map stays
 * a match of its own.
 *
 * With Arr metadata fetched, only an item that resolved to an Arr record is
 * collapsible. With none fetched (no Arr criteria), every item is, but only
 * when an action is armed: the action still resolves its record by this id on
 * the rule set's one Arr instance, while a collection-only rule set keeps one
 * match per copy. Ids the engine returned without external ids are loaded.
 * Shared by detection and the rule diff so the preview counts titles the way
 * detection will store them.
 */
export async function crossServerCopyKeys(
  items: Record<string, unknown>[],
  opts: {
    type: "MOVIE" | "SERIES" | "MUSIC";
    serverCount: number;
    arrData?: ArrDataMap;
    actionArmed: boolean;
    /** A track-scope music rule set (items are tracks, not artists). */
    trackScope?: boolean;
    actionType?: string | null;
  },
): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  const trackScope = opts.type === "MUSIC" && !!opts.trackScope;
  const byArtist = groupsTracksByArtist({ ...opts, trackScope });
  if (opts.serverCount <= 1 && !byArtist) return keys;
  const collapseWithoutArr = !opts.arrData && opts.actionArmed;
  if (!opts.arrData && !collapseWithoutArr) return keys;

  const ids = await arrExternalIdsOf(opts.type, items, { loadMissing: collapseWithoutArr });
  for (const item of items) {
    let key = ids.get(item.id as string);
    if (!key) continue;
    if (opts.arrData && !opts.arrData[key]) continue;
    // A track's Arr-family id is its ARTIST's MusicBrainz id, shared by every
    // track of the artist. Unless the artist's tracks fold (above), only
    // another server's copy of the SAME track — its `dedupKey` — is the same
    // title; keyed on the artist alone, distinct tracks collapsed into one
    // match and a file delete acted on one track per artist per cycle.
    if (trackScope && !byArtist) {
      if (typeof item.dedupKey !== "string") continue;
      key = `${key}:${item.dedupKey}`;
    }
    keys.set(item.id as string, key);
  }
  return keys;
}

/** The ids of the other servers' copies a match was collapsed from. */
export function copyIdsOf(itemData: Record<string, unknown> | null | undefined): string[] {
  const copies = itemData?.copies;
  if (!Array.isArray(copies)) return [];
  return copies
    .map((c) => (c as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}


/**
 * Which copy of a collapsed title stays its representative, lowest first:
 * 0 — already the match's own row; 1 — listed in a held match's `copies`
 * (the match carries over onto it); 2 — any other copy (then lowest id).
 * Shared by detection's collapse and the rule diff so both pick the same copy.
 */
export function copyRank(
  id: string,
  heldIds: { has(id: string): boolean },
  heldCopies: { has(id: string): boolean },
): 0 | 1 | 2 {
  return heldIds.has(id) ? 0 : heldCopies.has(id) ? 1 : 2;
}
