/**
 * Regression: the four NAME-LIST fields (`arrTag`, `seerrRequestedBy`,
 * `watchedByUser`, `matchedByRuleSet`) must all support the same operator set
 * in BOTH engines.
 *
 * `matchedByRuleSet` and `seerrRequestedBy` had no `matchesWildcard` /
 * `notMatchesWildcard` cases while their two siblings did. The builders offer
 * those operators on every text field, so such a rule fell through to the
 * evaluator's `default` and matched NOTHING — in both directions, silently:
 * "Requested By does not match *service-account*" returned an empty set rather
 * than nearly the whole library. `matchedByRuleSet`'s switch was duplicated
 * byte-for-byte in the two engines, so both carried the defect.
 *
 * The final test is the sweep that found it: no operator may agree with its own
 * complement on a populated item.
 */
import { describe, it, expect } from "vitest";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import { isOperatorApplicable, isOperatorVisible } from "@/lib/conditions/helpers";
import { evaluateAllRulesInMemory } from "@/lib/rules/lifecycle-engine";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import type { ConditionOperator } from "@/lib/conditions/types";

const ARR = {
  arrId: 1, tags: ["Keep", "4K-UHD"], qualityProfile: "HD-1080p", monitored: true,
  rating: 7.5, tmdbRating: 8, rtCriticRating: 90,
  dateAdded: "2024-01-01T00:00:00.000Z", path: "/data/a", sizeOnDisk: 1000,
  originalLanguage: "English", releaseDate: "2020-06-01T00:00:00.000Z",
  inCinemasDate: "2020-05-01T00:00:00.000Z", runtime: 120,
  qualityName: "Bluray-1080p", qualityCutoffMet: true, customFormatScore: 10,
  downloadDate: "2024-01-02T00:00:00.000Z", firstAired: "2020-06-01T00:00:00.000Z",
  seasonCount: 3, episodeCount: 30, status: "continuing", ended: false,
  seriesType: "standard", hasUnaired: false, monitoredSeasonCount: 3,
  monitoredEpisodeCount: 30,
} as never;

const SEERR = {
  requested: true, requestCount: 2, requestDate: "2024-02-01T00:00:00.000Z",
  requestedBy: ["Alice", "service-account"], approvalDate: "2024-02-02T00:00:00.000Z",
  declineDate: "2024-03-01T00:00:00.000Z",
} as never;

const ITEM: Record<string, unknown> = {
  id: "i1", title: "Alpha", parentTitle: "Alpha Show", albumTitle: "Alpha Album",
  year: 2020, contentRating: "PG-13", studio: "Acme",
  genres: ["Action"], labels: ["Fav"], countries: ["US"],
  playCount: 3, rating: 7.5, audienceRating: 80, ratingCount: 100,
  isWatchlisted: true, lastPlayedAt: "2025-01-01T00:00:00.000Z",
  addedAt: "2024-01-01T00:00:00.000Z", originallyAvailableAt: "2020-06-01T00:00:00.000Z",
  resolution: "1080", videoCodec: "hevc", videoProfile: "main10", dynamicRange: "HDR10",
  videoBitDepth: 10, videoBitrate: 8000, videoFrameRate: "24p", aspectRatio: "1.78",
  scanType: "progressive", audioCodec: "eac3", audioProfile: "Dolby Atmos",
  audioChannels: 6, audioSamplingRate: 48000, audioBitrate: 640,
  container: "mkv", fileSize: "5368709120", duration: 7200000, filePath: "/m/a.mkv",
  watchedByUsers: ["Alice"], watchHistory: [{ serverUsername: "Alice" }],
  externalIds: [{ source: "TMDB", externalId: "1" }],
  serverCount: 2, matchedRuleSets: ["Cleanup Rule", "Archive Old"], hasPendingAction: true,
  // Both stream types populated: the language fields are fail-closed on an item
  // with no known language of that type, so an audio-only fixture would make
  // `subtitleLanguage` look "dead" to the sweep below.
  streams: [
    { streamType: 2, language: "English", codec: "eac3" },
    { streamType: 3, language: "English", codec: "srt" },
  ],
  availableEpisodeCount: 10, watchedEpisodeCount: 5, watchedEpisodePercentage: 50,
  latestEpisodeViewDate: "2025-01-01T00:00:00.000Z",
  seriesLastPlayedAt: "2025-01-01T00:00:00.000Z",
  lastEpisodeAddedAt: "2024-01-01T00:00:00.000Z",
  lastEpisodeAiredAt: "2024-01-01T00:00:00.000Z",
};

