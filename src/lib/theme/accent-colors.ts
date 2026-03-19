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
      "--primary": "oklch(0.922 0 0)",
      "--primary-foreground": "oklch(0.205 0 0)",
      "--ring": "oklch(0.556 0 0)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    },
  },
  {
    name: "blue",
    label: "Blue",
    color: "#3b82f6",
    cssVars: {
      "--primary": "oklch(0.623 0.214 259.815)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": "oklch(0.623 0.214 259.815)",
      "--sidebar-primary": "oklch(0.623 0.214 259.815)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    },
  },
  {
    name: "violet",
    label: "Violet",
    color: "#8b5cf6",
    cssVars: {
      "--primary": "oklch(0.627 0.265 303.9)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": "oklch(0.627 0.265 303.9)",
      "--sidebar-primary": "oklch(0.627 0.265 303.9)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    },
  },
  {
    name: "green",
    label: "Green",
    color: "#22c55e",
    cssVars: {
      "--primary": "oklch(0.696 0.17 162.48)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": "oklch(0.696 0.17 162.48)",
      "--sidebar-primary": "oklch(0.696 0.17 162.48)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    },
  },
  {
    name: "orange",
    label: "Orange",
    color: "#f59e0b",
    cssVars: {
      "--primary": "oklch(0.769 0.188 70.08)",
      "--primary-foreground": "oklch(0.205 0 0)",
      "--ring": "oklch(0.769 0.188 70.08)",
      "--sidebar-primary": "oklch(0.769 0.188 70.08)",
      "--sidebar-primary-foreground": "oklch(0.205 0 0)",
    },
  },
  {
    name: "rose",
    label: "Rose",
    color: "#f43f5e",
    cssVars: {
      "--primary": "oklch(0.645 0.246 16.439)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": "oklch(0.645 0.246 16.439)",
      "--sidebar-primary": "oklch(0.645 0.246 16.439)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    },
  },
  {
    name: "teal",
    label: "Teal",
    color: "#14b8a6",
    cssVars: {
      "--primary": "oklch(0.6 0.118 184.704)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": "oklch(0.6 0.118 184.704)",
      "--sidebar-primary": "oklch(0.6 0.118 184.704)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    },
  },
];

export const ACCENT_NAMES = ACCENT_PRESETS.map((p) => p.name);

export function getAccentPreset(name: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((p) => p.name === name);
}
