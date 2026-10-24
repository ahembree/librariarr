"use client";

import { createContext, useContext, useState } from "react";
import { createShellSettingsStore, type ShellSettingsStore } from "@/lib/settings/shell-settings-store";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";

const ShellSettingsContext = createContext<ShellSettingsStore | null>(null);

/**
 * The settings the authenticated layout read on the server. Null when it could
 * not read them (or outside the shell): each reader then fetches its own.
 */
export function useShellSettings(): ShellSettingsStore | null {
  return useContext(ShellSettingsContext);
}

export function ShellSettingsProvider({
  initial,
  children,
}: {
  initial: ShellSettings | null;
  children: React.ReactNode;
}) {
  const [store] = useState(() => (initial ? createShellSettingsStore(initial) : null));
  return <ShellSettingsContext.Provider value={store}>{children}</ShellSettingsContext.Provider>;
}
