import { describe, it, expect } from "vitest";
import {
  specFieldsToArray,
  trashCfToArr,
  cfComparable,
  projectManagedFields,
  findArrCfByName,
  applyQualitySizes,
  qualityDefsComparable,
  buildQualityProfile,
  profileComparable,
  applyNaming,
  namingComparable,
} from "@/lib/trash/translate";
import { diffValues } from "@/lib/trash/diff";
import type {
  TrashCustomFormat,
  TrashQualityProfile,
  TrashQualitySize,
  TrashNaming,
  ArrCustomFormat,
  ArrQualityDefinition,
  ArrQualityProfileSchema,
} from "@/lib/trash/types";

describe("custom format translation", () => {
  const amzn: TrashCustomFormat = {
    trash_id: "b3b3",
    name: "AMZN",
    includeCustomFormatWhenRenaming: true,
    specifications: [
      { name: "Amazon", implementation: "ReleaseTitleSpecification", negate: false, required: true, fields: { value: "\\bamzn\\b" } },
      { name: "WEBDL", implementation: "SourceSpecification", negate: false, required: false, fields: { value: 7 } },
    ],
  };

  it("converts TRaSH field objects to the Arr array shape", () => {
    expect(specFieldsToArray({ value: "x" })).toEqual([{ name: "value", value: "x" }]);
    expect(specFieldsToArray({ min: 1, max: 2 })).toEqual([
      { name: "min", value: 1 },
      { name: "max", value: 2 },
    ]);
    expect(specFieldsToArray(undefined)).toEqual([]);
  });

  it("builds an Arr custom-format payload and preserves id when updating", () => {
    const created = trashCfToArr(amzn);
    expect(created.id).toBeUndefined();
    expect(created.includeCustomFormatWhenRenaming).toBe(true);
    expect(created.specifications[0].fields).toEqual([{ name: "value", value: "\\bamzn\\b" }]);

    const updated = trashCfToArr(amzn, 42);
    expect(updated.id).toBe(42);
  });

  it("produces an id-agnostic comparable that matches between guide and Arr shapes", () => {
    const fromGuide = trashCfToArr(amzn);
    // Simulate the Arr GET shape: fields is an array with extra metadata keys.
    const fromArr: ArrCustomFormat = {
      id: 99,
      name: "AMZN",
      includeCustomFormatWhenRenaming: true,
      specifications: [
        { name: "WEBDL", implementation: "SourceSpecification", negate: false, required: false, fields: [{ order: 0, name: "value", value: 7, label: "Source" }] as never },
        { name: "Amazon", implementation: "ReleaseTitleSpecification", negate: false, required: true, fields: [{ order: 0, name: "value", value: "\\bamzn\\b" }] as never },
      ],
    };
    expect(cfComparable(fromGuide)).toEqual(cfComparable(fromArr));
  });

  it("ignores app-supplied fields the guide doesn't manage (no perpetual diff)", () => {
    // A LanguageSpecification: the guide only sets `value`, but Sonarr/Radarr
    // round-trips it with an extra `exceptLanguage` default.
    const guideCf: TrashCustomFormat = {
      trash_id: "x",
      name: "Anime Dual Audio",
      specifications: [
        { name: "Japanese Language", implementation: "LanguageSpecification", negate: false, required: false, fields: { value: 8 } },
      ],
    };
    const payload = trashCfToArr(guideCf);
    const arr: ArrCustomFormat = {
      id: 5,
      name: "Anime Dual Audio",
      specifications: [
        {
          name: "Japanese Language",
          implementation: "LanguageSpecification",
          negate: false,
          required: false,
          fields: [{ name: "exceptLanguage", value: false }, { name: "value", value: 8 }] as never,
        },
      ],
    };
    const after = cfComparable(payload);
    const before = projectManagedFields(cfComparable(arr), after);
    // exceptLanguage is dropped from the comparison → no changes.
    expect(diffValues(before, after)).toEqual([]);
  });

  it("still detects a real field change after projection", () => {
    const guideCf: TrashCustomFormat = {
      trash_id: "x",
      name: "Lang",
      specifications: [
        { name: "Japanese Language", implementation: "LanguageSpecification", negate: false, required: false, fields: { value: 8 } },
      ],
    };
    const payload = trashCfToArr(guideCf);
    const arr: ArrCustomFormat = {
      id: 5,
      name: "Lang",
      specifications: [
        {
          name: "Japanese Language",
          implementation: "LanguageSpecification",
          negate: false,
          required: false,
          fields: [{ name: "value", value: 99 }, { name: "exceptLanguage", value: false }] as never,
        },
      ],
    };
    const after = cfComparable(payload);
    const before = projectManagedFields(cfComparable(arr), after);
    expect(diffValues(before, after).length).toBeGreaterThan(0);
  });

  it("finds an Arr custom format by name (case-insensitive fallback)", () => {
    const arr: ArrCustomFormat[] = [{ id: 1, name: "AMZN", specifications: [] }];
    expect(findArrCfByName(arr, "AMZN")?.id).toBe(1);
    expect(findArrCfByName(arr, "amzn")?.id).toBe(1);
    expect(findArrCfByName(arr, "Nope")).toBeUndefined();
  });
});

