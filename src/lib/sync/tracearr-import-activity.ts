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
   * the page of — stored or not, the same measure as `tracearrBackfillCursorAt`,
   * which the run only persists when its slice ends. Null until a backfill pass
   * commits a page, and never written by the forward pass: that pass walks the
   * newest plays, so its oldest is near "now" and read as archive progress it
   * would show the walk as having barely started.
   *
   * Taken from the live backfill run whichever run is newest — every other
   * field describes the newest run whose mapping still stands. A Refresh's
   * forward pass overlapping a backfill slice is the newest run, and reporting
   * its (empty) reach froze the archive progress bar for as long as the two
   * overlapped. A run whose walk was restarted or re-pointed underneath it
   * (`supersedeTracearrImports`, `retireTracearrImports`) reports none: it is
   * still walking the OLD archive position, and its deep reach would win the
   * status route's "older wins" over the restarted cursor.
   */
  backfillReached: string | null;
}

interface Entry extends Omit<TracearrImportActivity, "backfillReached"> {
  userId: string;
  /** This run's own backfill reach — see `TracearrImportActivity.backfillReached`. */
  ownBackfillReached: string | null;
  /**
   * Set by `supersedeTracearrImports` and `retireTracearrImports`: the run's
   * reach no longer describes the walk.
   */
  superseded: boolean;
  /**
   * Set by `retireTracearrImports`: the server's mapping changed under the run,
   * so nothing it does any longer describes this server — not reported at all.
   */
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
 * Mark every run live for this server as no longer describing its archive walk
 * — for `restartTracearrBackfill` (a purge, disable-with-delete, a restore, a
 * library populated for the first time), which restarts the walk while a slice
 * or a Refresh may be running.
 *
 * A running slice keeps walking from the position it started at, deep in the
 * archive, and its live reach would then beat the cursor the restart just moved
 * to "now" (the status route takes the older of the two), showing a restarted
 * walk as nearly finished. Its persisted progress is already discarded by the
 * compare-and-set on the cursor; this does the same for the reach. The run
 * itself stays reported: the mapping still stands, so the plays it writes are
 * still this server's, and a Refresh importing through a purge or a restore is
 * importing — hidden, the server read as idle, or as "failing" beside a parked
 * job. Runs that begin afterwards are unaffected.
 */
export function supersedeTracearrImports(serverId: string): void {
  for (const entry of registry.get(serverId) ?? []) {
    entry.superseded = true;
    entry.ownBackfillReached = null;
  }
}

/**
 * Mark every run live for this server as describing a mapping it no longer has
 * — for the server PUT, when it re-points, unlinks or re-links the server's
 * Tracearr source. Like `supersedeTracearrImports`, and the run is no longer
 * reported at all (`getTracearrImportActivity`): its next write is refused (the
 * mapping version moved), and until then its pages and play counts would be
 * shown against the new mapping, the server read as importing an archive that
 * is not its source any more. It stays registered until it ends.
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
 * The live backfill reach for the server: the furthest-back reach of any run
 * that is not superseded, or null. Normally one run — the backfill job is
 * keyed per server — so "furthest back" only decides between a slice and a
 * foreground run that also walked the archive.
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
 * The newest live run for the server whose mapping still stands, or null when
 * none is — except `backfillReached`, which is the live backfill run's (see the
 * field).
 *
 * A run retired by a mapping change (`retireTracearrImports`) is skipped, not
 * reported: it is still paging an archive that is no longer the server's
 * source, so reporting it showed the server as importing — `pending`, with the
 * old run's page and play counts — against the new mapping until the run
 * happened to hit a refused write. Whether anything is owed is then the job
 * table's to say. A run whose walk was merely restarted
 * (`supersedeTracearrImports`) is still reported, without its reach.
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
