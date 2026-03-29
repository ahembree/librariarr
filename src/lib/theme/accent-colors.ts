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
    },
  },
];

export const ACCENT_NAMES = ACCENT_PRESETS.map((p) => p.name);

export function getAccentPreset(name: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.name === name);
}
