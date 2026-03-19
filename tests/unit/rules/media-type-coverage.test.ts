import { describe, it, expect } from "vitest";
import { getMatchedCriteriaForItems } from "@/lib/rules/engine";
import type { ArrMetadata, ArrDataMap, SeerrMetadata, SeerrDataMap } from "@/lib/rules/engine";
import type { Rule, RuleGroup } from "@/lib/rules/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<Rule> & Pick<Rule, "field" | "operator" | "value">): Rule {
  return { id: "r1", condition: "AND", ...overrides };
}

function makeGroup(rules: Rule[], overrides?: Partial<RuleGroup>): RuleGroup {
  return { id: "g1", condition: "AND", rules, groups: [], ...overrides };
}

function makeArrMeta(overrides?: Partial<ArrMetadata>): ArrMetadata {
  return {
    arrId: 0, tags: [], qualityProfile: "", monitored: false,
    rating: null, tmdbRating: null, rtCriticRating: null,
    dateAdded: null, path: null, sizeOnDisk: null, originalLanguage: null,
    releaseDate: null, inCinemasDate: null, runtime: null,
    qualityName: null, qualityCutoffMet: null, downloadDate: null,
    firstAired: null, seasonCount: null, episodeCount: null,
    status: null, ended: null, seriesType: null, hasUnaired: null,
    monitoredSeasonCount: null, monitoredEpisodeCount: null,
    ...overrides,
  };
}

function makeSeerrMeta(overrides?: Partial<SeerrMetadata>): SeerrMetadata {
  return {
    requested: false, requestCount: 0, requestDate: null,
    requestedBy: [], approvalDate: null, declineDate: null,
    ...overrides,
  };
}

function matched(
  items: Array<Record<string, unknown>>,
  rules: RuleGroup[],
  type: "MOVIE" | "SERIES" | "MUSIC",
  arrData?: ArrDataMap,
  seerrData?: SeerrDataMap,
): Map<string, unknown[]> {
  return getMatchedCriteriaForItems(items, rules, type, arrData, seerrData);
}

// ---------------------------------------------------------------------------
// 1. Standard fields produce same results across MOVIE, SERIES, MUSIC
// ---------------------------------------------------------------------------

describe("Standard fields across media types", () => {
  const types: Array<"MOVIE" | "SERIES" | "MUSIC"> = ["MOVIE", "SERIES", "MUSIC"];

  const textItems = [
    { id: "1", title: "Inception" },
    { id: "2", title: "The Matrix" },
  ];

  for (const type of types) {
    it(`title equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "equals", value: "Inception" })])];
      const result = matched(textItems, rules, type);
      expect(result.get("1")!.length).toBeGreaterThan(0);
      expect(result.get("2")).toHaveLength(0);
    });

    it(`title matchesWildcard works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "title", operator: "matchesWildcard", value: "The *" })])];
      const result = matched(textItems, rules, type);
      expect(result.get("1")).toHaveLength(0);
      expect(result.get("2")!.length).toBeGreaterThan(0);
    });
  }

  const numericItems = [
    { id: "1", playCount: 10 },
    { id: "2", playCount: 0 },
  ];

  for (const type of types) {
    it(`playCount greaterThan works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "playCount", operator: "greaterThan", value: 5 })])];
      const result = matched(numericItems, rules, type);
      expect(result.get("1")!.length).toBeGreaterThan(0);
      expect(result.get("2")).toHaveLength(0);
    });
  }

  const dateItems = [
    { id: "1", lastPlayedAt: "2020-01-01T00:00:00Z" },
    { id: "2", lastPlayedAt: "2025-06-15T00:00:00Z" },
  ];

  for (const type of types) {
    it(`lastPlayedAt before works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastPlayedAt", operator: "before", value: "2022-01-01" })])];
      const result = matched(dateItems, rules, type);
      expect(result.get("1")!.length).toBeGreaterThan(0);
      expect(result.get("2")).toHaveLength(0);
    });
  }

  const genreItems = [
    { id: "1", genres: ["Action", "Sci-Fi"] },
    { id: "2", genres: ["Comedy"] },
  ];

  for (const type of types) {
    it(`genre equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "genre", operator: "equals", value: "Action" })])];
      const result = matched(genreItems, rules, type);
      expect(result.get("1")!.length).toBeGreaterThan(0);
      expect(result.get("2")).toHaveLength(0);
    });
  }

  const boolItems = [
    { id: "1", isWatchlisted: true },
    { id: "2", isWatchlisted: false },
  ];

  for (const type of types) {
    it(`isWatchlisted equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "isWatchlisted", operator: "equals", value: "true" })])];
      const result = matched(boolItems, rules, type);
      expect(result.get("1")!.length).toBeGreaterThan(0);
      expect(result.get("2")).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. External ID source per type
