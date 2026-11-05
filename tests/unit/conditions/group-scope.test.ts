/**
 * Criteria a series- or artist-scoped rule set may not use
 * (`src/lib/conditions/group-scope.ts`).
 *
 * With "Match against entire series" / "Match against entire artist" on, a
 * rule judges a whole show or artist and its action covers all of it, so a
 * criterion whose value belongs to one file or one episode/track would let
 * one member decide for the whole group. The classification below pins every
 * condition field, so a new field has to be placed deliberately.
 */
import { describe, it, expect } from "vitest";
import { CONDITION_FIELDS, STREAM_QUERY_FIELDS } from "@/lib/conditions";
import {
  GROUP_SCOPE_BLOCKED_FIELDS,
  findGroupScopeBlockedCriteria,
  groupScopeBlockedLabels,
  groupScopeHoldReason,
  groupScopeSaveError,
  groupScopeViolation,
  isBlockedAtGroupScope,
  isGroupScope,
} from "@/lib/conditions/group-scope";

type Placement = "blocked" | "allowed";

/** Every condition field, placed. A field missing here fails the first test. */
const CLASSIFICATION: Record<string, Placement> = {
  // Content
  title: "allowed",
  parentTitle: "allowed",
  albumTitle: "blocked",
  year: "blocked",
  contentRating: "allowed",
  studio: "allowed",
  genre: "allowed",
  labels: "allowed",
  country: "allowed",
  // Activity
  playCount: "allowed",
  watchedByUser: "allowed",
  rating: "blocked",
  audienceRating: "blocked",
  ratingCount: "blocked",
  isWatchlisted: "allowed",
  lastPlayedAt: "allowed",
  addedAt: "allowed",
  originallyAvailableAt: "blocked",
  // Video
  resolution: "blocked",
  videoCodec: "blocked",
  videoProfile: "blocked",
  dynamicRange: "blocked",
  videoBitDepth: "blocked",
  videoBitrate: "blocked",
  videoFrameRate: "blocked",
  aspectRatio: "blocked",
  scanType: "blocked",
  // Audio
  audioCodec: "blocked",
  audioProfile: "blocked",
  audioChannels: "blocked",
  audioSamplingRate: "blocked",
  audioBitrate: "blocked",
  // Streams
  audioLanguage: "blocked",
  subtitleLanguage: "blocked",
  streamAudioCodec: "blocked",
  audioStreamCount: "blocked",
  subtitleStreamCount: "blocked",
  // File
  fileSize: "allowed",
  container: "blocked",
  duration: "blocked",
  // Cross-system
  serverCount: "allowed",
  matchedByRuleSet: "allowed",
  hasPendingAction: "allowed",
  // External ids
  hasExternalId: "allowed",
  // Arr: status
  foundInArr: "allowed",
  arrMonitored: "allowed",
  arrTag: "allowed",
  arrQualityProfile: "allowed",
  arrQualityName: "allowed",
  arrQualityCutoffMet: "allowed",
  arrCustomFormatScore: "allowed",
  arrStatus: "allowed",
  arrEnded: "allowed",
  arrSeriesType: "allowed",
  // Arr: media — the release and air dates describe the series, unlike the
  // item's own Release Date.
  arrRating: "allowed",
  arrTmdbRating: "allowed",
  arrRtCriticRating: "allowed",
  arrOriginalLanguage: "allowed",
  arrRuntime: "allowed",
  arrSizeOnDisk: "allowed",
  arrPath: "allowed",
  arrReleaseDate: "allowed",
  arrInCinemasDate: "allowed",
  arrFirstAired: "allowed",
  arrDateAdded: "allowed",
  arrDownloadDate: "allowed",
  // Arr: episodes
  arrSeasonCount: "allowed",
  arrEpisodeCount: "allowed",
  arrHasUnaired: "allowed",
  arrMonitoredSeasonCount: "allowed",
  arrMonitoredEpisodeCount: "allowed",
  // Seerr
  seerrRequested: "allowed",
  seerrRequestDate: "allowed",
  seerrRequestCount: "allowed",
  seerrRequestedBy: "allowed",
  seerrApprovalDate: "allowed",
  seerrDeclineDate: "allowed",
  // Series aggregates
  latestEpisodeViewDate: "allowed",
  seriesLastPlayedAt: "allowed",
  availableEpisodeCount: "allowed",
  watchedEpisodeCount: "allowed",
  watchedEpisodePercentage: "allowed",
  lastEpisodeAddedAt: "allowed",
  lastEpisodeAiredAt: "allowed",
};

