"use client";

import { useEffect, useCallback } from "react";
import { ACCENT_PRESETS, getAccentPreset } from "@/lib/theme/accent-colors";

function applyAccentColors(name: string) {
  const preset = getAccentPreset(name);
  if (!preset) return;

  const root = document.documentElement;
  for (const [prop, value] of Object.entries(preset.cssVars)) {
    root.style.setProperty(prop, value);
  }
}

function clearAccentColors() {
  const root = document.documentElement;
  // Clear all possible accent CSS vars so defaults from stylesheet apply
  const allVars = new Set(ACCENT_PRESETS.flatMap((p) => Object.keys(p.cssVars)));
  for (const prop of allVars) {
    root.style.removeProperty(prop);
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const handleAccentChange = useCallback((event: Event) => {
    const name = (event as CustomEvent<string>).detail;
    if (name === "default") {
      clearAccentColors();
    } else {
      applyAccentColors(name);
    }
  }, []);

  useEffect(() => {
    // Fetch accent color on mount
    fetch("/api/settings/accent-color")
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (data?.accentColor && data.accentColor !== "default") {
          applyAccentColors(data.accentColor);
        }
      })
      .catch(() => {
        // Unauthenticated or network error — use defaults
      });

    // Listen for instant updates from settings page
    window.addEventListener("accent-color-changed", handleAccentChange);
    return () => {
      window.removeEventListener("accent-color-changed", handleAccentChange);
    };
  }, [handleAccentChange]);

  return <>{children}</>;
}
