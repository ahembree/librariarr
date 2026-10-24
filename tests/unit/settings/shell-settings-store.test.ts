import { describe, it, expect } from "vitest";
import { createShellSettingsStore } from "@/lib/settings/shell-settings-store";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";

const initial: ShellSettings = {
  accentColor: "default",
  user: { username: "admin", authMethod: "Plex" },
  chipColors: null,
  columnPreferences: { MOVIE: ["title"] },
  cardDisplayPreferences: null,
  dashboardLayout: null,
  whatsNewDue: true,
};

describe("createShellSettingsStore", () => {
  it("answers with what the layout read", () => {
    const store = createShellSettingsStore(initial);
    expect(store.user).toEqual({ username: "admin", authMethod: "Plex" });
    expect(store.whatsNewDue()).toBe(true);
    expect(store.columnPreferences()).toEqual({ MOVIE: ["title"] });
    expect(store.cardDisplayPreferences()).toBeNull();
    expect(store.dashboardLayout()).toBeNull();
  });

  it("answers later reads with what was saved since", () => {
    const store = createShellSettingsStore(initial);
    store.setColumnPreferences("SERIES", ["title", "year"]);
    store.setColumnPreferences("MOVIE", ["year"]);
    expect(store.columnPreferences()).toEqual({ MOVIE: ["year"], SERIES: ["title", "year"] });

    const cards = { MOVIE: { badges: {}, metadata: {}, servers: false } };
    store.setCardDisplayPreferences(cards);
    expect(store.cardDisplayPreferences()).toBe(cards);

    const layout = { main: [{ id: "stats" }] } as unknown as Parameters<typeof store.setDashboardLayout>[0];
    store.setDashboardLayout(layout);
    expect(store.dashboardLayout()).toBe(layout);

    store.setWhatsNewSeen();
    expect(store.whatsNewDue()).toBe(false);
  });

  it("adds a type's columns when nothing was saved before", () => {
    const store = createShellSettingsStore({ ...initial, columnPreferences: null });
    store.setColumnPreferences("MUSIC", ["title"]);
    expect(store.columnPreferences()).toEqual({ MUSIC: ["title"] });
  });

  it("never mutates the layout's object", () => {
    const columns = { MOVIE: ["title"] };
    const store = createShellSettingsStore({ ...initial, columnPreferences: columns });
    store.setColumnPreferences("MOVIE", ["year"]);
    expect(columns).toEqual({ MOVIE: ["title"] });
  });
});
