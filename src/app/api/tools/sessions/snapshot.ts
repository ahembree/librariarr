import { prisma } from "@/lib/db";
import { eventBus } from "@/lib/events/event-bus";
import { createMediaServerClient } from "@/lib/media-server/factory";
import {
  stampFirstSeen,
  pruneFirstSeen,
  rememberSession,
} from "@/lib/media-server/session-first-seen";
import { realtimeBus } from "@/lib/media-server/realtime/bus";
import type { MediaSession } from "@/lib/media-server/types";
import type { MediaServerType } from "@/generated/prisma/client";

export interface SessionWithServer extends MediaSession {
  serverId: string;
  serverName: string;
  serverType: MediaServerType;
  startedAt: number;
}

export interface UnreachableServer {
  id: string;
  name: string;
  type: MediaServerType;
}

export interface SessionsSnapshot {
  sessions: SessionWithServer[];
  unreachableServers: UnreachableServer[];
}

/**
 * How long one poll of the media servers answers every reader: under the
 * Stream Manager's 5-second tick, so a single open page still polls on every
 * tick, while several open pages (and `GET /api/tools/sessions`) share a poll
 * instead of each asking every server.
 */
export const SESSIONS_SHARE_WINDOW_MS = 4000;

interface Poll {
  /** `performance.now()` when the poll began — monotonic, sub-millisecond. */
  startedAt: number;
  promise: Promise<SessionsSnapshot>;
}

interface SnapshotState {
  poll: Poll | null;
  /** `performance.now()` of the latest change a poll begun before it cannot show. */
  lastChangeAt: number;
  watching: boolean;
}

// Pinned to globalThis: every route bundle that reads sessions must share the
// one poll and the one change time, or each copy polls on its own again.
const globalForSessions = globalThis as unknown as { sessionsSnapshot?: SnapshotState };
const state = (globalForSessions.sessionsSnapshot ??= { poll: null, lastChangeAt: -Infinity, watching: false });

/**
 * A change was made that a poll begun before now cannot show — a session
 * ended, a server was added, removed or turned off — so the next reader polls.
 */
export function noteSessionsChanged(): void {
  state.lastChangeAt = performance.now();
}

// Watched from the moment this module loads, once per process: the session
// stream subscribes to the same bus per connection, later, and EventEmitter
// calls listeners in the order they subscribed — so by the time a stream
// reacts to a pushed change, the change is already noted here and the stream
// is never handed a poll that began before it. A pushed session change, a
// server's connection going up or down (the unreachable list), and any server
// add/edit/delete all make a poll stale.
if (!state.watching) {
  state.watching = true;
  realtimeBus.subscribe((event) => {
    if (event.kind === "session-changed" || event.kind === "server-status") noteSessionsChanged();
  });
  eventBus.subscribe((event) => {
    if (event.type === "server:changed") noteSessionsChanged();
  });
}

/**
 * Every enabled server's playback sessions, shared by every reader.
 *
 * Each Stream Manager connection polled every server every 5 seconds by
 * itself, and every refresh of the sessions route polled them again. A poll
 * that began within the share window is reused — unless a change was noted
 * since it began (`noteSessionsChanged`): an answer that predates a change it
 * could be asked about is never reused.
 *
 * A poll that fails outright (the server list could not be read) is not kept;
 * a server that cannot be reached is part of the answer, as before.
 */
export function readSessionsSnapshot(userId: string): Promise<SessionsSnapshot> {
  const now = performance.now();
  const current = state.poll;
  if (current && current.startedAt > Math.max(now - SESSIONS_SHARE_WINDOW_MS, state.lastChangeAt)) {
    return current.promise;
  }

  const poll: Poll = { startedAt: now, promise: pollSessions(userId) };
  state.poll = poll;
  poll.promise.catch(() => {
    if (state.poll === poll) state.poll = null;
  });
  return poll.promise;
}

/** Forget the shared poll and the change time — for tests. */
export function _resetSessionsSnapshot(): void {
  state.poll = null;
  state.lastChangeAt = -Infinity;
}

async function pollSessions(userId: string): Promise<SessionsSnapshot> {
  const servers = await prisma.mediaServer.findMany({
    where: { userId, enabled: true },
    select: { id: true, name: true, url: true, accessToken: true, tlsSkipVerify: true, type: true },
  });

  const now = Date.now();

  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
      const sessions = await client.getSessions();
      return sessions.map<SessionWithServer>((s) => {
        // Keeps the label the terminate route logs with current.
        rememberSession(server.id, s);
        return {
          ...s,
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          // The first time this session was seen, so the displayed duration
          // carries on across polls.
          startedAt: stampFirstSeen(server.id, s.sessionId, now),
        };
      });
    }),
  );

  const sessions: SessionWithServer[] = [];
  const unreachableServers: UnreachableServer[] = [];
  // Servers we actually reached. One failed poll must not look like "every
  // session on that server ended" — dropping their first-seen timestamps
  // restarts the displayed stream duration from zero when the server returns.
  const polledServerIds = new Set<string>();
  results.forEach((result, idx) => {
    const server = servers[idx];
    if (result.status === "fulfilled") {
      polledServerIds.add(server.id);
      sessions.push(...result.value);
    } else {
      unreachableServers.push({ id: server.id, name: server.name, type: server.type });
    }
  });

  const activeKeys = new Set(sessions.map((s) => `${s.serverId}:${s.sessionId}`));
  const knownServerIds = new Set(servers.map((s) => s.id));
  pruneFirstSeen(activeKeys, knownServerIds, polledServerIds);

  return { sessions, unreachableServers };
}
