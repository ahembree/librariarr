/**
 * The rule editor's client-side mirror of `checkWatchHistoryCompleteness`
 * (`evaluability.ts`): why a server's play history cannot answer
 * play-activity criteria yet, or `null` when it can. The editor uses it only
 * to WARN before the user triggers a refusal; the server-side guard stays the
 * authority on whether a rule set is safe to evaluate, and its reason (which
 * the preview/test/diff routes return) names the same fault.
 *
 * Kept apart rather than collapsed to one boolean because their remedies
 * differ, and one blended message gave half of them the wrong advice. In the
 * guard's precedence, which is the order the remedies have to happen in:
 * - `resync` (`libraryResyncRequiredAt` set): some of the server's media was
 *   removed in bulk or is being added for the first time, and play history
 *   waits for a COMPLETE LIBRARY sync — neither waiting nor a watch-history
 *   sync lifts it. First, because the hold withdraws the marker too, and on a
 *   mapped server restarts the import, so either later fault would point at a
 *   remedy that cannot help yet.
 * - `importing` (Tracearr-mapped, `tracearrBackfillComplete` false): the
 *   newest-first archive walk is still running — after a hold's release, the
 *   walk that release restarted. Waiting lifts it: the walk's completion is
 *   what re-establishes the marker on a mapped server, so it comes before
 *   `unsynced`, whose Refresh runs only the forward catch-up there.
 * - `unsynced` (`watchHistorySyncedAt` null): no watch-history sync has
 *   established what was played — never synced, or withdrawn by a source
 *   change, a purge, a restore, a released hold on a native server, or a sync
 *   that could not attribute every play. The next successful one lifts it —
 *   except where a native sync had to set aside a user whose play history it
 *   could not read (and who has no stored rows): a Refresh does not lift that
 *   one, and System Logs name the user and what to change.
 * - `gap` (Tracearr-mapped, `tracearrForwardFloorAt` set): recent plays are
 *   unread — a forward import is reading them right now (the floor is set
 *   for the length of every walk that finds a new play), or one was
 *   interrupted. It clears when that import completes; the next watch-history
 *   sync resumes an interrupted one.
 *
 * Client-safe and pure so it is unit-tested.
 */
export type PlayHistoryFault = "resync" | "importing" | "unsynced" | "gap";

/**
 * The server row fields the guard reads, as `/api/servers` delivers them
 * (dates as strings). Every one is optional, and a field ABSENT from the
 * payload reads as established: this only decides whether to show a warning,
 * and a false alarm about play history is worse than no banner — the
 * server-side guard still refuses, and says why.
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
