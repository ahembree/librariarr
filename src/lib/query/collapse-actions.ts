import { arrIdSourceFor } from "@/lib/lifecycle/cross-server-copies";

type MediaType = "MOVIE" | "SERIES" | "MUSIC";

export interface CollapsibleItem {
  id: string;
  parentTitle: string | null;
  seriesKey?: string | null;
  externalIds: Array<{ source: string; externalId: string }>;
}

/**
 * The Arr record an ad-hoc query action resolves an item to: its Arr-family
 * external id (TMDB / TVDB / MusicBrainz artist), else — for a show or an
 * artist — the show's `seriesKey` or the artist's title. A movie with no TMDB
 * id stays its own record.
 */
function recordKey(type: MediaType, item: CollapsibleItem): string {
  const source = arrIdSourceFor(type);
  const arrId = item.externalIds.find((e) => e.source === source)?.externalId;
  if (arrId) return `${source}:${arrId}`;
  if (type === "SERIES") return `series:${item.seriesKey ?? (item.parentTitle ?? "").trim().toLowerCase()}`;
  if (type === "MUSIC") return `artist:${(item.parentTitle ?? "").trim().toLowerCase()}`;
  return `id:${item.id}`;
}

/**
 * Collapses the items of an ad-hoc query action to one per Arr record.
 *
 * The query engine returns every server's copy of a title (it does not filter
 * on `dedupCanonical`), and a music query returns tracks while every Lidarr
 * action acts on the artist. Acting per row sent the same Arr record one call
 * per copy or per track: the first deleted it and the rest were recorded
 * FAILED ("not found"), and each counted against the deletion ceiling.
 * Detection collapses copies by Arr id for the same reason
 * (`cross-server-copies.ts`).
 *
 * The first item of a record represents it. For shows and artists its members
 * become the union of the group's members (an item with none stands for
 * itself), so a member-scoped file delete still acts on every selected episode
 * or track, in one call.
 */
export function collapseActionItems<T extends CollapsibleItem>(
  type: MediaType,
  items: T[],
  members: Map<string, string[]>,
): { items: T[]; members: Map<string, string[]> } {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = recordKey(type, item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const kept: T[] = [];
  const keptMembers = new Map<string, string[]>();
  for (const group of groups.values()) {
    const [first] = group;
    kept.push(first);
    if (type === "MOVIE") {
      const own = members.get(first.id);
      if (own) keptMembers.set(first.id, own);
      continue;
    }
    const union = new Set<string>();
    for (const item of group) for (const m of members.get(item.id) ?? [item.id]) union.add(m);
    keptMembers.set(first.id, [...union]);
  }
  return { items: kept, members: keptMembers };
}
