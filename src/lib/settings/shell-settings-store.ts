import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import type { ColumnPreferences, ShellSettings, ShellUser } from "@/lib/settings/shell-settings-types";

/**
 * The client's copy of the settings the server layout read. The layout renders
 * once and persists across client-side navigations, so a page that saves one
 * of these writes it back here too — the next page mounting reads the saved
 * value rather than the one the layout rendered.
 *
 * Read at mount, written on save; not reactive. Every reader keeps the value
 * in its own state, so nothing has to re-render when another page saves.
 */
export interface ShellSettingsStore {
  readonly user: ShellUser;
  whatsNewDue(): boolean;
  setWhatsNewSeen(): void;
  columnPreferences(): ColumnPreferences | null;
  setColumnPreferences(type: string, columns: string[]): void;
  cardDisplayPreferences(): Record<string, unknown> | null;
  setCardDisplayPreferences(preferences: Record<string, unknown>): void;
  dashboardLayout(): DashboardLayout | null;
  setDashboardLayout(layout: DashboardLayout): void;
}

export function createShellSettingsStore(initial: ShellSettings): ShellSettingsStore {
  let whatsNewDue = initial.whatsNewDue;
  let columnPreferences = initial.columnPreferences;
  let cardDisplayPreferences = initial.cardDisplayPreferences;
  let dashboardLayout = initial.dashboardLayout;

  return {
    user: initial.user,
    whatsNewDue: () => whatsNewDue,
    setWhatsNewSeen: () => {
      whatsNewDue = false;
    },
    columnPreferences: () => columnPreferences,
    setColumnPreferences: (type, columns) => {
      columnPreferences = { ...columnPreferences, [type]: columns };
    },
    cardDisplayPreferences: () => cardDisplayPreferences,
    setCardDisplayPreferences: (preferences) => {
      cardDisplayPreferences = preferences;
    },
    dashboardLayout: () => dashboardLayout,
    setDashboardLayout: (layout) => {
      dashboardLayout = layout;
    },
  };
}