describe("quality definition translation", () => {
  const existing: ArrQualityDefinition[] = [
    { id: 1, quality: { id: 4, name: "HDTV-720p" }, title: "HDTV-720p", weight: 1, minSize: 2, maxSize: 100, preferredSize: 95 },
    { id: 2, quality: { id: 6, name: "Bluray-720p" }, title: "Bluray-720p", weight: 2, minSize: 4, maxSize: 100, preferredSize: 95 },
  ];
  const trash: TrashQualitySize = {
    trash_id: "qs",
    type: "series",
    qualities: [{ quality: "HDTV-720p", min: 10, preferred: 500, max: 1000 }],
  };

  it("patches only sizes for named qualities and preserves the rest", () => {
    const out = applyQualitySizes(trash, existing);
    expect(out[0]).toMatchObject({ minSize: 10, maxSize: 1000, preferredSize: 500, id: 1, weight: 1 });
    // Untouched quality keeps its values.
    expect(out[1]).toEqual(existing[1]);
  });

  it("summarizes definitions by quality name", () => {
    expect(qualityDefsComparable(existing)["Bluray-720p"]).toEqual({ min: 4, max: 100, preferred: 95 });
  });
});

describe("quality profile builder", () => {
  const schema: ArrQualityProfileSchema = {
    name: "",
    upgradeAllowed: true,
    cutoff: 0,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    language: { id: -1, name: "Any" },
    items: [
      { quality: { id: 1, name: "SDTV" }, items: [], allowed: false },
      { quality: { id: 4, name: "HDTV-720p" }, items: [], allowed: false },
      { quality: { id: 5, name: "WEBDL-720p" }, items: [], allowed: false },
      { quality: { id: 6, name: "Bluray-720p" }, items: [], allowed: false },
      { quality: { id: 3, name: "WEBDL-1080p" }, items: [], allowed: false },
      { quality: { id: 15, name: "WEBRip-1080p" }, items: [], allowed: false },
      { quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: false },
    ],
    formatItems: [
      { format: 101, name: "Tier 01", score: 0 },
      { format: 102, name: "Tier 02", score: 0 },
    ],
  };

  const trash: TrashQualityProfile = {
    trash_id: "p1",
    name: "HD Test",
    cutoff: "Bluray-1080p",
    upgradeAllowed: true,
    minFormatScore: 0,
    cutoffFormatScore: 10000,
    minUpgradeFormatScore: 1,
    items: [
      { name: "Bluray-1080p", allowed: true },
      { name: "WEB 1080p", allowed: true, items: ["WEBRip-1080p", "WEBDL-1080p"] },
      { name: "Bluray-720p", allowed: true },
      { name: "SDTV", allowed: false },
    ],
    formatItems: { "Tier 01": "cf-a" },
  };

  const cfMap = new Map<string, TrashCustomFormat>([
    ["cf-a", { trash_id: "cf-a", name: "Tier 01", trash_scores: { default: 100 }, specifications: [] }],
  ]);

  it("resolves qualities, groups, cutoff, ordering and format scores", () => {
    const { payload, warnings } = buildQualityProfile(trash, schema, "RADARR", cfMap);
    expect(warnings).toEqual([]);

    // Cutoff resolves to the Bluray-1080p quality id.
    expect(payload.cutoff).toBe(7);

    // Arr order is lowest→highest, so the last item is the highest-priority one.
    const last = payload.items[payload.items.length - 1];
    expect(last.quality?.name).toBe("Bluray-1080p");
    expect(last.allowed).toBe(true);

    // The "WEB 1080p" group is created with a generated id and two children.
    const group = payload.items.find((i) => i.name === "WEB 1080p");
    expect(group?.id).toBe(1000);
    expect(group?.items.map((c) => c.quality?.name).sort()).toEqual(["WEBDL-1080p", "WEBRip-1080p"]);
    expect(group?.allowed).toBe(true);

    // Unmentioned qualities are appended (lowest priority), disallowed.
    const hdtv = payload.items.find((i) => i.quality?.name === "HDTV-720p");
    expect(hdtv?.allowed).toBe(false);

    // Format score is pulled from the custom format's trash_scores.default.
    expect(payload.formatItems.find((f) => f.name === "Tier 01")?.score).toBe(100);
    expect(payload.formatItems.find((f) => f.name === "Tier 02")?.score).toBe(0);

    // Radarr profiles carry a language.
    expect(payload.language).toEqual({ id: -1, name: "Any" });
  });

  it("preserves custom-format scores the guide profile doesn't manage (Recyclarr default)", () => {
    // The instance schema lists every CF, including one the guide profile never
    // references ("My Custom CF").
    const schemaWithExtra = {
      ...schema,
      formatItems: [
        { format: 101, name: "Tier 01", score: 0 },
        { format: 102, name: "Tier 02", score: 0 },
        { format: 200, name: "My Custom CF", score: 0 },
      ],
    };
    const existingProfile = {
      id: 7,
      name: "HD Test",
      upgradeAllowed: true,
      cutoff: 7,
      items: [],
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: [
        { format: 101, name: "Tier 01", score: 999 },
        { format: 200, name: "My Custom CF", score: 500 },
      ],
    };
    const { payload } = buildQualityProfile(trash, schemaWithExtra, "RADARR", cfMap, existingProfile);
    // A guide-managed CF is set to the guide's score…
    expect(payload.formatItems.find((f) => f.name === "Tier 01")?.score).toBe(100);
    // …but a CF the guide doesn't manage keeps its existing score (not reset to 0).
    expect(payload.formatItems.find((f) => f.name === "My Custom CF")?.score).toBe(500);
    expect(payload.id).toBe(7);
  });

  // Fixtures shared by the reset-unmatched-scores tests.
  const schemaWithExtra = {
    ...schema,
    formatItems: [
      { format: 101, name: "Tier 01", score: 0 },
      { format: 102, name: "Tier 02", score: 0 },
      { format: 200, name: "My Custom CF", score: 0 },
      { format: 201, name: "Anime BD Tier", score: 0 },
    ],
  };
  const existingProfile = {
    id: 7,
    name: "HD Test",
    upgradeAllowed: true,
    cutoff: 7,
    items: [],
    minFormatScore: 0,
    cutoffFormatScore: 0,
    formatItems: [
      { format: 101, name: "Tier 01", score: 999 },
      { format: 102, name: "Tier 02", score: 42 },
      { format: 200, name: "My Custom CF", score: 500 },
      { format: 201, name: "Anime BD Tier", score: 77 },
    ],
  };

  it("resets unmatched scores to 0 when reset_unmatched_scores is on", () => {
    const { payload } = buildQualityProfile(trash, schemaWithExtra, "RADARR", cfMap, existingProfile, undefined, {
      resetUnmatchedScores: true,
    });
    // Guide-managed CF is still set to the guide's score.
    expect(payload.formatItems.find((f) => f.name === "Tier 01")?.score).toBe(100);
    // Every CF the guide profile doesn't manage is reset to 0.
    expect(payload.formatItems.find((f) => f.name === "Tier 02")?.score).toBe(0);
    expect(payload.formatItems.find((f) => f.name === "My Custom CF")?.score).toBe(0);
    expect(payload.formatItems.find((f) => f.name === "Anime BD Tier")?.score).toBe(0);
  });

  it("keeps excepted formats (exact names, case-insensitive) during a reset", () => {
    const { payload } = buildQualityProfile(trash, schemaWithExtra, "RADARR", cfMap, existingProfile, undefined, {
      resetUnmatchedScores: true,
      resetExcept: ["my custom cf"],
    });
    // Excepted CF keeps its existing score; the other unmatched one is reset.
    expect(payload.formatItems.find((f) => f.name === "My Custom CF")?.score).toBe(500);
    expect(payload.formatItems.find((f) => f.name === "Tier 02")?.score).toBe(0);
  });

  it("keeps formats matching an except regex pattern during a reset", () => {
    const { payload } = buildQualityProfile(trash, schemaWithExtra, "RADARR", cfMap, existingProfile, undefined, {
      resetUnmatchedScores: true,
      resetExceptPatterns: ["^anime"],
    });
    // Pattern (case-insensitive) matches "Anime BD Tier" → preserved.
    expect(payload.formatItems.find((f) => f.name === "Anime BD Tier")?.score).toBe(77);
    // A non-matching unmatched CF is still reset.
    expect(payload.formatItems.find((f) => f.name === "My Custom CF")?.score).toBe(0);
  });

  it("ignores an invalid except regex without throwing", () => {
    const { payload } = buildQualityProfile(trash, schemaWithExtra, "RADARR", cfMap, existingProfile, undefined, {
      resetUnmatchedScores: true,
      resetExceptPatterns: ["("], // invalid regex
    });
    // Invalid pattern is dropped; the reset proceeds normally.
    expect(payload.formatItems.find((f) => f.name === "My Custom CF")?.score).toBe(0);
  });

  it("options.scoreSet overrides the guide's declared score set", () => {
    const t: TrashQualityProfile = {
      ...trash,
      trash_score_set: "default",
      formatItems: { "Tier 01": "cf-a" },
    };
    const map = new Map<string, TrashCustomFormat>([
      ["cf-a", { trash_id: "cf-a", name: "Tier 01", trash_scores: { default: 100, "sqp-1-2160p": -50 }, specifications: [] }],
    ]);
    const { payload } = buildQualityProfile(t, schema, "RADARR", map, undefined, undefined, {
      scoreSet: "sqp-1-2160p",
    });
    // The override wins over the profile's own trash_score_set.
    expect(payload.formatItems.find((f) => f.name === "Tier 01")?.score).toBe(-50);
  });

  it("warns when a referenced custom format is not present in the instance", () => {
    const t: TrashQualityProfile = { ...trash, formatItems: { "Ghost CF": "cf-x" } };
    const map = new Map<string, TrashCustomFormat>([
      ["cf-x", { trash_id: "cf-x", name: "Ghost CF", trash_scores: { default: 50 }, specifications: [] }],
    ]);
    const { warnings } = buildQualityProfile(t, schema, "RADARR", map);
    expect(warnings.some((w) => w.includes("Ghost CF"))).toBe(true);
  });

  it("warns and falls back when the cutoff is unknown", () => {
    const t: TrashQualityProfile = { ...trash, cutoff: "Nonexistent" };
    const { payload, warnings } = buildQualityProfile(t, schema, "RADARR", cfMap);
    expect(warnings.some((w) => w.includes("Cutoff"))).toBe(true);
    // Falls back to the highest allowed quality (Bluray-1080p).
    expect(payload.cutoff).toBe(7);
  });

  it("comparable reflects allowed set, cutoff name and non-zero scores", () => {
    const { payload } = buildQualityProfile(trash, schema, "RADARR", cfMap);
    const comp = profileComparable(payload, "RADARR");
    expect(comp.cutoff).toBe("Bluray-1080p");
    expect(comp.formatScores).toEqual({ "Tier 01": 100 });
    expect(comp.qualities.find((q) => q.name === "Bluray-720p")?.allowed).toBe(true);
  });

  it("honors the profile's declared score set (not just default)", () => {
    // A profile with a named score set must pull each CF's score from that set,
    // falling back to default only when the set key is absent.
    const t: TrashQualityProfile = { ...trash, trash_score_set: "anime-radarr", formatItems: { "Tier 01": "cf-a", "Tier 02": "cf-b" } };
    const map = new Map<string, TrashCustomFormat>([
      // Has the named set → use it (975, not the default 1950).
      ["cf-a", { trash_id: "cf-a", name: "Tier 01", trash_scores: { default: 1950, "anime-radarr": 975 }, specifications: [] }],
      // Score-set-only format (no default) → the set value, not 0.
      ["cf-b", { trash_id: "cf-b", name: "Tier 02", trash_scores: { "anime-radarr": -10000 }, specifications: [] }],
    ]);
    // schema.formatItems must list both CFs so scores can be applied.
    const sch = { ...schema, formatItems: [{ format: 101, name: "Tier 01", score: 0 }, { format: 102, name: "Tier 02", score: 0 }] };
    const { payload } = buildQualityProfile(t, sch, "RADARR", map);
    expect(payload.formatItems.find((f) => f.name === "Tier 01")?.score).toBe(975);
    expect(payload.formatItems.find((f) => f.name === "Tier 02")?.score).toBe(-10000);
  });

  it("resolves a named language against the instance language list", () => {
    const langs = [
      { id: -1, name: "Any" },
      { id: 8, name: "French" },
    ];
    const t: TrashQualityProfile = { ...trash, language: "French" };
    const { payload, warnings } = buildQualityProfile(t, schema, "RADARR", cfMap, undefined, langs);
    expect(payload.language).toEqual({ id: 8, name: "French" });
    expect(warnings).toEqual([]);
  });

  it("warns (does not silently substitute) when a named language can't be resolved", () => {
    const t: TrashQualityProfile = { ...trash, language: "French" };
    const { warnings } = buildQualityProfile(t, schema, "RADARR", cfMap, undefined, []);
    expect(warnings.some((w) => w.includes("French"))).toBe(true);
  });

  it("includes language in the Radarr comparable so a language change is a real diff", () => {
    const base = {
      name: "P",
      upgradeAllowed: true,
      cutoff: 0,
      items: [],
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: [],
    };
    const before = profileComparable({ ...base, language: { id: -1, name: "Any" } }, "RADARR");
    const after = profileComparable({ ...base, language: { id: 8, name: "French" } }, "RADARR");
    expect((before as { language?: unknown }).language).toBe("Any");
    expect((after as { language?: unknown }).language).toBe("French");
    // Sonarr comparable omits language entirely (never set on the payload).
    const sonarr = profileComparable({ ...base, language: { id: 1, name: "x" } }, "SONARR");
    expect(sonarr).not.toHaveProperty("language");
  });
});