const rule = (field: string, operator: string, value: string, negate?: boolean) =>
  [{
    id: "g", condition: "AND",
    rules: [{ id: "r", field, operator, value, condition: "AND", negate }],
    groups: [],
  }] as never;

/** Evaluate in both engines; they must agree, and the shared value is returned. */
function evalBoth(field: string, operator: string, value: string, negate?: boolean): boolean {
  const lifecycle = evaluateAllRulesInMemory(rule(field, operator, value, negate), ITEM, ARR, SEERR);
  const query = evaluateAllQueryRulesInMemory(rule(field, operator, value, negate), ITEM, ARR, SEERR);
  expect(query, `${field} ${operator} ${value}: engines disagree`).toBe(lifecycle);
  return lifecycle;
}

const NAME_LIST_CASES: Array<{ field: string; present: string; absent: string }> = [
  { field: "arrTag", present: "keep", absent: "drop" },
  { field: "seerrRequestedBy", present: "alice", absent: "nobody" },
  { field: "watchedByUser", present: "alice", absent: "nobody" },
  { field: "matchedByRuleSet", present: "cleanup rule", absent: "no such rule" },
];

describe("name-list fields share one operator set across both engines", () => {
  for (const { field, present, absent } of NAME_LIST_CASES) {
    describe(field, () => {
      it("supports matchesWildcard", () => {
        expect(evalBoth(field, "matchesWildcard", `*${present.slice(0, 4)}*`)).toBe(true);
        expect(evalBoth(field, "matchesWildcard", "*zzz-nothing*")).toBe(false);
      });

      it("supports notMatchesWildcard as the complement, not as match-nothing", () => {
        expect(evalBoth(field, "notMatchesWildcard", `*${present.slice(0, 4)}*`)).toBe(false);
        expect(evalBoth(field, "notMatchesWildcard", "*zzz-nothing*")).toBe(true);
      });

      it("matches wildcards case-insensitively on both sides", () => {
        expect(evalBoth(field, "matchesWildcard", `*${present.slice(0, 4).toUpperCase()}*`)).toBe(true);
      });

      it("keeps equals/contains as membership, not substring", () => {
        expect(evalBoth(field, "equals", present)).toBe(true);
        expect(evalBoth(field, "equals", absent)).toBe(false);
        expect(evalBoth(field, "contains", `${absent}|${present}`)).toBe(true);
        expect(evalBoth(field, "contains", present.slice(0, 3))).toBe(false);
      });

      it("reads isNull/isNotNull as list emptiness", () => {
        expect(evalBoth(field, "isNull", "")).toBe(false);
        expect(evalBoth(field, "isNotNull", "")).toBe(true);
      });
    });
  }
});

describe("no operator agrees with its own complement", () => {
  const PAIRS: Array<[string, string]> = [
    ["equals", "notEquals"],
    ["contains", "notContains"],
    ["matchesWildcard", "notMatchesWildcard"],
    ["isNull", "isNotNull"],
  ];

  it("holds for every field the builders offer, in both engines", () => {
    const dead: string[] = [];
    for (const f of CONDITION_FIELDS) {
      for (const [pos, neg] of PAIRS) {
        if (!isOperatorApplicable(pos as ConditionOperator, f.value)) continue;
        if (!isOperatorApplicable(neg as ConditionOperator, f.value)) continue;
        if (!isOperatorVisible(pos as ConditionOperator, f.value)) continue;
        if (!isOperatorVisible(neg as ConditionOperator, f.value)) continue;
        const value = pos === "isNull" ? ""
          : f.type === "number" ? "5"
          : f.type === "date" ? "2020-01-01"
          : f.type === "boolean" ? "true"
          : "zzz-no-match";
        const a = evalBoth(f.value, pos, value);
        const b = evalBoth(f.value, neg, value);
        // Both false means the rule is dead: it matches nothing whichever way
        // the user writes it, with no error surfaced.
        if (a === b) dead.push(`${f.value} (${f.type}): ${pos}=${a} ${neg}=${b}`);
      }
    }
    expect(dead).toEqual([]);
  });
});
