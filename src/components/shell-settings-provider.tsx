"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { createShellSettingsStore, type ShellSettingsStore } from "@/lib/settings/shell-settings-store";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";

const ShellSettingsContext = createContext<ShellSettingsStore | null>(null);

// A tab hidden at least this long re-reads the settings when it comes back:
// the event stream may have dropped meanwhile (a sleeping laptop, a phone in a
// pocket), and nothing else would tell it what changed.
const STALE_AFTER_HIDDEN_MS = 60_000;

/**
 * The settings store the authenticated layout seeded. Null when it could not
 * read the settings (or outside the shell): each reader then fetches its own.
 */
export function useShellSettings(): ShellSettingsStore | null {
  return useContext(ShellSettingsContext);
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** The current settings, re-rendering on every change; null outside the shell. */
export function useShellSnapshot(): ShellSettings | null {
  const store = useShellSettings();
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getSnapshot : noSnapshot,
    store ? store.getSnapshot : noSnapshot,
  );
}

export function ShellSettingsProvider({
  initial,
  children,
}: {
  initial: ShellSettings | null;
  children: React.ReactNode;
}) {
  const [store] = useState(() =>
    initial
      ? createShellSettingsStore(initial, {
          // ThemeProvider sits above the shell and already applies an accent
          // the Settings page announces this way.
          onAccentChange: (accent) =>
            window.dispatchEvent(new CustomEvent("accent-color-changed", { detail: accent })),
        })
      : null,
  );

  // Saved in another tab or on another device. The hook also calls this once
  // when the stream reconnects, which covers saves made while it was down.
  useRealtime("display-settings:changed", () => {
    void store?.refresh();
  });

  useEffect(() => {
    if (!store) return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (hiddenFor >= STALE_AFTER_HIDDEN_MS) void store.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [store]);

  return <ShellSettingsContext.Provider value={store}>{children}</ShellSettingsContext.Provider>;
}