// ---------------------------------------------------------------------------

describe("Arr external ID source per type", () => {
  const arrMeta = makeArrMeta({ tags: ["keep"], monitored: true });

  it("MOVIE Arr lookup uses TMDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: "tmdb-100" }] }];
    const arrData: ArrDataMap = { "tmdb-100": arrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MOVIE", arrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("MOVIE Arr lookup does NOT use TVDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: "tvdb-100" }] }];
    const arrData: ArrDataMap = { "tvdb-100": arrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MOVIE", arrData).get("1")).toHaveLength(0);
  });

  it("SERIES Arr lookup uses TVDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: "tvdb-200" }] }];
    const arrData: ArrDataMap = { "tvdb-200": arrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "SERIES", arrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("SERIES Arr lookup does NOT use TMDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: "tmdb-200" }] }];
    const arrData: ArrDataMap = { "tmdb-200": arrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "SERIES", arrData).get("1")).toHaveLength(0);
  });

  it("MUSIC Arr lookup uses MUSICBRAINZ ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-300" }] }];
    const arrData: ArrDataMap = { "mb-300": arrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MUSIC", arrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("MUSIC Arr lookup does NOT use TMDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: "tmdb-300" }] }];
    const arrData: ArrDataMap = { "tmdb-300": arrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitored", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MUSIC", arrData).get("1")).toHaveLength(0);
  });
});

describe("Seerr external ID source per type", () => {
  const seerrMeta = makeSeerrMeta({ requested: true, requestCount: 1 });

  it("MOVIE Seerr lookup uses TMDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: "tmdb-100" }] }];
    const seerrData: SeerrDataMap = { "tmdb-100": seerrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MOVIE", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("MOVIE Seerr lookup does NOT use TVDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: "tvdb-100" }] }];
    const seerrData: SeerrDataMap = { "tvdb-100": seerrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MOVIE", undefined, seerrData).get("1")).toHaveLength(0);
  });

  it("SERIES Seerr lookup uses TVDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: "tvdb-200" }] }];
    const seerrData: SeerrDataMap = { "tvdb-200": seerrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("SERIES Seerr lookup does NOT use TMDB ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "TMDB", externalId: "tmdb-200" }] }];
    const seerrData: SeerrDataMap = { "tmdb-200": seerrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")).toHaveLength(0);
  });

  it("MUSIC Seerr lookup uses TVDB ID (not MUSICBRAINZ)", () => {
    const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: "tvdb-300" }] }];
    const seerrData: SeerrDataMap = { "tvdb-300": seerrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("MUSIC Seerr lookup does NOT use MUSICBRAINZ ID", () => {
    const items = [{ id: "1", externalIds: [{ source: "MUSICBRAINZ", externalId: "mb-300" }] }];
    const seerrData: SeerrDataMap = { "mb-300": seerrMeta };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Seerr cross-type evaluation
// ---------------------------------------------------------------------------

describe("Seerr fields with SERIES type", () => {
  const tvdbId = "tvdb-s1";
  const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: tvdbId }] }];

  it("seerrRequested equals true matches", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requested: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequested equals false matches when not requested", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requested: false }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "false" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestDate before matches", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestDate: "2024-01-15T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestDate", operator: "before", value: "2024-06-01" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestDate after matches", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestDate: "2024-08-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestDate", operator: "after", value: "2024-06-01" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestCount greaterThan matches", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestCount: 5 }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestCount", operator: "greaterThan", value: 3 })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestCount lessThan does not match", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestCount: 5 }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestCount", operator: "lessThan", value: 3 })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")).toHaveLength(0);
  });

  it("seerrRequestedBy contains matches", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestedBy: ["alice", "bob"] }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestedBy", operator: "contains", value: "alice" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestedBy notContains matches when user not present", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestedBy: ["alice"] }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestedBy", operator: "notContains", value: "charlie" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrApprovalDate equals matches same date", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ approvalDate: "2024-05-10T14:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrApprovalDate", operator: "equals", value: "2024-05-10" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrDeclineDate before matches", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ declineDate: "2024-02-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrDeclineDate", operator: "before", value: "2024-06-01" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequested returns false when no seerr data exists", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "SERIES", undefined, undefined).get("1")).toHaveLength(0);
  });

  it("seerrRequestDate returns false when date is null", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestDate: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestDate", operator: "before", value: "2024-06-01" })])];
    expect(matched(items, rules, "SERIES", undefined, seerrData).get("1")).toHaveLength(0);
  });
});

