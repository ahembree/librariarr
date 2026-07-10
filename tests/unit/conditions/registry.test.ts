import { describe, it, expect } from "vitest";
import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CONDITION_SECTIONS,
  STREAM_QUERY_FIELDS,
  STREAM_QUERY_SECTIONS,
  ARR_FIELDS,
  SEERR_FIELDS,
  SERIES_AGGREGATE_FIELDS,
  STREAM_FIELDS,
  CROSS_SYSTEM_FIELDS,
  isArrField,
  isSeerrField,
  isSeriesAggregateField,
  isEnumerableField,
} from "@/lib/conditions";
import { isOperatorVisible } from "@/lib/conditions/helpers";

describe("CONDITION_FIELDS registry", () => {
  it("has no duplicate field values", () => {
    const values = CONDITION_FIELDS.map((f) => f.value);
    const seen = new Set<string>();
    for (const v of values) {
      expect(seen.has(v)).toBe(false);
      seen.add(v);
    }
  });

  it("every field's section is registered in CONDITION_SECTIONS", () => {
    const sectionKeys = new Set(CONDITION_SECTIONS.map((s) => s.key));
    for (const f of CONDITION_FIELDS) {
      expect(sectionKeys.has(f.section)).toBe(true);
    }
  });

  it("requiresArr is set on all and only Arr-section fields", () => {
    for (const f of CONDITION_FIELDS) {
      const isArrSection = f.section.startsWith("arr");
      expect(!!f.requiresArr).toBe(isArrSection);
    }
  });

  it("requiresSeerr is set on all and only Seerr-section fields", () => {
    for (const f of CONDITION_FIELDS) {
      const isSeerrSection = f.section === "seerr";
      expect(!!f.requiresSeerr).toBe(isSeerrSection);
    }
  });

  it("isSeriesAggregate is set on all and only series-section fields", () => {
    for (const f of CONDITION_FIELDS) {
      const isSeriesSection = f.section === "series";
      expect(!!f.isSeriesAggregate).toBe(isSeriesSection);
    }
  });

  // Guards against the "ungated but type-specific" bug class: an Arr field that
  // the fetchers only populate for some media types must be marked invalid for
  // the others, otherwise it renders as an accepted rule that silently matches
  // nothing (and, for enumerable fields, as a non-functional raw text input).
  // The expected gating mirrors which types fetch-arr-metadata / fetch-arr-data
  // actually populate the underlying ArrDataMap value for.
  it("gates Arr fields to only the library types whose data populates them", () => {
    const expectedGates: Record<string, Array<"MOVIE" | "SERIES" | "MUSIC">> = {
      // Movie + Series (not Music)
      arrOriginalLanguage: ["MUSIC"],
      // Movie only
      // Sonarr/Lidarr expose only a single flat rating (mapped to arrRating);
      // there is no per-source TMDB or Rotten Tomatoes rating for series/music.
      arrTmdbRating: ["SERIES", "MUSIC"],
      arrRtCriticRating: ["SERIES", "MUSIC"],
      arrReleaseDate: ["SERIES", "MUSIC"],
      arrInCinemasDate: ["SERIES", "MUSIC"],
      arrRuntime: ["SERIES", "MUSIC"],
      arrQualityName: ["SERIES", "MUSIC"],
      arrQualityCutoffMet: ["SERIES", "MUSIC"],
      arrCustomFormatScore: ["SERIES", "MUSIC"],
      arrDownloadDate: ["SERIES", "MUSIC"],
      // Series only
      arrFirstAired: ["MOVIE", "MUSIC"],
      arrSeasonCount: ["MOVIE", "MUSIC"],
      arrEpisodeCount: ["MOVIE", "MUSIC"],
      arrEnded: ["MOVIE", "MUSIC"],
      arrSeriesType: ["MOVIE", "MUSIC"],
      arrHasUnaired: ["MOVIE", "MUSIC"],
      arrMonitoredSeasonCount: ["MOVIE", "MUSIC"],
      arrMonitoredEpisodeCount: ["MOVIE", "MUSIC"],
    };
    for (const [value, gate] of Object.entries(expectedGates)) {
      const field = CONDITION_FIELDS.find((f) => f.value === value);
      expect(field, `${value} should exist in the registry`).toBeDefined();
      expect(
        [...(field!.invalidForLibraryType ?? [])].sort(),
        `${value} gating`,
      ).toEqual([...gate].sort());
    }
  });

  // Seerr manages movie/TV requests only — no Seerr data is ever fetched for
  // MUSIC, so every Seerr field must be gated off music rule sets. An ungated
  // Seerr field on a music rule evaluates against the default "never
  // requested" record: "seerrRequested = false" would vacuously match every
  // artist (a match-all hazard for the deletion pipeline).
  it("gates every Seerr field off MUSIC", () => {
    const seerrFields = CONDITION_FIELDS.filter((f) => f.section === "seerr");
    expect(seerrFields.length).toBeGreaterThan(0);
    for (const field of seerrFields) {
      expect(
        field.invalidForLibraryType ?? [],
        `${field.value} must be invalid for MUSIC`,
      ).toContain("MUSIC");
    }
  });

  // The complement: Arr fields populated for every media type must stay
  // ungated, so they remain usable in all rule/query builders.
  it("leaves all-type Arr fields ungated", () => {
    const allTypeArrFields = [
      "foundInArr", "arrMonitored", "arrTag", "arrQualityProfile", "arrStatus",
      "arrRating", "arrSizeOnDisk", "arrPath", "arrDateAdded",
    ];
    for (const value of allTypeArrFields) {
      const field = CONDITION_FIELDS.find((f) => f.value === value);
      expect(field, `${value} should exist in the registry`).toBeDefined();
      expect(
        field!.invalidForLibraryType,
        `${value} should not be gated`,
      ).toBeUndefined();
    }
  });

  it("includes labels and ratingCount (previously query-only)", () => {
    const values = CONDITION_FIELDS.map((f) => f.value);
    expect(values).toContain("labels");
    expect(values).toContain("ratingCount");
  });

  it("includes the series-aggregate fields (previously rules-only)", () => {
    const values = CONDITION_FIELDS.map((f) => f.value);
    expect(values).toContain("watchedEpisodeCount");
    expect(values).toContain("watchedEpisodePercentage");
    expect(values).toContain("availableEpisodeCount");
    expect(values).toContain("latestEpisodeViewDate");
    expect(values).toContain("lastEpisodeAddedAt");
    expect(values).toContain("lastEpisodeAiredAt");
    expect(values).toContain("seriesLastPlayedAt");
  });

  it("seriesLastPlayedAt is a series-aggregate date field excluded for MOVIE/MUSIC", () => {
    const field = CONDITION_FIELDS.find((f) => f.value === "seriesLastPlayedAt");
    expect(field).toBeDefined();
    expect(field!.type).toBe("date");
    expect(field!.isSeriesAggregate).toBe(true);
    expect(isSeriesAggregateField("seriesLastPlayedAt")).toBe(true);
    expect([...(field!.invalidForLibraryType ?? [])].sort()).toEqual(["MOVIE", "MUSIC"]);
  });
});