describe("naming translation", () => {
  const radarrNaming: TrashNaming = {
    folder: { default: "{Movie CleanTitle}" },
    file: { standard: "{Movie CleanTitle} {Quality Full}" },
  };
  const sonarrNaming: TrashNaming = {
    series: { default: "{Series Title}" },
    season: { default: "Season {season:00}" },
    episodes: { standard: { default: "{Series} - S{season:00}E{episode:00}" } },
  };

  it("applies the chosen Radarr variants onto the existing config", () => {
    const out = applyNaming(radarrNaming, { file: "standard", folder: "default" }, { id: 1, standardMovieFormat: "old" }, "RADARR");
    expect(out.standardMovieFormat).toBe("{Movie CleanTitle} {Quality Full}");
    expect(out.movieFolderFormat).toBe("{Movie CleanTitle}");
    expect(out.id).toBe(1);
  });

  it("applies the chosen Sonarr variants", () => {
    const out = applyNaming(sonarrNaming, { series: "default", season: "default", standard: "default" }, { id: 2 }, "SONARR");
    expect(out.seriesFolderFormat).toBe("{Series Title}");
    expect(out.seasonFolderFormat).toBe("Season {season:00}");
    expect(out.standardEpisodeFormat).toBe("{Series} - S{season:00}E{episode:00}");
  });

  it("only surfaces the service-relevant fields in the comparable", () => {
    expect(namingComparable({ id: 1, standardMovieFormat: "a", movieFolderFormat: "b" }, "RADARR")).toEqual({
      standardMovieFormat: "a",
      movieFolderFormat: "b",
    });
    const sonarr = namingComparable({ id: 1, standardEpisodeFormat: "e" }, "SONARR");
    expect(sonarr).toHaveProperty("seriesFolderFormat");
    expect(sonarr).not.toHaveProperty("standardMovieFormat");
  });
});
