"use client";

import { useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
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

export function ThemeProvider({
  children,
  initialAccent,
}: {
  children: React.ReactNode;
  // The accent the server rendered onto <html>; null when it could not tell
  // (signed out), in which case it is fetched here.
  initialAccent?: string | null;
}) {
  const handleAccentChange = useCallback((event: Event) => {
    const name = (event as CustomEvent<string>).detail;
    if (name === "default") {
      clearAccentColors();
    } else {
      applyAccentColors(name);
    }
  }, []);

  // The accent is known once the server rendered it or a fetch answered.
  const resolved = useRef(initialAccent != null);
  const pathname = usePathname();

  useEffect(() => {
    // Signed out at first render (the login page): a client-side sign-in keeps
    // the root layout, so ask again on each navigation until an answer comes.
    if (resolved.current) return;
    let cancelled = false;
    fetch("/api/settings/accent-color")
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data?.accentColor) return;
        resolved.current = true;
        if (data.accentColor !== "default") applyAccentColors(data.accentColor);
      })
      .catch(() => {
        // Unauthenticated or network error — use defaults
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    // Listen for instant updates from settings page
    window.addEventListener("accent-color-changed", handleAccentChange);
    return () => {
      window.removeEventListener("accent-color-changed", handleAccentChange);
    };
  }, [handleAccentChange]);

  return <>{children}</>;
}