describe("Seerr fields with MUSIC type", () => {
  // Seerr uses TVDB for MUSIC (not MUSICBRAINZ) since Seerr doesn't handle music
  const tvdbId = "tvdb-m1";
  const items = [{ id: "1", externalIds: [{ source: "TVDB", externalId: tvdbId }] }];

  it("seerrRequested equals true matches via TVDB lookup", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requested: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestCount equals matches via TVDB lookup", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestCount: 3 }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestCount", operator: "equals", value: 3 })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestDate after matches via TVDB lookup", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestDate: "2024-09-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestDate", operator: "after", value: "2024-06-01" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrRequestedBy equals matches via TVDB lookup", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ requestedBy: ["dave"] }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequestedBy", operator: "equals", value: "dave" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrApprovalDate notEquals matches different date via TVDB", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ approvalDate: "2024-04-01T00:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrApprovalDate", operator: "notEquals", value: "2024-07-01" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("seerrDeclineDate equals matches same date via TVDB", () => {
    const seerrData: SeerrDataMap = { [tvdbId]: makeSeerrMeta({ declineDate: "2024-11-15T10:00:00Z" }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrDeclineDate", operator: "equals", value: "2024-11-15" })])];
    expect(matched(items, rules, "MUSIC", undefined, seerrData).get("1")!.length).toBeGreaterThan(0);
  });

  it("does not find data keyed by MUSICBRAINZ ID", () => {
    const mbId = "mb-999";
    const musicItems = [{ id: "1", externalIds: [{ source: "MUSICBRAINZ", externalId: mbId }] }];
    const seerrData: SeerrDataMap = { [mbId]: makeSeerrMeta({ requested: true }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(musicItems, rules, "MUSIC", undefined, seerrData).get("1")).toHaveLength(0);
  });

  it("returns false when no seerr data provided", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "seerrRequested", operator: "equals", value: "true" })])];
    expect(matched(items, rules, "MUSIC", undefined, undefined).get("1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Arr field type isolation
// ---------------------------------------------------------------------------

describe("Movie-only Arr fields return false for SERIES type", () => {
  const tvdbId = "tvdb-iso1";
  const seriesItems = [{ id: "s1", externalIds: [{ source: "TVDB", externalId: tvdbId }] }];

  it("arrInCinemasDate returns false for SERIES (null in Sonarr metadata)", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ inCinemasDate: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrInCinemasDate", operator: "before", value: "2025-01-01" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")).toHaveLength(0);
  });

  it("arrRuntime returns false for SERIES (null in Sonarr metadata)", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ runtime: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrRuntime", operator: "greaterThan", value: 90 })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")).toHaveLength(0);
  });

  it("arrDownloadDate returns false for SERIES (null in Sonarr metadata)", () => {
    const arrData: ArrDataMap = { [tvdbId]: makeArrMeta({ downloadDate: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrDownloadDate", operator: "before", value: "2025-01-01" })])];
    expect(matched(seriesItems, rules, "SERIES", arrData).get("s1")).toHaveLength(0);
  });

  it("arrInCinemasDate returns false for MUSIC (null in Lidarr metadata)", () => {
    const mbId = "mb-iso1";
    const musicItems = [{ id: "m1", externalIds: [{ source: "MUSICBRAINZ", externalId: mbId }] }];
    const arrData: ArrDataMap = { [mbId]: makeArrMeta({ inCinemasDate: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrInCinemasDate", operator: "after", value: "2020-01-01" })])];
    expect(matched(musicItems, rules, "MUSIC", arrData).get("m1")).toHaveLength(0);
  });
});

describe("Series-only Arr fields return false for MOVIE type", () => {
  const tmdbId = "tmdb-iso2";
  const movieItems = [{ id: "m1", externalIds: [{ source: "TMDB", externalId: tmdbId }] }];

  it("arrSeasonCount returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ seasonCount: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeasonCount", operator: "greaterThan", value: 1 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrEpisodeCount returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ episodeCount: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEpisodeCount", operator: "greaterThan", value: 10 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrStatus returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ status: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrStatus", operator: "equals", value: "continuing" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrEnded returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ ended: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrEnded", operator: "equals", value: "true" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrSeriesType returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ seriesType: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrSeriesType", operator: "equals", value: "standard" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrHasUnaired returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ hasUnaired: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrHasUnaired", operator: "equals", value: "true" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrFirstAired returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ firstAired: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrFirstAired", operator: "before", value: "2025-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrMonitoredSeasonCount returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitoredSeasonCount: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredSeasonCount", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });

  it("arrMonitoredEpisodeCount returns false for MOVIE (null in Radarr metadata)", () => {
    const arrData: ArrDataMap = { [tmdbId]: makeArrMeta({ monitoredEpisodeCount: null }) };
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "arrMonitoredEpisodeCount", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE", arrData).get("m1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Series aggregate field isolation
// ---------------------------------------------------------------------------

describe("Series aggregate fields return false for MOVIE type", () => {
  const movieItems = [
    { id: "m1", latestEpisodeViewDate: null, availableEpisodeCount: null, watchedEpisodeCount: null, watchedEpisodePercentage: null },
  ];

  it("latestEpisodeViewDate returns false for MOVIE", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "before", value: "2025-01-01" })])];
    expect(matched(movieItems, rules, "MOVIE").get("m1")).toHaveLength(0);
  });

  it("availableEpisodeCount returns false for MOVIE (null defaults to 0)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "availableEpisodeCount", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE").get("m1")).toHaveLength(0);
  });

  it("watchedEpisodeCount returns false for MOVIE (null defaults to 0)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodeCount", operator: "greaterThan", value: 0 })])];
    expect(matched(movieItems, rules, "MOVIE").get("m1")).toHaveLength(0);
  });

  it("watchedEpisodePercentage returns false for MOVIE (null defaults to 0)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "greaterThan", value: 50 })])];
    expect(matched(movieItems, rules, "MOVIE").get("m1")).toHaveLength(0);
  });

  it("lastEpisodeAddedAt returns false for MOVIE", () => {
    const movieNull = [{ id: "m1", lastEpisodeAddedAt: null }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAddedAt", operator: "before", value: "2025-01-01" })])];
    expect(matched(movieNull, rules, "MOVIE").get("m1")).toHaveLength(0);
  });

  it("lastEpisodeAiredAt returns false for MOVIE", () => {
    const movieNull = [{ id: "m1", lastEpisodeAiredAt: null }];
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "lastEpisodeAiredAt", operator: "before", value: "2025-01-01" })])];
    expect(matched(movieNull, rules, "MOVIE").get("m1")).toHaveLength(0);
  });
});

