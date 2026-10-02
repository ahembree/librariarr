/**
 * Which Tracearr history imports are running right now, and how far each has
 * got this run.
 *
 * The stored rows answer "how much history is here" (the status route's
 * counts and coverage bar); they cannot answer "is an import running now". That
 * gap mattered once syncs started queueing behind the backfill: the Settings
 * page showed a sync as Queued while the job ahead of it — a five-minute
 * archive slice — was invisible, and a completed backfill read "History fully
 * imported" even while a catch-up import was running.
 *
 * In-process on purpose. The worker runs inside the app process, so the
 * importer (writer) and the status route (reader) share it; nothing here needs
 * to outlive a restart, because an import that dies with the process is no
 * longer running. Pinned to `globalThis` unconditionally — the writer is
 * reached through the job worker started from `instrumentation.ts` and the
 * reader through a route bundle, and the two must see one map.
 */

export type TracearrImportPass = "forward" | "backfill";

export interface TracearrImportActivity {
  /** The pass currently walking; `null` until its first page commits. */
  pass: TracearrImportPass | null;
  startedAt: string;
  /** Pages committed this run, across both passes. */
  pages: number;
  /** Rows inserted or updated this run. */
  imported: number;
  /** Oldest play the current pass has committed, when it has one. */
  oldestReached: string | null;
}

interface Entry extends TracearrImportActivity {
  userId: string;
}

/**
 * One run's registration. Opaque to callers: every update and the final
 * removal go through the handle of the run that began, never the server id.
 *
 * Two imports of the same server can overlap — the History page's Refresh runs
 * in a request, outside the serial MAIN_QUEUE a backfill slice runs on. Keyed
 * by server alone, the second run overwrote the first's entry, each wrote its
 * pages into the other's counters, and whichever finished first removed the
 * readout while the other was still importing.
 */
export interface TracearrImportHandle {
  readonly serverId: string;
  readonly entry: Entry;
}

const globalForActivity = globalThis as unknown as {
  tracearrImportRuns: Map<string, Entry[]> | undefined;
};
/** Per server, the live runs in the order they began. */
const registry: Map<string, Entry[]> =
  globalForActivity.tracearrImportRuns ?? new Map<string, Entry[]>();
globalForActivity.tracearrImportRuns = registry;

export function beginTracearrImport(serverId: string, userId: string): TracearrImportHandle {
  const entry: Entry = {
    userId,
    pass: null,
    startedAt: new Date().toISOString(),
    pages: 0,
    imported: 0,
    oldestReached: null,
  };
  registry.set(serverId, [...(registry.get(serverId) ?? []), entry]);
  return { serverId, entry };
}

/** Called after each page COMMITS, before the progress event goes out. */
export function recordTracearrImportPage(
  handle: TracearrImportHandle,
  update: { pass: TracearrImportPass; pages: number; imported: number; oldestReached: Date | null },
): void {
  const { entry } = handle;
  entry.pass = update.pass;
  entry.pages = update.pages;
  entry.imported = update.imported;
  entry.oldestReached = update.oldestReached?.toISOString() ?? null;
}

/**
 * Remove this run's entry. Returns the owner when it was still registered, so a
 * caller cleaning up after a failure knows whom to tell — and ending twice is a
 * no-op.
 */
export function endTracearrImport(handle: TracearrImportHandle): { userId: string } | undefined {
  const runs = registry.get(handle.serverId);
  if (!runs?.includes(handle.entry)) return undefined;
  const rest = runs.filter((run) => run !== handle.entry);
  if (rest.length > 0) registry.set(handle.serverId, rest);
  else registry.delete(handle.serverId);
  return { userId: handle.entry.userId };
}

/** The newest live run for the server, or null when none is running. */
export function getTracearrImportActivity(serverId: string): TracearrImportActivity | null {
  const runs = registry.get(serverId);
  const entry = runs?.[runs.length - 1];
  if (!entry) return null;
  const { pass, startedAt, pages, imported, oldestReached } = entry;
  return { pass, startedAt, pages, imported, oldestReached };
}
