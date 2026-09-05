import type { MediaServerType } from "@/generated/prisma/client";

/**
 * Canonical, server-agnostic real-time event kinds.
 *
 * Each media server (Plex / Jellyfin / Emby) exposes a WebSocket push channel
 * with its own message shapes; the per-type normalizers collapse those into
 * this small set of kinds so downstream consumers never see server-specific
 * payloads.
 *
 * - `session-changed` — a playback/session state change (start, pause, seek,
 *   stop, progress). Consumers refresh the active-sessions view and re-run the
 *   maintenance/blackout/transcode enforcer so a new stream is seen instantly.
 * - `library-changed` — an item was added/updated/removed on the server (a
 *   library scan finished, metadata refreshed). Consumers enqueue a debounced
 *   incremental sync for the affected server.
 * - `watch-changed` — watch state changed (a play finished / scrobbled, or
 *   per-user played/unplayed data changed). Consumers enqueue a debounced
 *   watch-history refresh.
 * - `server-status` — the realtime connection itself changed state
 *   (connecting/connected/disconnected). Connection-driven, never derived from
 *   a server message.
 */
export type RealtimeEventKind =
  | "session-changed"
  | "library-changed"
  | "watch-changed"
  | "server-status";

export type RealtimeConnectionStatus = "connecting" | "connected" | "disconnected";

export interface RealtimeEvent {
  kind: RealtimeEventKind;
  /** MediaServer.id the event originated from (unique per connection). */
  serverId: string;
  serverType: MediaServerType;
  /** Epoch ms the event was produced. */
  at: number;
  /** Present only on `server-status` events. */
  status?: RealtimeConnectionStatus;
  /** Optional structured detail for debugging / richer consumers. */
  detail?: Record<string, unknown>;
}

/**
 * `detail` shape carried on a `library-changed` event, so the manager can drive
 * an incremental sync of just the affected items instead of the whole server.
 * A `library-changed` event with NEITHER list populated (a Jellyfin frame whose
 * item arrays are all empty) contributes nothing: "something changed but we
 * don't know what" is not actionable, and the scheduled full sync reconciles it.
 */
export interface LibraryChangeDetail {
  /** ratingKeys to fetch + upsert (or delete if the server reports them gone). */
  changedIds?: string[];
  /** ratingKeys the server reported as removed. */
  removedIds?: string[];
  /**
   * The subset of `changedIds` whose entry LOOKED like a deletion (Plex
   * `state=9` / `metadataState=deleted`). Advisory only — Plex's state field is
   * not trusted to decide add vs delete (the incremental sync resolves each id
   * against the server), but it is trusted for one thing: a deletion is never
   * dropped as the echo of librariarr's own write, because leaving a row alive
   * for media that is gone is the worse failure.
   */
  deletedIds?: string[];
}

/**
 * Minimal server configuration the realtime layer needs to open a connection.
 * Keyed by `id` so multiple servers of the same type (several Plex / Jellyfin /
 * Emby instances) each get their own independent connection.
 */
export interface RealtimeServerConfig {
  id: string;
  name: string;
  type: MediaServerType;
  url: string;
  accessToken: string;
  tlsSkipVerify: boolean;
  /**
   * Owner of the server. Carried here so the manager can address a bridged
   * browser event without a database lookup per event — these fire on the hot
   * path of the media-server socket.
   */
  userId: string;
}
