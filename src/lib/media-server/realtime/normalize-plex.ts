import type { RealtimeEvent } from "./types";
import { isRecord, asArray } from "./normalize-util";

/**
 * Normalize a Plex `/:/websockets/notifications` message into canonical events.
 *
 * Plex frames arrive as `{ NotificationContainer: { type, ...arrays } }` (some
 * proxies/older builds send the container at the top level, so both are
 * accepted). Relevant `type`s:
 *  - `playing`  → PlaySessionStateNotification[]  → session-changed (+ watch-changed on "stopped")
 *  - `timeline` → TimelineEntry[]                 → library-changed (add/update/delete/scan)
 *
 * `timeline` is the ONLY source of `library-changed` for Plex, because it is the
 * only channel that says *which* items changed. `activity` notifications are
 * deliberately ignored: an ended `library.*` activity carries no item detail, so
 * the only action it could ever justify is a full server sync — and Plex emits
 * them constantly. Measured against a live server: `library.refresh.items`
 * (Plex's periodic metadata refresh) ends with `Context: null` and produces zero
 * timeline entries, i.e. nothing changed, yet each one used to cost a full
 * full server sync; a single movie add emitted thousands of `activity` frames alongside 34
 * `timeline` frames. Adds, updates AND deletions all surface on `timeline`
 * (verified: an added movie as `state=1 metadataState=created`, a deleted movie
 * and a deleted episode as `state=9 metadataState=deleted`), so nothing is lost
 * by ignoring `activity` — and the periodic full sync remains the reconciliation
 * backstop for anything the push channel never reports.
 *
 * Everything else (`status`, `progress`, `activity`, `transcodeSession.*`,
 * `reachability`, preference changes, …) is intentionally ignored — connection
 * liveness is tracked by the connection layer, not derived from messages.
 */
export function normalizePlexMessage(raw: unknown, ctx: { serverId: string }): RealtimeEvent[] {
  const container = extractContainer(raw);
  if (!container || typeof container.type !== "string") return [];

  const at = Date.now();
  const base = { serverId: ctx.serverId, serverType: "PLEX" as const, at };
  const events: RealtimeEvent[] = [];

  switch (container.type) {
    case "playing": {
      const notes = asArray(container.PlaySessionStateNotification);
      if (notes.length === 0) {
        // A bare "playing" container with no detail still signals activity.
        events.push({ ...base, kind: "session-changed" });
        break;
      }
      for (const n of notes) {
        events.push({ ...base, kind: "session-changed", detail: pickPlaying(n) });
        if (isRecord(n) && n.state === "stopped") {
          events.push({ ...base, kind: "watch-changed", detail: pickPlaying(n) });
        }
      }
      break;
    }
    case "timeline": {
      const entries = asArray(container.TimelineEntry);
      // Emit on ANY timeline `state`. Plex's `state` field is not a reliable
      // "added vs deleted vs intermediate" discriminator across
      // versions/operations — a scan that detects a file removed from disk (e.g.
      // deleted by Radarr) doesn't always carry the completed/deleted state you'd
      // expect, so filtering by state risks silently dropping deletions. Scan
      // chatter is harmless: the per-server debouncer coalesces a burst into a
      // single sync regardless of how many entries fire, so being permissive
      // costs nothing but catches every real change.
      //
      // Two filters ARE applied, both on identity rather than state:
      //
      //  - **Dedupe by itemID.** One added movie emitted seven frames for the
      //    same ratingKey (state 0→1→1→1→4→5) as Plex walked it through
      //    create/analyze/load. They are one change, not seven.
      //  - **Drop `sectionID < 0`.** `-1` means the object belongs to no library
      //    section, so it can never map to one of our `Library` rows. Adding one
      //    movie emitted 27 such entries — its extras and trailers (`type=12`) —
      //    which the sync would fetch one-by-one only to discard, and which used
      //    to escalate the whole batch to a full server sync because a single
      //    unmappable id aborted it. Verified safe in both directions: real
      //    library items keep a valid `sectionID` even on deletion (a deleted
      //    movie arrives `sectionID=1 type=1 state=9`, a deleted episode
      //    `sectionID=2 type=4 state=9`), while `-1` appeared only on extras.
      //
      // Plex doesn't cleanly label add vs delete, so everything that survives
      // goes to `changedIds`; the incremental sync resolves each one
      // (present → upsert, 404 → delete).
      const changedIds: string[] = [];
      const deletedIds: string[] = [];
      const seen = new Set<string>();
      const seenDeleted = new Set<string>();
      let droppedSectionless = 0;
      for (const e of entries) {
        if (!isRecord(e) || e.itemID == null) continue;
        // Absent `sectionID` is a response gap, not evidence of no section —
        // keep those and let the sync resolve them from the item's own metadata
        // or its existing row. Only an explicit negative is a definitive "no
        // library section".
        if (e.sectionID != null && Number(e.sectionID) < 0) {
          droppedSectionless++;
          continue;
        }
        const id = String(e.itemID);
        // Checked on EVERY entry, before the dedupe: an item's deletion frame
        // (`state=9 metadataState=deleted`) can follow an earlier frame for the
        // same id in one container, and it must still be flagged. The flag is
        // advisory (see `LibraryChangeDetail.deletedIds`); the id goes to
        // `changedIds` like any other, for the sync to resolve.
        if (looksDeleted(e) && !seenDeleted.has(id)) {
          seenDeleted.add(id);
          deletedIds.push(id);
        }
        if (seen.has(id)) continue;
        seen.add(id);
        changedIds.push(id);
      }
      if (changedIds.length > 0) {
        events.push({
          ...base,
          kind: "library-changed",
          detail: { entries: entries.length, changedIds, deletedIds, droppedSectionless },
        });
      }
      break;
    }
    default:
      break;
  }

  return events;
}

function extractContainer(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.NotificationContainer)) return raw.NotificationContainer;
  if (typeof raw.type === "string") return raw;
  return null;
}

/**
 * True when a timeline entry reads as a deletion. Verified on the wire: a
 * deleted movie arrives `state=9 metadataState=deleted`, a deleted episode the
 * same. Either signal alone counts — this only ever widens what the manager
 * refuses to suppress, and a false positive costs one metadata fetch.
 */
function looksDeleted(e: Record<string, unknown>): boolean {
  if (e.state != null && Number(e.state) === 9) return true;
  return typeof e.metadataState === "string" && e.metadataState.toLowerCase() === "deleted";
}

function pickPlaying(n: unknown): Record<string, unknown> {
  if (!isRecord(n)) return {};
  return {
    sessionKey: n.sessionKey,
    state: n.state,
    key: n.key,
    viewOffset: n.viewOffset,
  };
}
