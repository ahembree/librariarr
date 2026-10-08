/**
 * The rule editor's client-side mirror of `checkWatchHistoryCompleteness`
 * (`evaluability.ts`): why a server's play history cannot answer play-activity
 * criteria yet, or `null`. Only for a WARNING banner; the server-side guard
 * stays the authority. Faults stay distinct because their remedies differ, in
 * the guard's precedence (the order the remedies have to happen in):
 * - `resync`: `libraryResyncRequiredAt` set — a complete library sync lifts it;
 * - `importing`: mapped, archive walk unfinished — its completion lifts it;
 * - `unsynced`: `watchHistorySyncedAt` null — a watch-history sync lifts it;
 * - `gap`: mapped, `tracearrForwardFloorAt` set — recent plays unread.
 * Client-safe and pure so it is unit-tested.
 */
export type PlayHistoryFault = "resync" | "importing" | "unsynced" | "gap";

/**
 * The server fields the guard reads, as `/api/servers` delivers them. A field
 * ABSENT from the payload reads as established: a false alarm is worse than no
 * banner, and the server-side guard still refuses.
 */
export interface PlayHistoryEvidence {
  libraryResyncRequiredAt?: string | Date | null;
  watchHistorySyncedAt?: string | Date | null;
  tracearrServerId?: string | null;
  tracearrForwardFloorAt?: string | Date | null;
  tracearrBackfillComplete?: boolean;
}

/** The first fault that applies, in the guard's precedence, or `null`. */
export function playHistoryFault(server: PlayHistoryEvidence): PlayHistoryFault | null {
  if (server.libraryResyncRequiredAt != null) return "resync";
  const mapped = server.tracearrServerId != null;
  if (mapped && server.tracearrBackfillComplete === false) return "importing";
  if (server.watchHistorySyncedAt === null) return "unsynced";
  if (mapped && server.tracearrForwardFloorAt != null) return "gap";
  return null;
}
