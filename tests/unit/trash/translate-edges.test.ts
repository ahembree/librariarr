import { describe, it, expect } from "vitest";
import {
  specFieldsToArray,
  trashCfToArr,
  cfComparable,
  projectManagedFields,
  findManagedArrResource,
  applyQualitySizes,
  qualityDefsComparable,
  buildQualityProfile,
  profileComparable,
  applyNaming,
  namingComparable,
} from "@/lib/trash/translate";
import type {
  ArrCustomFormat,
  ArrQualityDefinition,
  ArrQualityProfile,
  ArrQualityProfileSchema,
  TrashCustomFormat,
  TrashQualityProfile,
} from "@/lib/trash/types";

const q = (id: number, name: string) => ({ id, name });

function schema(over: Partial<ArrQualityProfileSchema> = {}): ArrQualityProfileSchema {
  return {
    name: "",
    upgradeAllowed: true,
    cutoff: 0,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    items: [
      { quality: q(1, "SDTV"), items: [], allowed: false },
      {
        name: "HD",
        id: 1000,
        allowed: true,
        items: [
          { quality: q(3, "WEBDL-1080p"), items: [], allowed: true },
          { quality: q(4, "Bluray-1080p"), items: [], allowed: true },
        ],
      },
    ],
    formatItems: [
      { format: 10, name: "x265", score: 0 },
      { format: 11, name: "Repack", score: 0 },
      { format: 12, name: "Custom", score: 0 },
    ],
    language: { id: 1, name: "English" },
    ...over,
  };
}

function profile(over: Partial<TrashQualityProfile> = {}): TrashQualityProfile {
  return {
    trash_id: "p1",
    name: "HD Profile",
    cutoff: "WEBDL-1080p",
    items: [{ name: "WEBDL-1080p", allowed: true }],
    ...over,
  };
}

describe("custom format helpers", () => {
  it("handles missing, array and object spec fields", () => {
    expect(specFieldsToArray(undefined)).toEqual([]);
    expect(specFieldsToArray([{ name: "value", value: 5 }])).toEqual([{ name: "value", value: 5 }]);
    expect(specFieldsToArray({ value: "x" })).toEqual([{ name: "value", value: "x" }]);
  });

  it("defaults the renaming flag and spec flags, and only sets an id when given", () => {
    const cf = { trash_id: "t", name: "CF", specifications: [{ name: "s", implementation: "Release" }] } as TrashCustomFormat;
    const noId = trashCfToArr(cf);
    expect(noId).toEqual({
      name: "CF",
      includeCustomFormatWhenRenaming: false,
      specifications: [{ name: "s", implementation: "Release", negate: false, required: false, fields: [] }],
    });
    expect(noId).not.toHaveProperty("id");
    expect(trashCfToArr({ ...cf, specifications: undefined as unknown as [] }, 7)).toMatchObject({ id: 7, specifications: [] });
  });

  it("reduces specs to a comparable shape from either field form", () => {
    const cf = {
      name: "CF",
      specifications: [
        { name: "a", implementation: "X", negate: true, required: true, fields: [{ name: "value", value: 1 }, { value: 2 }, null] },
        { implementation: "Y", fields: { value: "v" } },
        { name: "c", fields: "junk" },
      ],
    } as unknown as ArrCustomFormat;
    expect(cfComparable(cf)).toEqual({
      name: "CF",
      includeCustomFormatWhenRenaming: false,
      specifications: {
        a: { implementation: "X", negate: true, required: true, fields: { value: 1 } },
        "": { implementation: "Y", negate: false, required: false, fields: { value: "v" } },
        c: { implementation: "", negate: false, required: false, fields: {} },
      },
    });
    expect(cfComparable({ name: "Empty" } as ArrCustomFormat).specifications).toEqual({});
  });

  it("projects app fields onto the guide's, keeping specs the guide lacks", () => {
    const before = cfComparable({
      name: "CF",
      specifications: [
        { name: "lang", implementation: "L", negate: false, required: false, fields: [{ name: "value", value: 1 }, { name: "exceptLanguage", value: false }] },
        { name: "extra", implementation: "E", negate: false, required: false, fields: [] },
      ],
    });
    const after = cfComparable({
      name: "CF",
      specifications: [{ name: "lang", implementation: "L", negate: false, required: false, fields: [{ name: "value", value: 2 }] }],
    });
    const projected = projectManagedFields(before, after);
    expect(projected.specifications.lang.fields).toEqual({ value: 1 });
    expect(projected.specifications.extra).toEqual(before.specifications.extra);
  });

  it("finds a managed resource by exact name, then loose name, then id", () => {
    const resources = [{ id: 1, name: "x265 (HD)" }, { id: 2, name: " Repack " }, { id: 3, name: "Old" }];
    expect(findManagedArrResource(resources, "x265 (HD)", 3)?.id).toBe(1);
    expect(findManagedArrResource(resources, "repack", null)?.id).toBe(2);
    expect(findManagedArrResource(resources, "Renamed", 3)?.id).toBe(3);
    expect(findManagedArrResource(resources, "Renamed", null)).toBeUndefined();
    expect(findManagedArrResource(resources, "Renamed", 99)).toBeUndefined();
  });
});

