import { describe, it, expect } from "vitest";

import {
  ACCENT_PRESETS,
  ACCENT_NAMES,
  getAccentPreset,
} from "@/lib/theme/accent-colors";

// Every accent must override the same variable set: ThemeProvider's
// clearAccentColors() clears the union of keys across presets, so a preset
// missing a key would leave a stale override behind when switching accents.
const REQUIRED_VARS = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--chart-1",
];

describe("ACCENT_PRESETS", () => {
  it("keeps stored preset names stable", () => {
    // AppSettings.accentColor persists these names; renaming one would
    // silently reset affected users to the default accent.
    expect(ACCENT_PRESETS.map((p) => p.name)).toEqual([
      "default",
      "blue",
      "violet",
      "green",
      "orange",
      "rose",
      "teal",
    ]);
  });

  it("has unique names", () => {
    const names = ACCENT_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("defines the same variable set on every preset", () => {
    for (const preset of ACCENT_PRESETS) {
      expect(Object.keys(preset.cssVars).sort(), preset.name).toEqual(
        [...REQUIRED_VARS].sort(),
      );
    }
  });

  it("uses oklch values for every variable", () => {
    for (const preset of ACCENT_PRESETS) {
      for (const [key, value] of Object.entries(preset.cssVars)) {
        expect(value, `${preset.name} ${key}`).toMatch(/^oklch\(/);
      }
    }
  });

  it("provides a hex swatch color for the settings UI", () => {
    for (const preset of ACCENT_PRESETS) {
      expect(preset.color, preset.name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("ACCENT_NAMES", () => {
  it("mirrors preset order", () => {
    expect(ACCENT_NAMES).toEqual(ACCENT_PRESETS.map((p) => p.name));
  });
});

describe("getAccentPreset", () => {
  it("returns the preset by name", () => {
    expect(getAccentPreset("violet")?.label).toBe("Violet");
  });

  it("returns undefined for unknown names (graceful fallback to default)", () => {
    expect(getAccentPreset("magenta")).toBeUndefined();
  });
});
