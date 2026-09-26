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

const globalForActivity = globalThis as unknown as {
  tracearrImportActivity: Map<string, Entry> | undefined;
};
const registry: Map<string, Entry> =
  globalForActivity.tracearrImportActivity ?? new Map<string, Entry>();
globalForActivity.tracearrImportActivity = registry;

export function beginTracearrImport(serverId: string, userId: string): void {
  registry.set(serverId, {
    userId,
    pass: null,
    startedAt: new Date().toISOString(),
    pages: 0,
    imported: 0,
    oldestReached: null,
  });
}

/** Called after each page COMMITS, before the progress event goes out. */
export function recordTracearrImportPage(
  serverId: string,
  update: { pass: TracearrImportPass; pages: number; imported: number; oldestReached: Date | null },
): void {
  const entry = registry.get(serverId);
  if (!entry) return;
  entry.pass = update.pass;
  entry.pages = update.pages;
  entry.imported = update.imported;
  entry.oldestReached = update.oldestReached?.toISOString() ?? null;
}

/**
 * Remove the server's entry. Returns the owner when there was one, so a caller
 * cleaning up after a failure knows whom to tell.
 */
export function endTracearrImport(serverId: string): { userId: string } | undefined {
  const entry = registry.get(serverId);
  if (!entry) return undefined;
  registry.delete(serverId);
  return { userId: entry.userId };
}

export function getTracearrImportActivity(serverId: string): TracearrImportActivity | null {
  const entry = registry.get(serverId);
  if (!entry) return null;
  const { pass, startedAt, pages, imported, oldestReached } = entry;
  return { pass, startedAt, pages, imported, oldestReached };
}