describe("Series aggregate fields return false for MUSIC type", () => {
  const musicItems = [
    { id: "a1", latestEpisodeViewDate: null, availableEpisodeCount: null, watchedEpisodeCount: null, watchedEpisodePercentage: null },
  ];

  it("latestEpisodeViewDate returns false for MUSIC", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "latestEpisodeViewDate", operator: "after", value: "2020-01-01" })])];
    expect(matched(musicItems, rules, "MUSIC").get("a1")).toHaveLength(0);
  });

  it("availableEpisodeCount returns false for MUSIC (null defaults to 0)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "availableEpisodeCount", operator: "greaterThan", value: 0 })])];
    expect(matched(musicItems, rules, "MUSIC").get("a1")).toHaveLength(0);
  });

  it("watchedEpisodePercentage returns false for MUSIC (null defaults to 0)", () => {
    const rules: RuleGroup[] = [makeGroup([makeRule({ field: "watchedEpisodePercentage", operator: "equals", value: 100 })])];
    expect(matched(musicItems, rules, "MUSIC").get("a1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Stream fields across types
// ---------------------------------------------------------------------------

describe("Stream fields are type-agnostic", () => {
  const streamItem = [
    {
      id: "1",
      streams: [
        { streamType: 2, language: "English", codec: "aac" },
        { streamType: 3, language: "Spanish", codec: "subrip" },
      ],
    },
  ];

  for (const type of ["MOVIE", "SERIES", "MUSIC"] as const) {
    it(`audioLanguage equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioLanguage", operator: "equals", value: "English" })])];
      expect(matched(streamItem, rules, type).get("1")!.length).toBeGreaterThan(0);
    });

    it(`subtitleLanguage equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleLanguage", operator: "equals", value: "Spanish" })])];
      expect(matched(streamItem, rules, type).get("1")!.length).toBeGreaterThan(0);
    });

    it(`audioStreamCount equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "audioStreamCount", operator: "equals", value: 1 })])];
      expect(matched(streamItem, rules, type).get("1")!.length).toBeGreaterThan(0);
    });

    it(`subtitleStreamCount equals works for ${type}`, () => {
      const rules: RuleGroup[] = [makeGroup([makeRule({ field: "subtitleStreamCount", operator: "equals", value: 1 })])];
      expect(matched(streamItem, rules, type).get("1")!.length).toBeGreaterThan(0);
    });
  }
});
