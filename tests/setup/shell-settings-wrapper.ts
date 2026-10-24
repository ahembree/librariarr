import { createElement, type ReactNode } from "react";
import { ShellSettingsProvider } from "@/components/shell-settings-provider";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";

export const SHELL_SETTINGS: ShellSettings = {
  accentColor: "default",
  user: { username: "server-admin", authMethod: "Plex" },
  chipColors: null,
  columnPreferences: null,
  cardDisplayPreferences: null,
  dashboardLayout: null,
  whatsNewDue: false,
};

/** A `renderHook` wrapper standing in for the authenticated layout's read. */
export function shellSettingsWrapper(overrides: Partial<ShellSettings> = {}) {
  const initial = { ...SHELL_SETTINGS, ...overrides };
  return function Wrapper({ children }: { children: ReactNode }) {
    // The props type requires `children`, which lint wants as the third argument.
    const props = { initial } as Parameters<typeof ShellSettingsProvider>[0];
    return createElement(ShellSettingsProvider, props, children);
  };
}