describe("quality sizes", () => {
  const def = (name: string, preferredSize?: number | null): ArrQualityDefinition => ({
    id: 1, quality: q(1, name), title: name, weight: 1, minSize: 1, maxSize: 2, preferredSize,
  });

  it("maps slider-top values to unlimited per app and keeps the existing preferred when the guide omits it", () => {
    const sonarr = applyQualitySizes(
      { trash_id: "s", type: "series", qualities: [{ quality: "HDTV-720p", min: 3, max: 1000, preferred: 995 }, { quality: "WEBDL-1080p", min: 4, max: 400 }] },
      [def("HDTV-720p"), def("WEBDL-1080p", 300), def("Unlisted")],
      "SONARR",
    );
    expect(sonarr[0]).toMatchObject({ minSize: 3, maxSize: null, preferredSize: null });
    expect(sonarr[1]).toMatchObject({ minSize: 4, maxSize: 400, preferredSize: 300 });
    expect(sonarr[2]).toEqual(def("Unlisted"));

    const radarr = applyQualitySizes(
      { trash_id: "r", type: "movie", qualities: [{ quality: "Bluray-1080p", min: 5, max: 1999 }] },
      [def("Bluray-1080p")],
      "RADARR",
    );
    expect(radarr[0]).toMatchObject({ maxSize: 1999, preferredSize: null });
  });

  it("builds a comparable map with null preferred sizes", () => {
    expect(qualityDefsComparable([def("A"), def("B", 7)])).toEqual({
      A: { min: 1, max: 2, preferred: null },
      B: { min: 1, max: 2, preferred: 7 },
    });
  });
});