describe("Field-set predicates derive from registry", () => {
  it("ARR_FIELDS matches every field with requiresArr=true", () => {
    const expected = CONDITION_FIELDS.filter((f) => f.requiresArr).map((f) => f.value).sort();
    expect([...ARR_FIELDS].sort()).toEqual(expected);
  });

  it("SEERR_FIELDS matches every field with requiresSeerr=true", () => {
    const expected = CONDITION_FIELDS.filter((f) => f.requiresSeerr).map((f) => f.value).sort();
    expect([...SEERR_FIELDS].sort()).toEqual(expected);
  });

  it("SERIES_AGGREGATE_FIELDS matches every field with isSeriesAggregate=true", () => {
    const expected = CONDITION_FIELDS.filter((f) => f.isSeriesAggregate).map((f) => f.value).sort();
    expect([...SERIES_AGGREGATE_FIELDS].sort()).toEqual(expected);
  });

  it("CROSS_SYSTEM_FIELDS contains exactly the cross-system fields", () => {
    expect(CROSS_SYSTEM_FIELDS.has("serverCount")).toBe(true);
    expect(CROSS_SYSTEM_FIELDS.has("matchedByRuleSet")).toBe(true);
    expect(CROSS_SYSTEM_FIELDS.has("hasPendingAction")).toBe(true);
    expect(CROSS_SYSTEM_FIELDS.size).toBe(3);
  });

  it("STREAM_FIELDS contains the audio/subtitle stream relation fields", () => {
    const expected = ["audioLanguage", "subtitleLanguage", "streamAudioCodec", "audioStreamCount", "subtitleStreamCount"];
    expect([...STREAM_FIELDS].sort()).toEqual(expected.sort());
  });

  it("isArrField/isSeerrField/isSeriesAggregateField agree with the registry flags", () => {
    for (const f of CONDITION_FIELDS) {
      expect(isArrField(f.value)).toBe(!!f.requiresArr);
      expect(isSeerrField(f.value)).toBe(!!f.requiresSeerr);
      expect(isSeriesAggregateField(f.value)).toBe(!!f.isSeriesAggregate);
    }
  });

  it("isEnumerableField agrees with the registry flags for CONDITION_FIELDS and STREAM_QUERY_FIELDS", () => {
    for (const f of CONDITION_FIELDS) {
      expect(isEnumerableField(f.value)).toBe(!!f.enumerable);
    }
    for (const f of STREAM_QUERY_FIELDS) {
      expect(isEnumerableField(f.value)).toBe(!!f.enumerable);
    }
  });

  it("isEnumerableField returns false for unknown fields", () => {
    expect(isEnumerableField("nonExistentField")).toBe(false);
    expect(isEnumerableField("")).toBe(false);
  });
});

