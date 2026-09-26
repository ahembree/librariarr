import { prisma } from "@/lib/db";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

/** The external-id source a rule set's Arr family resolves its records by. */
export function arrIdSourceFor(type: "MOVIE" | "SERIES" | "MUSIC"): string {
  return type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
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
  },
): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  if (opts.serverCount <= 1) return keys;
  const source = arrIdSourceFor(opts.type);
  const collapseWithoutArr = !opts.arrData && opts.actionArmed;
  if (!opts.arrData && !collapseWithoutArr) return keys;

  const loaded = new Map<string, string>();
  if (collapseWithoutArr) {
    const missing = items.filter((i) => !Array.isArray(i.externalIds)).map((i) => i.id as string);
    if (missing.length > 0) {
      const rows = await prisma.mediaItemExternalId.findMany({
        where: { mediaItemId: { in: missing }, source },
        select: { mediaItemId: true, externalId: true },
      });
      for (const r of rows) loaded.set(r.mediaItemId, r.externalId);
    }
  }
  for (const item of items) {
    const externalIds = (item.externalIds ?? []) as Array<{ source: string; externalId: string }>;
    const key =
      externalIds.find((e) => e.source === source)?.externalId ?? loaded.get(item.id as string);
    if (!key) continue;
    if (opts.arrData && !opts.arrData[key]) continue;
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
