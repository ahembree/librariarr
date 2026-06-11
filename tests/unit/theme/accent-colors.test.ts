import { describe, it, expect } from "vitest";

import {
  ACCENT_PRESETS,
  ACCENT_NAMES,
  getAccentPreset,
} from "@/lib/theme/accent-colors";

// ThemeProvider's clearAccentColors() clears the union of keys across
// presets, so consistent key sets per preset kind keep switching accents
// from leaving stale overrides behind.
const CORE_VARS = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--chart-1",
];

// Non-default accents must also drive the --brand token family — the
// dashboard (sparklines, tile icons, tab bar, row fills) renders from
// these, so an accent that skips them visibly "doesn't work".
const BRAND_VARS = ["--brand", "--brand-bright", "--brand-dim", "--brand-faint"];

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

  it("defines the core variable set on the default preset", () => {
    const preset = getAccentPreset("default")!;
    expect(Object.keys(preset.cssVars).sort()).toEqual([...CORE_VARS].sort());
  });

  it("defines core + brand variables on every non-default preset", () => {
    for (const preset of ACCENT_PRESETS.filter((p) => p.name !== "default")) {
      expect(Object.keys(preset.cssVars).sort(), preset.name).toEqual(
        [...CORE_VARS, ...BRAND_VARS].sort(),
      );
    }
  });

  it("uses oklch or oklch color-mix values for every variable", () => {
    for (const preset of ACCENT_PRESETS) {
      for (const [key, value] of Object.entries(preset.cssVars)) {
        expect(value, `${preset.name} ${key}`).toMatch(
          /^(oklch\(|color-mix\(in oklch,)/,
        );
      }
    }
  });

  it("keeps --brand aligned with --primary on non-default presets", () => {
    for (const preset of ACCENT_PRESETS.filter((p) => p.name !== "default")) {
      expect(preset.cssVars["--brand"], preset.name).toBe(
        preset.cssVars["--primary"],
      );
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
