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
  /**
   * Oldest instant the server's live BACKFILL run has walked past and committed
   * (the measure `tracearrBackfillCursorAt` persists at slice end), taken from
   * that run whichever run is newest: a forward pass walks the newest plays, so
   * its reach would show the archive walk as barely started. Null until a
   * backfill page commits, and for a superseded or retired run, whose deep reach
   * would otherwise beat the restarted cursor.
   */
  backfillReached: string | null;
}

interface Entry extends Omit<TracearrImportActivity, "backfillReached"> {
  userId: string;
  /** This run's own backfill reach — see `TracearrImportActivity.backfillReached`. */
  ownBackfillReached: string | null;
  /** Set by `supersedeTracearrImports`/`retireTracearrImports`: the reach is stale. */
  superseded: boolean;
  /** Set by `retireTracearrImports`: the mapping changed; not reported at all. */
  retired: boolean;
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
    ownBackfillReached: null,
    superseded: false,
    retired: false,
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
  if (update.pass === "backfill" && update.oldestReached) {
    entry.ownBackfillReached = entry.oldestReached;
  }
}

/**
 * Mark every live run for this server as no longer describing its archive walk
 * — for `restartTracearrBackfill`. A running slice keeps walking from its old,
 * deep position, and its reach would beat the cursor the restart moved to
 * "now"; so the reach is dropped. The run stays reported: its plays are still
 * this server's, and a Refresh through a purge is importing. Later runs are
 * unaffected.
 */
export function supersedeTracearrImports(serverId: string): void {
  for (const entry of registry.get(serverId) ?? []) {
    entry.superseded = true;
    entry.ownBackfillReached = null;
  }
}

/**
 * Like `supersedeTracearrImports`, for the server PUT changing the mapping, and
 * the run is no longer reported at all: its next write is refused, and until
 * then its counts would be shown against the new mapping. It stays registered
 * until it ends.
 */
export function retireTracearrImports(serverId: string): void {
  for (const entry of registry.get(serverId) ?? []) {
    entry.superseded = true;
    entry.retired = true;
    entry.ownBackfillReached = null;
  }
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

/**
 * The furthest-back reach of any live run not superseded, or null. Normally one
 * run (the backfill job is keyed per server).
 */
export function getTracearrBackfillReach(serverId: string): string | null {
  let reach: string | null = null;
  for (const entry of registry.get(serverId) ?? []) {
    if (entry.superseded || !entry.ownBackfillReached) continue;
    if (reach === null || entry.ownBackfillReached < reach) reach = entry.ownBackfillReached;
  }
  return reach;
}

/**
 * The newest live run for the server that is not retired, or null — except
 * `backfillReached`, which is the live backfill run's (see the field). A
 * retired run is still paging an archive that is no longer the server's source;
 * whether anything is owed is then the job table's to say. A superseded run is
 * still reported, without its reach.
 */
export function getTracearrImportActivity(serverId: string): TracearrImportActivity | null {
  const runs = registry.get(serverId) ?? [];
  let entry: Entry | undefined;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!runs[i].retired) {
      entry = runs[i];
      break;
    }
  }
  if (!entry) return null;
  const { pass, startedAt, pages, imported, oldestReached } = entry;
  return {
    pass,
    startedAt,
    pages,
    imported,
    oldestReached,
    backfillReached: getTracearrBackfillReach(serverId),
  };
}
