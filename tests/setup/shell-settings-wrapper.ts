import { createElement, type ReactNode } from "react";
import { ShellSettingsProvider } from "@/components/shell-settings-provider";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";

export const SHELL_SETTINGS: ShellSettings = {
  accentColor: "default",
  user: { username: "server-admin", authMethod: "Plex" },
  chipColors: null,
  columnPreferences: null,
  columnPreferencesRevision: 0,
  cardDisplayPreferences: null,
  dashboardLayout: null,
  dashboardLayoutRevision: 0,
  whatsNewDue: false,
};

/**
 * A `renderHook` wrapper standing in for the authenticated layout's read. The
 * provider subscribes to the event stream, so a test using it mocks
 * `@/hooks/use-realtime`.
 */
export function shellSettingsWrapper(overrides: Partial<ShellSettings> = {}) {
  const initial = { ...SHELL_SETTINGS, ...overrides };
  return function Wrapper({ children }: { children: ReactNode }) {
    // The props type requires `children`, which lint wants as the third argument.
    const props = { initial } as Parameters<typeof ShellSettingsProvider>[0];
    return createElement(ShellSettingsProvider, props, children);
  };
}
