import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import type { ChipColorMap } from "@/lib/theme/chip-colors";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";

export type SaveOutcome = "saved" | "conflict" | "failed";

/**
 * The client's copy of the display settings the server layout read.
 *
 * The layout renders them only on a full page load and persists across
 * client-side navigations, so this copy is what every page reads, and it has
 * to follow saves made elsewhere: `refresh()` re-reads `/api/settings/shell`
 * (the provider calls it on `display-settings:changed`, on the event stream's
 * reconnect, and when a tab that was hidden a while comes back).
 *
 * Readers subscribe through `useSyncExternalStore`. Saves are optimistic and
 * queued one at a time, each sending the revision the copy holds when it is
 * sent, so this tab's own successive saves never refuse each other while a
 * save based on a copy another tab has moved past is refused (409) instead of
 * overwriting it. A refresh never lands over a local change: it waits while a
 * save is queued, and an answer that crosses a local change is dropped and
 * asked again.
 */
export interface ShellSettingsStore {
  getSnapshot(): ShellSettings;
  subscribe(listener: () => void): () => void;
  /** Re-read the settings from the server. */
  refresh(): Promise<void>;
  setWhatsNewSeen(): void;
  /** Local copy only: the caller saves the colours itself. */
  setChipColors(colors: ChipColorMap): void;
  /** Local copy only: the caller saves the preferences itself. */
  setCardDisplayPreferences(preferences: Record<string, unknown>): void;
  /** Shows the columns at once and saves them after a short pause (the latest per type wins). */
  saveColumns(type: string, columns: string[]): Promise<SaveOutcome>;
  /** Shows the layout at once and saves it. */
  saveDashboardLayout(layout: DashboardLayout): Promise<SaveOutcome>;
}

export interface ShellSettingsStoreOptions {
  /** Called when a refresh brings a different accent (another tab changed it). */
  onAccentChange?: (accent: string) => void;
  /** The pause before a column change is sent. */
  columnSaveDelayMs?: number;
}

export const SHELL_SETTINGS_URL = "/api/settings/shell";
const COLUMN_SAVE_DELAY_MS = 500;

type Kind = "columns" | "layout";

interface ColumnDraft {
  columns: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
  waiters: ((outcome: SaveOutcome) => void)[];
}

export function createShellSettingsStore(
  initial: ShellSettings,
  options: ShellSettingsStoreOptions = {},
): ShellSettingsStore {
  const columnSaveDelayMs = options.columnSaveDelayMs ?? COLUMN_SAVE_DELAY_MS;
  let snapshot = initial;
  const listeners = new Set<() => void>();

  // Saves not yet answered, column drafts still waiting to be sent included.
  let pendingSaves = 0;
  // Bumped by every local change, so a refresh answer that crosses one is dropped.
  let localVersion = 0;
  let refreshWanted = false;
  let refreshing: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const columnDrafts = new Map<string, ColumnDraft>();
  // A kind whose save was refused: saves queued behind it were built on the
  // same stale copy, so they are refused too until a refresh replaces it.
  const conflicted = new Set<Kind>();

  function set(next: ShellSettings) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function changeLocally(next: ShellSettings) {
    localVersion++;
    set(next);
  }

  function settled() {
    pendingSaves--;
    if (pendingSaves === 0 && refreshWanted) void refresh();
  }

  function enqueue(kind: Kind, send: () => Promise<SaveOutcome>): Promise<SaveOutcome> {
    const run = queue.then(async (): Promise<SaveOutcome> => {
      if (conflicted.has(kind)) return "conflict";
      try {
        const outcome = await send();
        if (outcome === "conflict") {
          conflicted.add(kind);
          refreshWanted = true;
        }
        return outcome;
      } catch {
        return "failed";
      }
    });
    queue = run;
    return run.finally(settled);
  }

  async function put(url: string, body: unknown): Promise<{ outcome: SaveOutcome; revision?: number }> {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) return { outcome: "conflict" };
    if (!res.ok) return { outcome: "failed" };
    const data = (await res.json().catch(() => null)) as { revision?: unknown } | null;
    return { outcome: "saved", revision: typeof data?.revision === "number" ? data.revision : undefined };
  }

  async function refresh(): Promise<void> {
    if (pendingSaves > 0) {
      refreshWanted = true;
      return;
    }
    if (refreshing) {
      refreshWanted = true;
      return refreshing;
    }
    refreshWanted = false;
    const startedAt = localVersion;
    refreshing = (async () => {
      try {
        const res = await fetch(SHELL_SETTINGS_URL, { priority: "low" } as RequestInit);
        if (!res.ok) return;
        const fresh = (await res.json()) as ShellSettings;
        if (pendingSaves > 0 || localVersion !== startedAt) {
          // A local change crossed this answer; it may be older than that change.
          refreshWanted = true;
          return;
        }
        const previousAccent = snapshot.accentColor;
        conflicted.clear();
        set(fresh);
        if (fresh.accentColor !== previousAccent) options.onAccentChange?.(fresh.accentColor);
      } catch {
        // Offline or signed out: keep the copy; the next event or visit asks again.
      } finally {
        refreshing = null;
      }
    })();
    await refreshing;
    if (refreshWanted && pendingSaves === 0) await refresh();
  }

  function sendColumns(type: string) {
    const draft = columnDrafts.get(type);
    if (!draft) return;
    columnDrafts.delete(type);
    void enqueue("columns", async () => {
      const { outcome, revision } = await put("/api/settings/column-preferences", {
        type,
        columns: draft.columns,
        revision: snapshot.columnPreferencesRevision,
      });
      if (outcome === "saved" && revision !== undefined) {
        set({ ...snapshot, columnPreferencesRevision: revision });
      }
      return outcome;
    }).then((outcome) => {
      for (const waiter of draft.waiters) waiter(outcome);
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setWhatsNewSeen() {
      changeLocally({ ...snapshot, whatsNewDue: false });
    },
    setChipColors(colors) {
      changeLocally({ ...snapshot, chipColors: colors });
    },
    setCardDisplayPreferences(preferences) {
      changeLocally({ ...snapshot, cardDisplayPreferences: preferences });
    },
    saveColumns(type, columns) {
      changeLocally({ ...snapshot, columnPreferences: { ...snapshot.columnPreferences, [type]: columns } });
      return new Promise<SaveOutcome>((resolve) => {
        const draft = columnDrafts.get(type);
        if (draft) {
          clearTimeout(draft.timer);
          draft.columns = columns;
          draft.waiters.push(resolve);
        } else {
          // Counted from the change, not from the send: a refresh landing during
          // the pause would otherwise put the old columns back on screen.
          pendingSaves++;
          columnDrafts.set(type, { columns, timer: undefined, waiters: [resolve] });
        }
        // The draft's pending count carries over to its send, which settles it.
        columnDrafts.get(type)!.timer = setTimeout(() => sendColumns(type), columnSaveDelayMs);
      });
    },
    saveDashboardLayout(layout) {
      changeLocally({ ...snapshot, dashboardLayout: layout });
      pendingSaves++;
      return enqueue("layout", async () => {
        const { outcome, revision } = await put("/api/settings/dashboard-layout", {
          layout,
          revision: snapshot.dashboardLayoutRevision,
        });
        if (outcome === "saved" && revision !== undefined) {
          set({ ...snapshot, dashboardLayoutRevision: revision });
        }
        return outcome;
      });
    },
  };
}