function rule(field: string, extra: Record<string, unknown> = {}) {
  return { id: `r-${field}`, field, operator: "equals", value: "x", condition: "AND", ...extra };
}

function group(rules: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "g", condition: "AND", rules, groups: [], ...extra };
}

describe("the group-scope field classification", () => {
  it("places every condition field, and nothing else", () => {
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(CONDITION_FIELDS.map((f) => f.value).sort());
  });

  it.each(Object.entries(CLASSIFICATION))("%s is %s at series and artist scope", (field, placement) => {
    expect(isBlockedAtGroupScope(field)).toBe(placement === "blocked");
  });

  it("blocks exactly the classified fields", () => {
    const blocked = Object.entries(CLASSIFICATION).filter(([, p]) => p === "blocked").map(([f]) => f);
    expect([...GROUP_SCOPE_BLOCKED_FIELDS].sort()).toEqual(blocked.sort());
  });

  it("blocks every stream-query field: one stream's property", () => {
    for (const f of STREAM_QUERY_FIELDS) expect(isBlockedAtGroupScope(f.value), f.value).toBe(true);
  });
});

describe("isGroupScope", () => {
  it("is on only for a Series or Music rule set with its scope on", () => {
    expect(isGroupScope("SERIES", true)).toBe(true);
    expect(isGroupScope("MUSIC", true)).toBe(true);
    expect(isGroupScope("SERIES", false)).toBe(false);
    expect(isGroupScope("MUSIC", false)).toBe(false);
    // Movies have no scope: the column's default changes nothing for them.
    expect(isGroupScope("MOVIE", true)).toBe(false);
  });
});

describe("findGroupScopeBlockedCriteria", () => {
  it("finds a blocked field in a nested group", () => {
    const rules = [group([rule("title")], { groups: [group([rule("playCount")], { groups: [group([rule("resolution")])] })] })];
    expect(findGroupScopeBlockedCriteria(rules)).toEqual({ fields: ["resolution"], streamQuery: false });
  });

  it("finds a disabled rule, and a rule in a disabled group", () => {
    expect(findGroupScopeBlockedCriteria([group([rule("title"), rule("year", { enabled: false })])])).toEqual({
      fields: ["year"],
      streamQuery: false,
    });
    expect(findGroupScopeBlockedCriteria([group([rule("title")], { groups: [group([rule("audioCodec")], { enabled: false })] })])).toEqual({
      fields: ["audioCodec"],
      streamQuery: false,
    });
  });

  it("finds a stream query group, even an empty or disabled one", () => {
    const sq = (extra: Record<string, unknown> = {}) =>
      group([rule("sqLanguage")], { streamQuery: { streamType: "audio", quantifier: "any" }, ...extra });
    expect(findGroupScopeBlockedCriteria([group([rule("title")], { groups: [sq()] })])).toEqual({ fields: [], streamQuery: true });
    expect(findGroupScopeBlockedCriteria([group([rule("title")], { groups: [sq({ enabled: false })] })])).toEqual({ fields: [], streamQuery: true });
    expect(findGroupScopeBlockedCriteria([group([], { streamQuery: { streamType: "video" } })])).toEqual({ fields: [], streamQuery: true });
  });

  it("reads a legacy flat rule list", () => {
    expect(findGroupScopeBlockedCriteria([rule("playCount"), rule("dynamicRange")])).toEqual({ fields: ["dynamicRange"], streamQuery: false });
  });

  it("lists each blocked field once, in tree order", () => {
    const rules = [group([rule("year"), rule("resolution"), rule("year")], { groups: [group([rule("resolution"), rule("container")])] })];
    expect(findGroupScopeBlockedCriteria(rules)?.fields).toEqual(["year", "resolution", "container"]);
  });

  it("finds nothing in rules using only allowed fields", () => {
    const rules = [group(
      ["title", "parentTitle", "genre", "studio", "contentRating", "labels", "isWatchlisted", "playCount", "lastPlayedAt",
        "addedAt", "fileSize", "watchedByUser", "serverCount", "matchedByRuleSet", "hasPendingAction", "hasExternalId",
        "arrEnded", "arrFirstAired", "seerrRequested", "watchedEpisodePercentage", "seriesLastPlayedAt"].map((f) => rule(f)),
    )];
    expect(findGroupScopeBlockedCriteria(rules)).toBeNull();
    expect(findGroupScopeBlockedCriteria([])).toBeNull();
    expect(findGroupScopeBlockedCriteria(undefined)).toBeNull();
  });
});

