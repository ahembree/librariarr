import type { MediaServerType } from "@/generated/prisma/client";
import type { RealtimeEvent } from "./types";
import { isRecord } from "./normalize-util";

/**
 * Normalize a Jellyfin/Emby WebSocket message into canonical events. Both
 * servers share this protocol (Jellyfin forked from Emby): frames are
 * `{ MessageType, Data }`.
 *
 * Handled message types:
 *  - `Sessions`, `PlaybackStart`, `PlaybackProgress` → session-changed
 *  - `PlaybackStopped`                               → session-changed + watch-changed
 *  - `LibraryChanged`                                → library-changed
 *  - `UserDataChanged`                               → watch-changed
 *
 * `ForceKeepAlive`/`KeepAlive` are handled by the connection layer (it replies
 * with a `KeepAlive`) and never reach here as events. Everything else
 * (`GeneralCommand`, `ScheduledTasksInfo`, `ActivityLogEntry`,
 * `RestartRequired`, `ServerShuttingDown`, …) is ignored — connection liveness
 * is tracked by the connection layer, not inferred from server messages.
 */
export function normalizeJellyfinMessage(
  raw: unknown,
  ctx: { serverId: string; serverType: MediaServerType },
): RealtimeEvent[] {
  if (!isRecord(raw) || typeof raw.MessageType !== "string") return [];

  const at = Date.now();
  const base = { serverId: ctx.serverId, serverType: ctx.serverType, at };

  switch (raw.MessageType) {
    case "Sessions":
    case "PlaybackStart":
    case "PlaybackProgress":
      return [{ ...base, kind: "session-changed" }];
    case "PlaybackStopped":
      return [
        { ...base, kind: "session-changed" },
        { ...base, kind: "watch-changed" },
      ];
    case "LibraryChanged": {
      const data = raw.Data;
      const ids = (key: string) =>
        isRecord(data) && Array.isArray(data[key]) ? (data[key] as unknown[]).map((v) => String(v)) : [];
      return [
        {
          ...base,
          kind: "library-changed",
          detail: {
            ...summarizeLibraryChange(data),
            // Added + updated are fetched/upserted; removed are deleted.
            changedIds: [...ids("ItemsAdded"), ...ids("ItemsUpdated")],
            removedIds: ids("ItemsRemoved"),
          },
        },
      ];
    }
    case "UserDataChanged":
      return [{ ...base, kind: "watch-changed" }];
    default:
      return [];
  }
}

/**
 * Signature of a Jellyfin/Emby `Sessions` payload capturing only what the app
 * reacts to — which sessions are active, what they're playing, and their
 * play/transcode state — and deliberately EXCLUDING playback position.
 *
 * The `SessionsStart` subscription pushes a full frame on a fixed period (~every
 * 1.5s) whether or not anything changed, and an active stream's position ticks
 * up every frame. Comparing this position-free signature lets the connection
 * drop redundant frames, so the enforcer/sessions consumers only wake on a real
 * change (start, pause, stop, transcode switch) instead of on every periodic
 * frame. Position still refreshes via the sessions view's own poll.
 */
export function jellyfinSessionsSignature(data: unknown): string {
  if (!Array.isArray(data)) return "";
  return data
    .filter((s) => isRecord(s) && isRecord(s.NowPlayingItem))
    .map((s) => {
      const session = s as Record<string, unknown>;
      const item = session.NowPlayingItem as Record<string, unknown>;
      const playState = isRecord(session.PlayState) ? session.PlayState : {};
      const paused = playState.IsPaused ? 1 : 0;
      // Capture the transcode *kind* (video/audio direct flags), not just its
      // presence, so a mid-stream video<->audio transcode switch — which can
      // flip a transcode-manager criterion — changes the signature and wakes the
      // enforcer promptly. Stays stable across bitrate/position churn.
      const ti = session.TranscodingInfo;
      const transcoding = isRecord(ti)
        ? `${ti.IsVideoDirect ? "" : "v"}${ti.IsAudioDirect ? "" : "a"}` || "t"
        : "0";
      return `${session.Id}|${item.Id}|${paused}|${transcoding}`;
    })
    .sort()
    .join(",");
}

function summarizeLibraryChange(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const len = (key: string) => (Array.isArray(data[key]) ? (data[key] as unknown[]).length : 0);
  return {
    added: len("ItemsAdded"),
    removed: len("ItemsRemoved"),
    updated: len("ItemsUpdated"),
  };
}
