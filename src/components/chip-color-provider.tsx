"use client";

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { useShellSettings, useShellSnapshot } from "@/components/shell-settings-provider";
import type { ChipColorMap, ChipColorCategory } from "@/lib/theme/chip-colors";
import {
  DEFAULT_CHIP_COLORS,
  FALLBACK_HEX,
  mergeChipColors,
  getChipBadgeStyle,
  getChipSolidStyle,
} from "@/lib/theme/chip-colors";

interface ChipColorContextValue {
  colors: ChipColorMap;
  /** Get hex color for a category + value */
  getHex: (category: ChipColorCategory, value: string) => string;
  /** Get inline styles for a semi-transparent badge */
  getBadgeStyle: (category: ChipColorCategory, value: string) => React.CSSProperties;
  /** Get inline styles for a solid badge */
  getSolidStyle: (category: ChipColorCategory, value: string) => React.CSSProperties;
  /** Update colors (triggers save to server) */
  updateColors: (newColors: ChipColorMap) => void;
}

const ChipColorContext = createContext<ChipColorContextValue>({
  colors: DEFAULT_CHIP_COLORS,
  getHex: () => FALLBACK_HEX,
  getBadgeStyle: () => ({}),
  getSolidStyle: () => ({}),
  updateColors: () => {},
});

export function useChipColors() {
  return useContext(ChipColorContext);
}

function resolveHex(colors: ChipColorMap, category: ChipColorCategory, value: string): string {
  const map = colors[category];
  if (map[value]) return map[value];
  const lower = value.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return FALLBACK_HEX;
}

export function ChipColorProvider({ children }: { children: React.ReactNode }) {
  // Inside the shell the saved colours come from its settings store, which the
  // layout seeded and every save elsewhere refreshes; fetched after hydration,
  // every chip drew in the default colours first. Only outside it (or when the
  // layout could not read them) are they fetched here.
  const shell = useShellSettings();
  const snapshot = useShellSnapshot();
  // Keyed on the saved map itself, so a refresh that changed something else
  // keeps every chip's style object.
  const inShell = snapshot !== null;
  const savedColors = snapshot?.chipColors ?? null;
  const shellColors = useMemo(
    () => (inShell ? mergeChipColors(savedColors) : null),
    [inShell, savedColors],
  );
  const [fetchedColors, setFetchedColors] = useState<ChipColorMap>(DEFAULT_CHIP_COLORS);
  const colors = shellColors ?? fetchedColors;

  useEffect(() => {
    if (shell) return;
    fetch("/api/settings/chip-colors")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.chipColors) {
          setFetchedColors(mergeChipColors(data.chipColors));
        }
      })
      .catch((e) => console.error("Failed to fetch chip colors", e));
  }, [shell]);

  const updateColors = useCallback((newColors: ChipColorMap) => {
    if (shell) shell.setChipColors(newColors);
    else setFetchedColors(newColors);
    fetch("/api/settings/chip-colors", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chipColors: newColors }),
    }).catch((e) => console.error("Failed to save chip colors", e));
  }, [shell]);

  const getHex = useCallback(
    (category: ChipColorCategory, value: string) => resolveHex(colors, category, value),
    [colors]
  );

  const getBadgeStyle = useCallback(
    (category: ChipColorCategory, value: string) => getChipBadgeStyle(resolveHex(colors, category, value)),
    [colors]
  );

  const getSolidStyle = useCallback(
    (category: ChipColorCategory, value: string) => getChipSolidStyle(resolveHex(colors, category, value)),
    [colors]
  );

  // One object per colour change: the provider sits above the whole shell and
  // re-renders whenever the shell settings do, and a fresh object each time
  // re-rendered every chip on the page with it.
  const value = useMemo(
    () => ({ colors, getHex, getBadgeStyle, getSolidStyle, updateColors }),
    [colors, getHex, getBadgeStyle, getSolidStyle, updateColors],
  );

  return (
    <ChipColorContext.Provider value={value}>
      {children}
    </ChipColorContext.Provider>
  );
}
