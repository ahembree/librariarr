"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
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
  const [colors, setColors] = useState<ChipColorMap>(DEFAULT_CHIP_COLORS);

  useEffect(() => {
    fetch("/api/settings/chip-colors")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.chipColors) {
          setColors(mergeChipColors(data.chipColors));
        }
      })
      .catch((e) => console.error("Failed to fetch chip colors", e));
  }, []);

  const updateColors = useCallback((newColors: ChipColorMap) => {
    setColors(newColors);
    fetch("/api/settings/chip-colors", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chipColors: newColors }),
    }).catch((e) => console.error("Failed to save chip colors", e));
  }, []);

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

  return (
    <ChipColorContext.Provider value={{ colors, getHex, getBadgeStyle, getSolidStyle, updateColors }}>
      {children}
    </ChipColorContext.Provider>
  );
}
