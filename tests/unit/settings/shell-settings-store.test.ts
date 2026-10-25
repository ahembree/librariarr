import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShellSettingsStore, SHELL_SETTINGS_URL } from "@/lib/settings/shell-settings-store";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";
import type { DashboardLayout } from "@/lib/dashboard/card-registry";

const initial: ShellSettings = {
  accentColor: "default",
  user: { username: "admin", authMethod: "Plex" },
  chipColors: null,
  columnPreferences: { MOVIE: ["title"] },
  columnPreferencesRevision: 2,
  cardDisplayPreferences: null,
  dashboardLayout: null,
  dashboardLayoutRevision: 4,
  whatsNewDue: true,
  libraryTypes: { types: ["MOVIE"], allTypes: ["MOVIE"] },
  maintenanceActive: false,
};

const layoutWith = (id: string) => ({ main: [{ id, size: 12 }], movies: [], series: [], music: [] }) as unknown as DashboardLayout;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
// Each request waits for the test to answer it, so ordering can be driven.
let pending: { call: Call; resolve: (r: { status: number; body?: unknown }) => void }[];

function answer(index: number, status: number, body?: unknown) {
  pending[index].resolve({ status, body });
}

beforeEach(() => {
  calls = [];
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      calls.push(call);
      return new Promise((resolve) => {
        pending.push({
          call,
          resolve: ({ status, body }) =>
            resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
        });
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("createShellSettingsStore", () => {
  it("answers with what the layout read and notifies on local changes", () => {
    const store = createShellSettingsStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSnapshot()).toBe(initial);

    store.setWhatsNewSeen();
    store.setChipColors({ resolution: { "4K": "#000000" } } as never);
    store.setCardDisplayPreferences({ MOVIE: { badges: {}, metadata: {}, servers: false } });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().whatsNewDue).toBe(false);
    expect(store.getSnapshot().chipColors).toEqual({ resolution: { "4K": "#000000" } });
    expect(store.getSnapshot().cardDisplayPreferences).toEqual({ MOVIE: { badges: {}, metadata: {}, servers: false } });
    // The layout's object is never mutated.
    expect(initial.whatsNewDue).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    const store = createShellSettingsStore(initial);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setWhatsNewSeen();
    expect(listener).not.toHaveBeenCalled();
  });

  describe("saveDashboardLayout", () => {
    it("shows the layout at once and saves it against the held revision", async () => {
      const store = createShellSettingsStore(initial);
      const saving = store.saveDashboardLayout(layoutWith("genre"));
      expect(store.getSnapshot().dashboardLayout).toEqual(layoutWith("genre"));
      await settle();

      expect(calls[0]).toEqual({
        url: "/api/settings/dashboard-layout",
        method: "PUT",
        body: { layout: layoutWith("genre"), revision: 4 },
      });
      answer(0, 200, { layout: layoutWith("genre"), revision: 5 });
      await expect(saving).resolves.toBe("saved");
      expect(store.getSnapshot().dashboardLayoutRevision).toBe(5);
    });

    it("sends this tab's successive saves one at a time, each on the revision the last one returned", async () => {
      const store = createShellSettingsStore(initial);
      const first = store.saveDashboardLayout(layoutWith("genre"));
      const second = store.saveDashboardLayout(layoutWith("year"));
      await settle();
      expect(calls).toHaveLength(1);

      answer(0, 200, { revision: 5 });
      await expect(first).resolves.toBe("saved");
      await settle();
      expect(calls[1].body).toEqual({ layout: layoutWith("year"), revision: 5 });
      answer(1, 200, { revision: 6 });
      await expect(second).resolves.toBe("saved");
      expect(store.getSnapshot().dashboardLayout).toEqual(layoutWith("year"));
    });

    it("on a 409 refuses the saves queued behind it and loads the newer settings", async () => {
      const store = createShellSettingsStore(initial);
      const first = store.saveDashboardLayout(layoutWith("genre"));
      const second = store.saveDashboardLayout(layoutWith("year"));
      await settle();

      answer(0, 409, { code: "stale_revision", revision: 7 });
      await expect(first).resolves.toBe("conflict");
      // Built on the same stale copy: never sent.
      await expect(second).resolves.toBe("conflict");
      await settle();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "PUT /api/settings/dashboard-layout",
        `GET ${SHELL_SETTINGS_URL}`,
      ]);

      const fresh = { ...initial, dashboardLayout: layoutWith("studio"), dashboardLayoutRevision: 7 };
      answer(1, 200, fresh);
      await settle();
      expect(store.getSnapshot().dashboardLayout).toEqual(layoutWith("studio"));

      // Saving works again once the newer copy is in.
      const third = store.saveDashboardLayout(layoutWith("year"));
      await settle();
      expect(calls[2].body).toEqual({ layout: layoutWith("year"), revision: 7 });
      answer(2, 200, { revision: 8 });
      await expect(third).resolves.toBe("saved");
    });

    it("reports a refused or unreachable save as failed and keeps the edit on screen", async () => {
      const store = createShellSettingsStore(initial);
      const refused = store.saveDashboardLayout(layoutWith("genre"));
      await settle();
      answer(0, 500);
      await expect(refused).resolves.toBe("failed");
      expect(store.getSnapshot().dashboardLayout).toEqual(layoutWith("genre"));

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      await expect(store.saveDashboardLayout(layoutWith("year"))).resolves.toBe("failed");
    });
  });

  describe("saveColumns", () => {
    it("shows a change at once and sends only the latest after the pause", async () => {
      vi.useFakeTimers();
      const store = createShellSettingsStore(initial);
      const first = store.saveColumns("SERIES", ["title"]);
      const second = store.saveColumns("SERIES", ["title", "year"]);
      expect(store.getSnapshot().columnPreferences).toEqual({ MOVIE: ["title"], SERIES: ["title", "year"] });

      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ type: "SERIES", columns: ["title", "year"], revision: 2 });

      answer(0, 200, { success: true, revision: 3 });
      await expect(first).resolves.toBe("saved");
      await expect(second).resolves.toBe("saved");
      expect(store.getSnapshot().columnPreferencesRevision).toBe(3);
    });

    it("reports a 409 and loads the newer settings", async () => {
      vi.useFakeTimers();
      const store = createShellSettingsStore(initial);
      const saving = store.saveColumns("MOVIE", ["year"]);
      await vi.advanceTimersByTimeAsync(500);
      answer(0, 409, { code: "stale_revision", revision: 9 });
      await expect(saving).resolves.toBe("conflict");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls[1].url).toBe(SHELL_SETTINGS_URL);
      answer(1, 200, { ...initial, columnPreferences: { MOVIE: ["rating"] }, columnPreferencesRevision: 9 });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getSnapshot().columnPreferences).toEqual({ MOVIE: ["rating"] });
    });
  });

  describe("refresh", () => {
    it("replaces the copy with the server's and announces a changed accent", async () => {
      const onAccentChange = vi.fn();
      const store = createShellSettingsStore(initial, { onAccentChange });
      const listener = vi.fn();
      store.subscribe(listener);

      const refreshing = store.refresh();
      await settle();
      expect(calls[0]).toMatchObject({ url: SHELL_SETTINGS_URL, method: "GET" });
      answer(0, 200, { ...initial, accentColor: "violet", whatsNewDue: false });
      await refreshing;

      expect(store.getSnapshot().accentColor).toBe("violet");
      expect(store.getSnapshot().whatsNewDue).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(onAccentChange).toHaveBeenCalledWith("violet");
    });

    it("does not announce an unchanged accent", async () => {
      const onAccentChange = vi.fn();
      const store = createShellSettingsStore(initial, { onAccentChange });
      const refreshing = store.refresh();
      await settle();
      answer(0, 200, initial);
      await refreshing;
      expect(onAccentChange).not.toHaveBeenCalled();
    });

    it("waits while a save is in flight, then asks", async () => {
      const store = createShellSettingsStore(initial);
      const saving = store.saveDashboardLayout(layoutWith("genre"));
      await settle();
      await store.refresh();
      expect(calls).toHaveLength(1);

      answer(0, 200, { revision: 5 });
      await saving;
      await settle();
      expect(calls[1].url).toBe(SHELL_SETTINGS_URL);
    });

    it("waits during a column change's pause, so the old columns never come back", async () => {
      vi.useFakeTimers();
      const store = createShellSettingsStore(initial);
      void store.saveColumns("MOVIE", ["year"]);
      await store.refresh();
      expect(calls).toHaveLength(0);
      expect(store.getSnapshot().columnPreferences).toEqual({ MOVIE: ["year"] });
    });

    it("drops an answer that crossed a local change, and asks again", async () => {
      const store = createShellSettingsStore(initial);
      const refreshing = store.refresh();
      await settle();
      store.setChipColors({ resolution: { "4K": "#111111" } } as never);
      answer(0, 200, { ...initial, chipColors: null });
      await settle();
      expect(store.getSnapshot().chipColors).toEqual({ resolution: { "4K": "#111111" } });

      expect(calls[1].url).toBe(SHELL_SETTINGS_URL);
      answer(1, 200, { ...initial, chipColors: { resolution: { "4K": "#111111" } } });
      await refreshing;
      expect(store.getSnapshot().chipColors).toEqual({ resolution: { "4K": "#111111" } });
    });

    it("keeps the copy when the server refuses or cannot be reached", async () => {
      const store = createShellSettingsStore(initial);
      const refused = store.refresh();
      await settle();
      answer(0, 401);
      await refused;
      expect(store.getSnapshot()).toBe(initial);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      await store.refresh();
      expect(store.getSnapshot()).toBe(initial);
    });

    it("joins a refresh already in flight and asks once more after it", async () => {
      const store = createShellSettingsStore(initial);
      const first = store.refresh();
      const second = store.refresh();
      await settle();
      expect(calls).toHaveLength(1);
      answer(0, 200, initial);
      await settle();
      expect(calls).toHaveLength(2);
      answer(1, 200, { ...initial, accentColor: "violet" });
      await Promise.all([first, second]);
      expect(store.getSnapshot().accentColor).toBe("violet");
    });
  });
});
