export interface AccentPreset {
  name: string;
  label: string;
  color: string; // Display color for the swatch (hex)
  cssVars: Record<string, string>;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    name: "default",
    label: "Default",
    color: "#e5e5e5",
    cssVars: {
      "--primary": "oklch(0.90 0 0)",
      "--primary-foreground": "oklch(0.18 0.01 270)",
      "--ring": "oklch(0.50 0.015 260)",
      "--sidebar-primary": "oklch(0.55 0.26 264)",
      "--sidebar-primary-foreground": "oklch(0.95 0.008 80)",
      "--chart-1": "oklch(0.55 0.26 264)",
    },
  },
  {
    name: "blue",
    label: "Blue",
    color: "#3b82f6",
    cssVars: {
      "--primary": "oklch(0.65 0.24 260)",
      "--primary-foreground": "oklch(0.95 0.008 80)",
      "--ring": "oklch(0.65 0.24 260)",
      "--sidebar-primary": "oklch(0.65 0.24 260)",
      "--sidebar-primary-foreground": "oklch(0.95 0.008 80)",
      "--chart-1": "oklch(0.65 0.24 260)",
      "--brand": "oklch(0.65 0.24 260)",
      "--brand-bright": "oklch(0.73 0.2 260)",
      "--brand-dim": "color-mix(in oklch, oklch(0.65 0.24 260) 15%, transparent)",
      "--brand-faint": "color-mix(in oklch, oklch(0.65 0.24 260) 8%, transparent)",
    },
  },
  {
    name: "violet",
    label: "Violet",
    color: "#8b5cf6",
    cssVars: {
      "--primary": "oklch(0.65 0.28 304)",
      "--primary-foreground": "oklch(0.95 0.008 80)",
      "--ring": "oklch(0.65 0.28 304)",
      "--sidebar-primary": "oklch(0.65 0.28 304)",
      "--sidebar-primary-foreground": "oklch(0.95 0.008 80)",
      "--chart-1": "oklch(0.65 0.28 304)",
      "--brand": "oklch(0.65 0.28 304)",
      "--brand-bright": "oklch(0.73 0.23 304)",
      "--brand-dim": "color-mix(in oklch, oklch(0.65 0.28 304) 15%, transparent)",
      "--brand-faint": "color-mix(in oklch, oklch(0.65 0.28 304) 8%, transparent)",
    },
  },
  {
    name: "green",
    label: "Green",
    color: "#22c55e",
    cssVars: {
      "--primary": "oklch(0.72 0.19 162)",
      "--primary-foreground": "oklch(0.95 0.008 80)",
      "--ring": "oklch(0.72 0.19 162)",
      "--sidebar-primary": "oklch(0.72 0.19 162)",
      "--sidebar-primary-foreground": "oklch(0.95 0.008 80)",
      "--chart-1": "oklch(0.72 0.19 162)",
      "--brand": "oklch(0.72 0.19 162)",
      "--brand-bright": "oklch(0.79 0.16 162)",
      "--brand-dim": "color-mix(in oklch, oklch(0.72 0.19 162) 15%, transparent)",
      "--brand-faint": "color-mix(in oklch, oklch(0.72 0.19 162) 8%, transparent)",
    },
  },
  {
    name: "orange",
    label: "Orange",
    color: "#f59e0b",
    cssVars: {
      "--primary": "oklch(0.78 0.20 70)",
      "--primary-foreground": "oklch(0.18 0.01 270)",
      "--ring": "oklch(0.78 0.20 70)",
      "--sidebar-primary": "oklch(0.78 0.20 70)",
      "--sidebar-primary-foreground": "oklch(0.18 0.01 270)",
      "--chart-1": "oklch(0.78 0.20 70)",
      "--brand": "oklch(0.78 0.20 70)",
      "--brand-bright": "oklch(0.84 0.17 70)",
      "--brand-dim": "color-mix(in oklch, oklch(0.78 0.20 70) 15%, transparent)",
      "--brand-faint": "color-mix(in oklch, oklch(0.78 0.20 70) 8%, transparent)",
    },
  },
  {
    name: "rose",
    label: "Rose",
    color: "#f43f5e",
    cssVars: {
      "--primary": "oklch(0.67 0.26 16)",
      "--primary-foreground": "oklch(0.95 0.008 80)",
      "--ring": "oklch(0.67 0.26 16)",
      "--sidebar-primary": "oklch(0.67 0.26 16)",
      "--sidebar-primary-foreground": "oklch(0.95 0.008 80)",
      "--chart-1": "oklch(0.67 0.26 16)",
      "--brand": "oklch(0.67 0.26 16)",
      "--brand-bright": "oklch(0.75 0.21 16)",
      "--brand-dim": "color-mix(in oklch, oklch(0.67 0.26 16) 15%, transparent)",
      "--brand-faint": "color-mix(in oklch, oklch(0.67 0.26 16) 8%, transparent)",
    },
  },
  {
    name: "teal",
    label: "Teal",
    color: "#14b8a6",
    cssVars: {
      "--primary": "oklch(0.65 0.14 185)",
      "--primary-foreground": "oklch(0.95 0.008 80)",
      "--ring": "oklch(0.65 0.14 185)",
      "--sidebar-primary": "oklch(0.65 0.14 185)",
      "--sidebar-primary-foreground": "oklch(0.95 0.008 80)",
      "--chart-1": "oklch(0.65 0.14 185)",
      "--brand": "oklch(0.65 0.14 185)",
      "--brand-bright": "oklch(0.73 0.12 185)",
      "--brand-dim": "color-mix(in oklch, oklch(0.65 0.14 185) 15%, transparent)",
      "--brand-faint": "color-mix(in oklch, oklch(0.65 0.14 185) 8%, transparent)",
    },
  },
];

export const ACCENT_NAMES = ACCENT_PRESETS.map((p) => p.name);

export function getAccentPreset(name: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.name === name);
}
