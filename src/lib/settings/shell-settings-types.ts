import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import type { ChipColorMap } from "@/lib/theme/chip-colors";

export interface ShellUser {
  username: string;
  authMethod: string;
}

/** Saved visible column ids per library type (`MOVIE`/`SERIES`/`MUSIC`). */
export type ColumnPreferences = Record<string, string[]>;

/**
 * The admin's display settings, read by the server layouts and handed to the
 * client, so the shell and its pages render them in the first paint instead
 * of fetching each one after hydration. A null field is "nothing saved": the
 * component's defaults apply.
 */
export interface ShellSettings {
  accentColor: string;
  user: ShellUser;
  chipColors: Partial<ChipColorMap> | null;
  columnPreferences: ColumnPreferences | null;
  cardDisplayPreferences: Record<string, unknown> | null;
  dashboardLayout: DashboardLayout | null;
  /** The "What's new" dialog is owed (the running version is newer than the last one seen). */
  whatsNewDue: boolean;
}
