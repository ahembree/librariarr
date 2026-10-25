import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import type { ChipColorMap } from "@/lib/theme/chip-colors";
import type { LibraryTypes } from "@/lib/media/library-types";

export interface ShellUser {
  username: string;
  authMethod: string;
}

/** Saved visible column ids per library type (`MOVIE`/`SERIES`/`MUSIC`). */
export type ColumnPreferences = Record<string, string[]>;

/**
 * The admin's display settings and the little the shell itself shows (the
 * sidebar's library links, the maintenance banner), read by the server layouts
 * and handed to the client, so the shell and its pages render them in the
 * first paint instead of fetching each one after hydration. A null field is "nothing saved": the
 * component's defaults apply.
 */
export interface ShellSettings {
  accentColor: string;
  user: ShellUser;
  chipColors: Partial<ChipColorMap> | null;
  columnPreferences: ColumnPreferences | null;
  /** `AppSettings.columnPreferencesRevision`: sent with a column save, refused (409) once stale. */
  columnPreferencesRevision: number;
  cardDisplayPreferences: Record<string, unknown> | null;
  dashboardLayout: DashboardLayout | null;
  /** `AppSettings.dashboardLayoutRevision`: sent with a layout save, refused (409) once stale. */
  dashboardLayoutRevision: number;
  /** The "What's new" dialog is owed (the running version is newer than the last one seen). */
  whatsNewDue: boolean;
  /**
   * Which library types exist, for the sidebar's Library links and the
   * dashboard's tiles (`GET /api/media/library-types`'s answer). Kept current
   * by those readers' own `server:changed`/`sync:completed` refetches, not by
   * `display-settings:changed`.
   */
  libraryTypes: LibraryTypes;
  /** Maintenance mode is on, for the shell's banner (refetched on `settings:changed`). */
  maintenanceActive: boolean;
}