describe("buildQualityProfile edge cases", () => {
  const catalog = new Map<string, TrashCustomFormat>([
    ["cf-x265", { trash_id: "cf-x265", name: "x265", specifications: [], trash_scores: { default: -100, sqp: -50 } }],
    ["cf-repack", { trash_id: "cf-repack", name: "Repack", specifications: [], trash_scores: { anime: 5 } }],
    ["cf-missing", { trash_id: "cf-missing", name: "Missing", specifications: [], trash_scores: { default: 10 } }],
    ["cf-zero", { trash_id: "cf-zero", name: "Zero", specifications: [] }],
  ]);

  it("warns about unknown qualities, drops empty groups and parks unmentioned qualities", () => {
    const { payload, warnings } = buildQualityProfile(
      profile({
        items: [
          { name: "Ghost Group", allowed: true, items: ["Nope"] },
          { name: "HDish", allowed: true, items: ["WEBDL-1080p", "Imaginary"] },
          { name: "Unknown-Single", allowed: true },
        ],
        cutoff: "HDish",
      }),
      schema(),
      "SONARR",
      catalog,
    );
    expect(warnings).toEqual([
      'Unknown quality "Nope" in group "Ghost Group" — skipped.',
      'Unknown quality "Imaginary" in group "HDish" — skipped.',
      'Unknown quality "Unknown-Single" — skipped.',
    ]);
    // Reversed: parked qualities come first, the guide group last.
    expect(payload.items.map((i) => i.name ?? i.quality?.name)).toEqual(["Bluray-1080p", "SDTV", "HDish"]);
    expect(payload.items.slice(0, 2).every((i) => !i.allowed)).toBe(true);
    expect(payload.cutoff).toBe(1000);
    expect(payload).not.toHaveProperty("language");
    expect(payload).not.toHaveProperty("id");
  });

  it("falls back to the highest allowed quality for an unknown cutoff, or the top quality when none is allowed", () => {
    const allowed = buildQualityProfile(profile({ cutoff: "Remux" }), schema(), "SONARR", catalog);
    expect(allowed.payload.cutoff).toBe(3);
    expect(allowed.warnings[0]).toMatch(/Cutoff "Remux" not found/);

    const groupAllowed = buildQualityProfile(
      profile({ cutoff: "Remux", items: [{ name: "Group", allowed: true, items: ["Bluray-1080p"] }] }),
      schema(),
      "SONARR",
      catalog,
    );
    expect(groupAllowed.payload.cutoff).toBe(1000);

    const noneAllowed = buildQualityProfile(
      profile({ cutoff: "Remux", items: [{ name: "WEBDL-1080p", allowed: false }] }),
      schema(),
      "SONARR",
      catalog,
    );
    expect(noneAllowed.payload.cutoff).toBe(3);

    const empty = buildQualityProfile(profile({ cutoff: "Remux", items: [] }), schema({ items: [] }), "SONARR", catalog);
    expect(empty.payload.cutoff).toBe(0);
  });

  it("applies score sets, catalog-name matches, missing formats, resets with exceptions and overrides", () => {
    const existing: ArrQualityProfile = {
      ...schema(),
      id: 42,
      name: "HD Profile",
      formatItems: [
        { format: 10, name: "x265", score: 1 },
        { format: 11, name: "Repack", score: 2 },
        { format: 12, name: "Custom", score: 3 },
      ],
    };
    const { payload, missingFormats, warnings } = buildQualityProfile(
      profile({
        trash_score_set: "anime",
        formatItems: { "x265 (HD)": "cf-x265", Repack: "cf-repack", Missing: "cf-missing", Zero: "cf-zero", Ghost: "unknown-id" },
      }),
      schema(),
      "SONARR",
      catalog,
      existing,
      undefined,
      { scoreSet: "sqp", resetUnmatchedScores: true, resetExcept: [], scoreOverrides: new Map([["custom", 77], ["x265", 9]]) },
    );
    const scores = Object.fromEntries(payload.formatItems.map((f) => [f.name, f.score]));
    // x265 matched via catalog name with the sqp set, then overridden; Repack has no
    // sqp/default score (0); Custom was reset then overridden.
    expect(scores).toEqual({ x265: 9, Repack: 0, Custom: 77 });
    expect(missingFormats).toEqual(["Missing"]);
    expect(warnings.some((w) => w.includes('"Missing" (score 10)'))).toBe(true);
    expect(payload.id).toBe(42);
  });

  it("keeps an excepted format's existing score during a reset", () => {
    const existing: ArrQualityProfile = { ...schema(), formatItems: [{ format: 12, name: "Custom", score: 30 }] };
    const { payload } = buildQualityProfile(profile(), schema(), "SONARR", catalog, existing, undefined, {
      resetUnmatchedScores: true,
      resetExcept: ["CUSTOM"],
    });
    expect(payload.formatItems.find((f) => f.name === "Custom")?.score).toBe(30);
    expect(payload.minUpgradeFormatScore).toBe(1);
    expect(payload.upgradeAllowed).toBe(true);
  });

  it("handles a schema with no format items", () => {
    const { payload } = buildQualityProfile(profile(), schema({ formatItems: undefined as unknown as [] }), "SONARR", catalog);
    expect(payload.formatItems).toEqual([]);
  });

  it("resolves Radarr languages: absent, any, original, named, and unresolvable", () => {
    const langs = [{ id: 2, name: "French" }];
    const lang = (language: string | undefined, existing?: ArrQualityProfile) =>
      buildQualityProfile(profile({ language }), schema(), "RADARR", catalog, existing, langs);

    expect(lang(undefined).payload.language).toEqual({ id: 1, name: "English" });
    expect(lang(undefined, { ...schema(), language: { id: 9, name: "German" } }).payload.language).toEqual({ id: 9, name: "German" });
    expect(lang("Any").payload.language).toEqual({ id: -1, name: "Any" });
    expect(lang("original").payload.language).toEqual({ id: -2, name: "Original" });
    expect(lang("french").payload.language).toEqual({ id: 2, name: "French" });
    const bad = lang("Klingon");
    expect(bad.payload.language).toEqual({ id: 1, name: "English" });
    expect(bad.warnings[0]).toMatch(/Language "Klingon" could not be resolved/);

    const noSchemaLang = buildQualityProfile(profile(), schema({ language: undefined }), "RADARR", catalog);
    expect(noSchemaLang.payload).not.toHaveProperty("language");
  });
});