describe("CONDITION_OPERATORS", () => {
  it("uses symbolic labels for >= and <=", () => {
    const gte = CONDITION_OPERATORS.find((o) => o.value === "greaterThanOrEqual");
    const lte = CONDITION_OPERATORS.find((o) => o.value === "lessThanOrEqual");
    expect(gte?.label).toBe(">=");
    expect(lte?.label).toBe("<=");
  });

  it("every operator declares at least one applicable type", () => {
    for (const op of CONDITION_OPERATORS) {
      expect(op.types.length).toBeGreaterThan(0);
    }
  });

  it("number, text, date, and boolean each have at least one operator", () => {
    const has = (t: "number" | "text" | "date" | "boolean") =>
      CONDITION_OPERATORS.some((op) => op.types.includes(t));
    expect(has("number")).toBe(true);
    expect(has("text")).toBe(true);
    expect(has("date")).toBe(true);
    expect(has("boolean")).toBe(true);
  });
});

describe("STREAM_QUERY_FIELDS registry", () => {
  it("every stream-query field's section is in STREAM_QUERY_SECTIONS", () => {
    const sectionKeys = new Set(STREAM_QUERY_SECTIONS.map((s) => s.key));
    for (const f of STREAM_QUERY_FIELDS) {
      expect(sectionKeys.has(f.section)).toBe(true);
    }
  });

  it("has no duplicate field values", () => {
    const seen = new Set<string>();
    for (const f of STREAM_QUERY_FIELDS) {
      expect(seen.has(f.value)).toBe(false);
      seen.add(f.value);
    }
  });
});

describe("isOperatorVisible (UI operator filter)", () => {
  it("hides isNull / isNotNull on non-nullable non-String fields (playCount, isWatchlisted)", () => {
    // playCount: Int @default(0). The engine maps isNull → UNSATISFIABLE,
    // isNotNull → MATCH_ALL — technically correct but useless and misleading.
    expect(isOperatorVisible("isNull", "playCount")).toBe(false);
    expect(isOperatorVisible("isNotNull", "playCount")).toBe(false);
    expect(isOperatorVisible("isNull", "isWatchlisted")).toBe(false);
    expect(isOperatorVisible("isNotNull", "isWatchlisted")).toBe(false);
  });

  it("keeps isNull / isNotNull on non-nullable String fields (title) — engine substitutes empty string", () => {
    expect(isOperatorVisible("isNull", "title")).toBe(true);
    expect(isOperatorVisible("isNotNull", "title")).toBe(true);
  });

  it("keeps isNull / isNotNull on nullable fields (studio, lastPlayedAt, rating, etc.)", () => {
    for (const field of ["studio", "lastPlayedAt", "rating", "year", "audioCodec"]) {
      expect(isOperatorVisible("isNull", field), `${field} should keep isNull`).toBe(true);
      expect(isOperatorVisible("isNotNull", field), `${field} should keep isNotNull`).toBe(true);
    }
  });

  it("keeps positive operators on non-nullable fields (the fix only targets isNull/isNotNull)", () => {
    expect(isOperatorVisible("equals", "playCount")).toBe(true);
    expect(isOperatorVisible("greaterThan", "playCount")).toBe(true);
    expect(isOperatorVisible("notEquals", "playCount")).toBe(true);
  });

  it("returns false for unknown fields", () => {
    expect(isOperatorVisible("equals", "totally-bogus")).toBe(false);
    expect(isOperatorVisible("isNull", "totally-bogus")).toBe(false);
  });

  it("returns false for type-incompatible operator/field combos", () => {
    // greaterThan is numeric only — should be hidden for text fields.
    expect(isOperatorVisible("greaterThan", "studio")).toBe(false);
    // contains is text only — should be hidden for numeric fields.
    expect(isOperatorVisible("contains", "rating")).toBe(false);
  });
});
