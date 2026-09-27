import { normalizeTitle } from "@/lib/lifecycle/actions";
import { arrIdSourceFor } from "@/lib/lifecycle/cross-server-copies";

/** The current state of the item a stored match points at. */
export interface IdentityRow {
  title: string;
  parentTitle: string | null;
  year: number | null;
  externalIds: ReadonlyArray<{ source: string; externalId: string }>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The snapshot fields `matchIdentityChange` reads, as one comparable string.
 * Detection rewrites a match it keeps whenever this differs between the stored
 * snapshot and the item it just matched, so the snapshot always describes the
 * item as the latest run saw it. Without that, a match that kept matching after
 * a re-title (a metadata refresh, a Fix Match onto a work the rules still
 * select) kept its old snapshot forever: every direct execute of the rule set
 * answered 409, and running detection again — the remedy the refusal names —
 * changed nothing, because detection only rewrote a kept match when its
 * members, servers or copies changed.
 */
export function identityFingerprint(item: Record<string, unknown> | undefined): string {
  if (!item) return "";
  const ids = (Array.isArray(item.externalIds) ? (item.externalIds as unknown[]) : [])
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : null))
    .filter((e): e is Record<string, unknown> => e !== null)
    .map((e) => `${String(e.source)}:${String(e.externalId)}`)
    .sort();
  return JSON.stringify([
    text(item.title),
    text(item.parentTitle),
    typeof item.year === "number" ? item.year : null,
    ids,
  ]);
}

/**
 * Why the item a stored match points at is no longer the work that matched, or
 * `null` when it still is (or the stored snapshot is too old to tell).
 *
 * A `RuleMatch` keeps the item's id, and an id outlives its identity: a Plex
 * "Fix Match" or a Jellyfin "Identify" rewrites the same row — same rating key,
 * same id — to different content with different external ids, and the next
 * sync stores that before the next detection drops the stale match. Executing
 * the match then resolves the Arr record from the row's NEW external id, and
 * title validation passes, because it compares the Arr record against the new
 * title: the action lands on a work the rules never matched. Every path that
 * acts refuses it through this function, each against its own snapshot: the
 * scheduled executor and force-retry against the identity the action recorded
 * when it was scheduled (it cancels the action and clears the match), the
 * paths that execute a stored match directly — the Pending page's Execute and
 * the public API — against the snapshot detection stored in `RuleMatch.itemData`.
 *
 * Three signals, any of which is enough:
 *  - the title. A series or artist match is stored as its group (title = the
 *    show or artist, `parentTitle` cleared) against a representative episode
 *    or track whose `parentTitle` is that show or artist, so the group's title
 *    is compared with the row's `parentTitle ?? title` — the same name the Arr
 *    title validation checks. A track matched on its own keeps its artist as
 *    `parentTitle`, and both levels are compared.
 *  - the external id the Arr family resolves its record by (TMDB, TVDB,
 *    MusicBrainz), when the snapshot recorded one.
 *  - for a movie, the year: title normalisation cannot tell remakes apart
 *    ("Dune" 1984 and 2021), so a move of more than a year is a different work.
 *
 * Errs toward refusing: a title the server merely re-worded also reads as a
 * change, and the cure is only to run detection again, which re-snapshots the
 * match (see `identityFingerprint`) and schedules a cancelled action afresh.
 */
export function matchIdentityChange(
  snapshot: unknown,
  current: IdentityRow,
  type: "MOVIE" | "SERIES" | "MUSIC",
): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const snap = snapshot as Record<string, unknown>;

  const snapTitle = text(snap.title);
  if (snapTitle) {
    const snapParent = text(snap.parentTitle);
    if (snapParent) {
      if (
        normalizeTitle(snapParent) !== normalizeTitle(current.parentTitle ?? "") ||
        normalizeTitle(snapTitle) !== normalizeTitle(current.title)
      ) {
        return `"${snapParent} — ${snapTitle}" is now "${current.parentTitle ?? ""} — ${current.title}"`;
      }
    } else {
      const now = current.parentTitle ?? current.title;
      if (normalizeTitle(snapTitle) !== normalizeTitle(now)) {
        return `"${snapTitle}" is now "${now}"`;
      }
    }
  }

  const source = arrIdSourceFor(type);
  const snapIds = Array.isArray(snap.externalIds) ? (snap.externalIds as unknown[]) : [];
  const snapId = snapIds
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : null))
    .find((e) => e?.source === source)?.externalId;
  const currentId = current.externalIds.find((e) => e.source === source)?.externalId;
  // A row that has LOST the id cannot be acted on at all (the action fails with
  // "no TMDB ID"), so only a different id is a change of identity.
  if (typeof snapId === "string" && currentId !== undefined && snapId !== currentId) {
    return `its ${source} id changed from ${snapId} to ${currentId}`;
  }

  if (
    type === "MOVIE" &&
    typeof snap.year === "number" && snap.year > 0 &&
    current.year != null && current.year > 0 &&
    Math.abs(snap.year - current.year) > 1
  ) {
    return `its year changed from ${snap.year} to ${current.year}`;
  }

  return null;
}
