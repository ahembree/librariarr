export interface AccentPreset {
  name: string;
  label: string;
  color: string; // Display color for the swatch (hex)
  cssVars: Record<string, string>;
}

/**
 * Build the CSS variable overrides for an accent.
 *
 * Accents drive the full `--brand` family (not just `--primary`) so the
 * sidebar search affordance, mobile tab bar, canvas atmosphere, and any
 * `text-brand-*` usage follow the user's choice. All accent hues sit at
 * L ≥ 0.66, so dark-on-accent text stays legible across the set.
 */
function accentVars(base: string, bright: string): Record<string, string> {
  const onBrand = "oklch(0.13 0.02 235)";
  return {
    "--brand": base,
    "--brand-bright": bright,
    "--brand-dim": `color-mix(in oklch, ${base} 15%, transparent)`,
    "--brand-faint": `color-mix(in oklch, ${base} 7%, transparent)`,
    "--on-brand": onBrand,
    "--primary": base,
    "--primary-foreground": onBrand,
    "--ring": base,
    "--sidebar-primary": base,
    "--sidebar-primary-foreground": onBrand,
    "--chart-1": base,
  };
}

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    // Lagoon cyan — the stylesheet default; selecting it clears overrides.
    name: "default",
    label: "Lagoon",
    color: "#09b7dc",
    cssVars: accentVars("oklch(0.72 0.13 220)", "oklch(0.8 0.11 215)"),
  },
  {
    name: "blue",
    label: "Blue",
    color: "#3f93f7",
    cssVars: accentVars("oklch(0.66 0.17 255)", "oklch(0.74 0.15 250)"),
  },
  {
    name: "violet",
    label: "Violet",
    color: "#ad74ff",
    cssVars: accentVars("oklch(0.68 0.2 300)", "oklch(0.76 0.17 300)"),
  },
  {
    name: "green",
    label: "Green",
    color: "#2cce99",
    cssVars: accentVars("oklch(0.76 0.15 165)", "oklch(0.82 0.13 163)"),
  },
  {
    name: "orange",
    label: "Orange",
    color: "#f6922e",
    cssVars: accentVars("oklch(0.75 0.16 60)", "oklch(0.82 0.14 65)"),
  },
  {
    name: "rose",
    label: "Rose",
    color: "#fc6183",
    cssVars: accentVars("oklch(0.7 0.19 10)", "oklch(0.78 0.16 12)"),
  },
  {
    name: "teal",
    label: "Teal",
    color: "#1dc5ae",
    cssVars: accentVars("oklch(0.74 0.13 180)", "oklch(0.81 0.11 178)"),
  },
];

export const ACCENT_NAMES = ACCENT_PRESETS.map((p) => p.name);

export function getAccentPreset(name: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.name === name);
}