describe("profileComparable", () => {
  it("names groups, members and cutoff, and only compares language on Radarr", () => {
    const p: ArrQualityProfile = {
      name: "P",
      upgradeAllowed: false,
      cutoff: 1000,
      minFormatScore: 0,
      cutoffFormatScore: 0,
      items: [
        { quality: q(1, "SDTV"), items: [], allowed: false },
        { name: "HD", id: 1000, allowed: true, items: [{ quality: q(3, "WEB"), items: [], allowed: true }, { name: "Nested", items: [], allowed: true }, { items: [], allowed: true }] },
        { items: [], allowed: true },
      ],
      formatItems: [{ format: 1, name: "a", score: 0 }, { format: 2, name: "b", score: 5 }],
      language: { id: 7, name: "" },
    };
    const sonarr = profileComparable(p, "SONARR");
    expect(sonarr).toEqual({
      name: "P",
      upgradeAllowed: false,
      cutoff: "HD",
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: null,
      qualities: [
        { name: "SDTV", allowed: false },
        { name: "HD", allowed: true, members: [{ name: "WEB" }, { name: "Nested" }, { name: "?" }] },
        { name: "?", allowed: true },
      ],
      formatScores: { b: 5 },
    });
    expect(profileComparable(p, "RADARR").language).toBe("");
    expect(profileComparable({ ...p, language: { id: 7 } as unknown as { id: number; name: string } }, "RADARR").language).toBe(7);
    expect(profileComparable({ ...p, language: undefined, cutoff: 555 }, "RADARR")).toMatchObject({ language: null, cutoff: "555" });
    expect(profileComparable({ ...p, items: undefined as unknown as [], formatItems: undefined as unknown as [] }, "SONARR")).toMatchObject({
      qualities: [],
      formatScores: {},
    });
  });
});

describe("naming", () => {
  const trash = {
    file: { standard: "{Movie Title}" },
    folder: { default: "{Movie Folder}" },
    series: { default: "{Series}" },
    season: { default: "Season {season}" },
    episodes: { standard: { default: "{Ep}" }, daily: { default: "{Daily}" }, anime: { default: "{Anime}" } },
  };
  const existing = { id: 1, standardMovieFormat: "old" };

  it("applies only selections the guide has, per app", () => {
    expect(applyNaming(trash, { file: "standard", folder: "default" }, existing, "RADARR")).toMatchObject({
      standardMovieFormat: "{Movie Title}",
      movieFolderFormat: "{Movie Folder}",
    });
    expect(applyNaming(trash, { file: "nope", folder: "nope" }, existing, "RADARR")).toEqual(existing);
    expect(applyNaming({}, { file: "standard", folder: "default" }, existing, "RADARR")).toEqual(existing);
    expect(
      applyNaming(trash, { series: "default", season: "default", standard: "default", daily: "default", anime: "default" }, { id: 1 }, "SONARR"),
    ).toEqual({
      id: 1,
      seriesFolderFormat: "{Series}",
      seasonFolderFormat: "Season {season}",
      standardEpisodeFormat: "{Ep}",
      dailyEpisodeFormat: "{Daily}",
      animeEpisodeFormat: "{Anime}",
    });
    expect(applyNaming({}, { series: "x", season: "x", standard: "x", daily: "x", anime: "x" }, { id: 1 }, "SONARR")).toEqual({ id: 1 });
    expect(applyNaming(trash, {}, { id: 1 }, "SONARR")).toEqual({ id: 1 });
  });

  it("compares only each app's own naming fields", () => {
    expect(namingComparable({ id: 1 }, "RADARR")).toEqual({ standardMovieFormat: null, movieFolderFormat: null });
    expect(namingComparable({ id: 1, dailyEpisodeFormat: "d" }, "SONARR")).toEqual({
      standardEpisodeFormat: null,
      dailyEpisodeFormat: "d",
      animeEpisodeFormat: null,
      seriesFolderFormat: null,
      seasonFolderFormat: null,
    });
  });
});