describe("groupScopeViolation", () => {
  const blocked = [group([rule("playCount"), rule("resolution")], { groups: [group([], { streamQuery: { streamType: "audio" } })] })];

  it("refuses a series-scoped or artist-scoped rule set holding blocked criteria", () => {
    expect(groupScopeViolation("SERIES", true, blocked)).toEqual({ type: "SERIES", fields: ["resolution"], streamQuery: true });
    expect(groupScopeViolation("MUSIC", true, blocked)).toEqual({ type: "MUSIC", fields: ["resolution"], streamQuery: true });
  });

  it("allows the same rules with the scope off, and on a movie rule set", () => {
    expect(groupScopeViolation("SERIES", false, blocked)).toBeNull();
    expect(groupScopeViolation("MUSIC", false, blocked)).toBeNull();
    expect(groupScopeViolation("MOVIE", true, blocked)).toBeNull();
    expect(groupScopeViolation("MOVIE", false, blocked)).toBeNull();
  });

  it("allows allowed criteria with the scope on", () => {
    expect(groupScopeViolation("SERIES", true, [group([rule("genre"), rule("arrEnded"), rule("availableEpisodeCount")])])).toBeNull();
    expect(groupScopeViolation("MUSIC", true, [group([rule("playCount"), rule("fileSize")])])).toBeNull();
  });
});

describe("the messages", () => {
  it("name the blocked criteria by their labels, a stream query included", () => {
    expect(groupScopeBlockedLabels({ fields: ["resolution", "originallyAvailableAt"], streamQuery: true })).toEqual([
      "Resolution",
      "Release Date",
      "Stream Query",
    ]);
  });

  it("say what to do, in the scope's own words", () => {
    const series = groupScopeViolation("SERIES", true, [group([rule("resolution")])])!;
    expect(groupScopeSaveError(series)).toBe(
      `With "Match against entire series" on, a rule judges a whole show, so it can't use criteria that describe one ` +
        `episode or file: Resolution. Turn "Match against entire series" off to check them per episode, or remove them.`,
    );
    expect(groupScopeHoldReason(series)).toBe(
      `This rule set uses per-episode criteria (Resolution) with "Match against entire series" on, which would judge a ` +
        `whole show by one episode. It is not evaluated and its actions are held until it is edited: turn series scope ` +
        `off or remove those criteria.`,
    );
    const music = groupScopeViolation("MUSIC", true, [group([rule("audioCodec"), rule("albumTitle")])])!;
    expect(groupScopeSaveError(music)).toMatch(/^With "Match against entire artist" on, a rule judges a whole artist, .*one track or file: Audio Codec, Album\./);
    expect(groupScopeHoldReason(music)).toMatch(/^This rule set uses per-track criteria \(Audio Codec, Album\) .*turn artist scope off/);
  });
});
