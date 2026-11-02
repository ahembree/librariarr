import { describe, it, expect } from "vitest";
import { selectionError } from "@/lib/trash/selection";
import type { TrashCatalog } from "@/lib/trash/types";

const catalog = {
  service: "RADARR",
  ref: "master",
  fetchedAt: "",
  customFormats: [
    { trash_id: "cf1", name: "AMZN", trash_scores: { default: 100, "sqp-1-2160p": 50 }, specifications: [] },
  ],
  cfGroups: [],
  qualityProfiles: [],
  qualitySize: null,
  naming: {
    file: { standard: "x" },
    folder: { default: "y" },
    series: { default: "s" },
    episodes: { standard: { default: "e" } },
  },
} as unknown as TrashCatalog;

describe("selectionError", () => {
  it("accepts no selection for any resource type", () => {
    expect(selectionError("CUSTOM_FORMAT", "RADARR", undefined, catalog)).toBeNull();
    expect(selectionError("NAMING", "RADARR", null, catalog)).toBeNull();
  });

  it("refuses options on resources that take none", () => {
    expect(selectionError("CUSTOM_FORMAT", "RADARR", { file: "standard" }, catalog)).toBe("This resource takes no options.");
    expect(selectionError("CUSTOM_FORMAT", "RADARR", ["standard"], catalog)).toBe("Invalid selection.");
    expect(selectionError("QUALITY_DEFINITION", "RADARR", {}, catalog)).toBeNull();
  });

  it("checks naming keys per app and variants against the guide", () => {
    expect(selectionError("NAMING", "RADARR", { file: "standard", folder: "default" }, catalog)).toBeNull();
    expect(selectionError("NAMING", "RADARR", { series: "default" }, catalog)).toBe(
      "These naming formats don't apply to Radarr: series.",
    );
    expect(selectionError("NAMING", "SONARR", { series: "default", standard: "default" }, catalog)).toBeNull();
    expect(selectionError("NAMING", "SONARR", { file: "standard" }, catalog)).toBe(
      "These naming formats don't apply to Sonarr: file.",
    );
    expect(selectionError("NAMING", "RADARR", { file: "nope" }, catalog)).toBe(
      'Naming variant "nope" for "file" is not in the guide.',
    );
    // An episode variant is looked up under the guide's `episodes` block.
    expect(selectionError("NAMING", "SONARR", { daily: "default" }, catalog)).toBe(
      'Naming variant "default" for "daily" is not in the guide.',
    );
  });

  it("checks quality-profile options and their score set", () => {
    expect(selectionError("QUALITY_PROFILE", "RADARR", {}, catalog)).toBeNull();
    expect(selectionError("QUALITY_PROFILE", "RADARR", { scoreSet: "sqp-1-2160p", resetUnmatchedScores: true }, catalog)).toBeNull();
    expect(selectionError("QUALITY_PROFILE", "RADARR", { scoreSet: "missing" }, catalog)).toBe(
      'Score set "missing" is not in the guide.',
    );
    expect(selectionError("QUALITY_PROFILE", "RADARR", { formats: [] }, catalog)).toBe(
      "Unknown quality-profile options: formats.",
    );
  });

  it("requires a formats list for profile custom formats", () => {
    expect(selectionError("PROFILE_CF", "RADARR", { formats: [] }, catalog)).toBeNull();
    expect(selectionError("PROFILE_CF", "RADARR", { file: "standard" }, catalog)).toBe(
      "Profile custom formats need a list of formats.",
    );
    // The formats list is the only key a PROFILE_CF selection takes.
    expect(selectionError("PROFILE_CF", "RADARR", { formats: [], file: "standard" }, catalog)).toBe(
      "Profile custom formats need a list of formats.",
    );
  });
});
