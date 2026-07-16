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
 *  - `activity` → ActivityNotification[]          → library-changed for ended `library.*` activities
 *
 * Everything else (`status`, `progress`, `transcodeSession.*`, `reachability`,
 * preference changes, …) is intentionally ignored — connection liveness is
 * tracked by the connection layer, not derived from messages.
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
      // Plex fires a timeline entry for every step of its processing pipeline:
      // states 0-4 are intermediate (created/matching/downloading/processing) and
      // repeat per item during a scan/analysis; state 5 = finished (added or
      // updated) and 9 = deleted are the meaningful "content changed" signals.
      // Emitting on every intermediate state would force a full sync every few
      // minutes of background activity, so skip a frame only when ALL its entries
      // are intermediate. Entries without a numeric state still emit (don't miss
      // a change on a server/version that omits it).
      const isIntermediate = (e: unknown) => {
        if (!isRecord(e) || e.state == null) return false;
        const state = Number(e.state);
        return Number.isFinite(state) && state >= 0 && state <= 4;
      };
      const meaningful = entries.some((e) => !isIntermediate(e));
      if (meaningful) {
        events.push({ ...base, kind: "library-changed", detail: { entries: entries.length } });
      }
      break;
    }
    case "activity": {
      const activities = asArray(container.ActivityNotification);
      const libraryActivityEnded = activities.some(
        (a) =>
          isRecord(a) &&
          a.event === "ended" &&
          isRecord(a.Activity) &&
          typeof a.Activity.type === "string" &&
          a.Activity.type.startsWith("library."),
      );
      if (libraryActivityEnded) {
        events.push({ ...base, kind: "library-changed", detail: { source: "activity" } });
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

function pickPlaying(n: unknown): Record<string, unknown> {
  if (!isRecord(n)) return {};
  return {
    sessionKey: n.sessionKey,
    state: n.state,
    key: n.key,
    viewOffset: n.viewOffset,
  };
}
