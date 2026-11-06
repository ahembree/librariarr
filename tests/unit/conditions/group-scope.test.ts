/**
 * The rule (`src/lib/conditions/group-scope.ts`): a criterion whose value
 * belongs to one episode or one track must never be able to make a whole show
 * or a whole artist the target of an action.
 *
 * - With "Match against entire series" / "Match against entire artist" on
 *   (group judgement), a rule judges a whole show or artist, which matches
 *   through any one of its members, and its action covers all of it: a field
 *   stays allowed only if the sync gives every member of a show or artist the
 *   same value, on Plex, Jellyfin and Emby alike.
 * - With the scope off (member judgement), each episode or track is judged on
 *   its own, so under an action that acts on the whole show or artist only the
 *   fields every member answers alike stay allowed.
 *
 * The tables below classify every condition field for each library type and
 * each judgement, with the reason, so a new field has to be placed
 * deliberately; and every Series and Music action type as acting on the whole
 * show or artist or on the matched members only.
 */
import { describe, it, expect } from "vitest";
import { CONDITION_FIELDS, STREAM_QUERY_FIELDS, isEveryMemberField, isGroupValueField } from "@/lib/conditions";
import {
  GROUP_SCOPE_BLOCKED_FIELDS,
  WHOLE_RECORD_ACTION_TYPES,
  findGroupScopeBlockedCriteria,
  groupScopeBlockedLabels,
  groupScopeHoldReason,
  groupScopeSaveError,
  groupScopeViolation,
  isBlockedAtGroupScope,
  isGroupScope,
  wholeRecordActionBlockedBy,
  wholeRecordActionOf,
  type GroupScopeType,
} from "@/lib/conditions/group-scope";
import { MUSIC_ACTION_TYPES, SERIES_ACTION_TYPES } from "@/lib/lifecycle/action-types";

type Placement = "blocked" | "allowed";
type Row = Record<GroupScopeType, Placement> & { why: string };

const both = (placement: Placement, why: string): Row => ({ SERIES: placement, MUSIC: placement, why });

// ─── Group judgement: the scope on ──────────────────────────────────────

const ITS_OWN_FILE = "a property of one file, which each episode or track has its own of";
const ITS_OWN_ITEM = "the episode's or track's own, never copied from the show or artist";
const ARR = "read from the show's or artist's one Arr record";
const SEERR = "read from the show's one Seerr request record";
const AGGREGATE = "computed for the whole show from all its episodes";
const EVERY_MEMBER = "each member's own, and the group matches only when the rule holds for every member's";

/** Every condition field at series and artist scope. */
const AT_GROUP_SCOPE: Record<string, Row> = {
  // Content
  title: both("allowed", "the group record's name: the show or artist"),
  parentTitle: both("allowed", "the group record's name: the show or artist"),
  albumTitle: both("blocked", "a track's own album (episodes have none)"),
  year: both("blocked", ITS_OWN_ITEM),
  contentRating: both("blocked", "each item's own: Plex `contentRating`, Jellyfin/Emby `OfficialRating`"),
  studio: both("blocked", "each item's own: Plex `studio`, Jellyfin/Emby `Studios[0]`"),
  genre: both("blocked", "an episode keeps its own genres (the show's only when it has none); a track its own, no artist fallback"),
  labels: both("blocked", "each item's own Plex labels"),
  country: both("blocked", "each item's own Plex country tags"),
  // Activity
  playCount: both("allowed", "the group's total over every member"),
  watchedByUser: both("allowed", "everyone who watched any member"),
  rating: both("blocked", ITS_OWN_ITEM),
  audienceRating: both("blocked", ITS_OWN_ITEM),
  ratingCount: both("blocked", ITS_OWN_ITEM),
  isWatchlisted: both("blocked", "Jellyfin/Emby: each item's favourite flag; Plex: per item, and the incremental sync never sets it"),
  lastPlayedAt: both("allowed", "the group's latest play"),
  addedAt: both("allowed", "the group's earliest addition"),
  originallyAvailableAt: both("blocked", ITS_OWN_ITEM),
  // Video
  resolution: both("blocked", ITS_OWN_FILE),
  videoCodec: both("blocked", ITS_OWN_FILE),
  videoProfile: both("blocked", ITS_OWN_FILE),
  dynamicRange: both("blocked", ITS_OWN_FILE),
  videoBitDepth: both("blocked", ITS_OWN_FILE),
  videoBitrate: both("blocked", ITS_OWN_FILE),
  videoFrameRate: both("blocked", ITS_OWN_FILE),
  aspectRatio: both("blocked", ITS_OWN_FILE),
  scanType: both("blocked", ITS_OWN_FILE),
  // Audio
  audioCodec: both("blocked", ITS_OWN_FILE),
  audioProfile: both("blocked", ITS_OWN_FILE),
  audioChannels: both("blocked", ITS_OWN_FILE),
  audioSamplingRate: both("blocked", ITS_OWN_FILE),
  audioBitrate: both("blocked", ITS_OWN_FILE),
  // Streams (the union of the members' streams, which one file decides)
  audioLanguage: both("blocked", ITS_OWN_FILE),
  subtitleLanguage: both("blocked", ITS_OWN_FILE),
  streamAudioCodec: both("blocked", ITS_OWN_FILE),
  audioStreamCount: both("blocked", ITS_OWN_FILE),
  subtitleStreamCount: both("blocked", ITS_OWN_FILE),
  // File
  fileSize: both("allowed", "the group's summed size"),
  container: both("blocked", ITS_OWN_FILE),
  duration: both("blocked", ITS_OWN_FILE),
  // Cross-system: each member's own, but the group must hold for every member
  serverCount: both("allowed", EVERY_MEMBER),
  matchedByRuleSet: both("allowed", EVERY_MEMBER),
  hasPendingAction: both("allowed", EVERY_MEMBER),
  // External ids
  hasExternalId: {
    SERIES: "allowed",
    MUSIC: "blocked",
    why: "every episode stores its show's ids (or none); a track carries its own recording id, and an artist's tracks need not all carry its id",
  },
  // Arr: status
  foundInArr: both("allowed", ARR),
  arrMonitored: both("allowed", ARR),
  arrTag: both("allowed", ARR),
  arrQualityProfile: both("allowed", ARR),
  arrQualityName: both("allowed", ARR),
  arrQualityCutoffMet: both("allowed", ARR),
  arrCustomFormatScore: both("allowed", ARR),
  arrStatus: both("allowed", ARR),
  arrEnded: both("allowed", ARR),
  arrSeriesType: both("allowed", ARR),
  // Arr: media — the release and air dates describe the series, unlike the
  // item's own Release Date.
  arrRating: both("allowed", ARR),
  arrTmdbRating: both("allowed", ARR),
  arrRtCriticRating: both("allowed", ARR),
  arrOriginalLanguage: both("allowed", ARR),
  arrRuntime: both("allowed", ARR),
  arrSizeOnDisk: both("allowed", ARR),
  arrPath: both("allowed", ARR),
  arrReleaseDate: both("allowed", ARR),
  arrInCinemasDate: both("allowed", ARR),
  arrFirstAired: both("allowed", ARR),
  arrDateAdded: both("allowed", ARR),
  arrDownloadDate: both("allowed", ARR),
  // Arr: episodes
  arrSeasonCount: both("allowed", ARR),
  arrEpisodeCount: both("allowed", ARR),
  arrHasUnaired: both("allowed", ARR),
  arrMonitoredSeasonCount: both("allowed", ARR),
  arrMonitoredEpisodeCount: both("allowed", ARR),
  // Seerr
  seerrRequested: both("allowed", SEERR),
  seerrRequestDate: both("allowed", SEERR),
  seerrRequestCount: both("allowed", SEERR),
  seerrRequestedBy: both("allowed", SEERR),
  seerrApprovalDate: both("allowed", SEERR),
  seerrDeclineDate: both("allowed", SEERR),
  // Episode: where one episode sits in its show, which a whole show has none
  // of (a track's disc and track numbers read as empty).
  seasonNumber: both("blocked", "the episode's own season; a show has none"),
  episodeNumber: both("blocked", "the episode's own number; a show has none"),
  seasonsBehindLatest: both("blocked", "how far the episode's own season is behind the newest; a show has none"),
  // Series aggregates
  latestEpisodeViewDate: both("allowed", AGGREGATE),
  seriesLastPlayedAt: both("allowed", AGGREGATE),
  availableEpisodeCount: both("allowed", AGGREGATE),
  watchedEpisodeCount: both("allowed", AGGREGATE),
  watchedEpisodePercentage: both("allowed", AGGREGATE),
  lastEpisodeAddedAt: both("allowed", AGGREGATE),
  lastEpisodeAiredAt: both("allowed", AGGREGATE),
};

// ─── Member judgement: the scope off, an action on the whole record ─────

const MEMBERS_OWN = "each episode or track is judged on its own value";

/**
 * Every condition field with the scope off under an action on the whole show
 * or artist: only what every member of one show or artist answers alike.
 */
const UNDER_WHOLE_RECORD_ACTION: Record<string, Row> = Object.fromEntries(
  CONDITION_FIELDS.map((f): [string, Row] => {
    if (f.value === "parentTitle") return [f.value, both("allowed", "the show's or artist's name, on every member")];
    if (f.value === "hasExternalId") return [f.value, AT_GROUP_SCOPE.hasExternalId];
    if (f.requiresArr) return [f.value, both("allowed", ARR)];
    if (f.requiresSeerr) return [f.value, both("allowed", SEERR)];
    if (f.isSeriesAggregate) return [f.value, both("allowed", "injected as the show's constants into each episode")];
    return [f.value, both("blocked", MEMBERS_OWN)];
  }),
);

function rule(field: string, extra: Record<string, unknown> = {}) {
  return { id: `r-${field}`, field, operator: "equals", value: "x", condition: "AND", ...extra };
}

function group(rules: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "g", condition: "AND", rules, groups: [], ...extra };
}

describe("the group-scope field classification", () => {
  it("places every condition field, and nothing else", () => {
    expect(Object.keys(AT_GROUP_SCOPE).sort()).toEqual(CONDITION_FIELDS.map((f) => f.value).sort());
  });

  describe.each(["SERIES", "MUSIC"] as const)("at %s scope", (type) => {
    it.each(Object.entries(AT_GROUP_SCOPE))("%s", (field, row) => {
      expect(isBlockedAtGroupScope(field, type, "group"), row.why).toBe(row[type] === "blocked");
    });

    it("blocks exactly the classified fields", () => {
      const blocked = Object.entries(AT_GROUP_SCOPE).filter(([, row]) => row[type] === "blocked").map(([f]) => f);
      expect([...GROUP_SCOPE_BLOCKED_FIELDS[type]].sort()).toEqual(blocked.sort());
    });
  });

  it("blocks Has External ID for music only: tracks carry ids of their own", () => {
    expect(isBlockedAtGroupScope("hasExternalId", "SERIES")).toBe(false);
    expect(isBlockedAtGroupScope("hasExternalId", "MUSIC")).toBe(true);
  });

  it("blocks every field a group answers through any one member, so no one member decides", () => {
    // `matchGroupThroughMembers` matches a group through ANY member for the
    // fields it answers neither as a whole nor through every member; with all
    // of them blocked, a rule set the gate admits never lets one member decide.
    // The cross-system fields it admits are answered through EVERY member.
    for (const type of ["SERIES", "MUSIC"] as const) {
      for (const f of CONDITION_FIELDS) {
        if (isEveryMemberField(f.value)) {
          expect(isBlockedAtGroupScope(f.value, type), `${type} ${f.value}`).toBe(false);
        } else if (!isGroupValueField(f.value)) {
          expect(isBlockedAtGroupScope(f.value, type), `${type} ${f.value}`).toBe(true);
        }
      }
    }
  });

  it("blocks every stream-query field: one stream's property", () => {
    for (const type of ["SERIES", "MUSIC"] as const) {
      for (const f of STREAM_QUERY_FIELDS) {
        expect(isBlockedAtGroupScope(f.value, type, "group"), f.value).toBe(true);
        expect(isBlockedAtGroupScope(f.value, type, "member"), f.value).toBe(true);
      }
    }
  });
});

describe("the classification under an action on the whole show or artist, scope off", () => {
  describe.each(["SERIES", "MUSIC"] as const)("on %s", (type) => {
    it.each(Object.entries(UNDER_WHOLE_RECORD_ACTION))("%s", (field, row) => {
      expect(isBlockedAtGroupScope(field, type, "member"), row.why).toBe(row[type] === "blocked");
    });
  });

  it("blocks everything blocked at group scope, and the members' own activity besides", () => {
    for (const type of ["SERIES", "MUSIC"] as const) {
      for (const field of GROUP_SCOPE_BLOCKED_FIELDS[type]) expect(isBlockedAtGroupScope(field, type, "member"), field).toBe(true);
    }
    // At group scope these are the show's totals; with the scope off, one episode's.
    for (const field of ["title", "playCount", "lastPlayedAt", "addedAt", "fileSize", "watchedByUser", "hasPendingAction"]) {
      expect(isBlockedAtGroupScope(field, "SERIES", "group"), field).toBe(false);
      expect(isBlockedAtGroupScope(field, "SERIES", "member"), field).toBe(true);
    }
  });
});

describe("actions on the whole show or artist", () => {
  /** Every Series and Music action type: whole-record, or acting on the matched members only. */
  const ACTIONS: Record<GroupScopeType, Record<string, { whole: boolean; why: string }>> = {
    SERIES: {
      DO_NOTHING: { whole: false, why: "changes nothing" },
      DELETE_SONARR: { whole: true, why: "deleteSeries" },
      UNMONITOR_DELETE_FILES_SONARR: { whole: false, why: "episode-scoped with series scope off" },
      MONITOR_DELETE_FILES_SONARR: { whole: true, why: "monitors the series" },
      DELETE_FILES_SONARR: { whole: false, why: "deletes and searches the matched episodes by id" },
      UNMONITOR_SONARR: { whole: false, why: "episode-scoped with series scope off" },
      CHANGE_QUALITY_PROFILE_SONARR: { whole: true, why: "the series' profile" },
      SEARCH_SONARR: { whole: false, why: "episode-scoped with series scope off" },
    },
    MUSIC: {
      DO_NOTHING: { whole: false, why: "changes nothing" },
      DELETE_LIDARR: { whole: true, why: "deleteArtist" },
      UNMONITOR_DELETE_FILES_LIDARR: { whole: true, why: "unmonitors the artist" },
      MONITOR_DELETE_FILES_LIDARR: { whole: true, why: "monitors the artist" },
      DELETE_FILES_LIDARR: { whole: false, why: "deletes the matched tracks' files (its search after is whole-artist)" },
      UNMONITOR_LIDARR: { whole: true, why: "the artist" },
      CHANGE_QUALITY_PROFILE_LIDARR: { whole: true, why: "the artist's profile" },
      SEARCH_LIDARR: { whole: true, why: "searches the artist" },
    },
  };

  it("classifies every Series and Music action type", () => {
    expect(Object.keys(ACTIONS.SERIES).sort()).toEqual(SERIES_ACTION_TYPES.map((a) => a.value).sort());
    expect(Object.keys(ACTIONS.MUSIC).sort()).toEqual(MUSIC_ACTION_TYPES.map((a) => a.value).sort());
    for (const type of ["SERIES", "MUSIC"] as const) {
      const whole = Object.entries(ACTIONS[type]).filter(([, a]) => a.whole).map(([t]) => t);
      expect([...WHOLE_RECORD_ACTION_TYPES[type]].sort()).toEqual(whole.sort());
    }
  });

  it.each(
    (["SERIES", "MUSIC"] as const).flatMap((type) =>
      Object.entries(ACTIONS[type]).map(([actionType, a]) => [type, actionType, a.whole, a.why] as const),
    ),
  )("%s %s acts on the whole record: %s (%s)", (type, actionType, whole) => {
    const label = (type === "SERIES" ? SERIES_ACTION_TYPES : MUSIC_ACTION_TYPES).find((a) => a.value === actionType)!.label;
    expect(wholeRecordActionOf(type, { actionEnabled: true, actionType })).toBe(whole ? label : null);
  });

  it("counts Arr tags on any action, and Lidarr's search after a file delete", () => {
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "DELETE_FILES_SONARR", addArrTags: ["x"] })).toBe("Arr tags");
    // One action may add some tags and remove others: still the whole record.
    expect(wholeRecordActionOf("SERIES", {
      actionEnabled: true, actionType: "UNMONITOR_SONARR", addArrTags: ["old"], removeArrTags: ["keep"],
    })).toBe("Arr tags");
    expect(wholeRecordActionOf("MUSIC", {
      actionEnabled: true, actionType: "DELETE_FILES_LIDARR", addArrTags: ["a"], removeArrTags: ["b"],
    })).toBe("Arr tags");
    expect(wholeRecordActionOf("MUSIC", { actionEnabled: true, actionType: "DO_NOTHING", removeArrTags: ["x"] })).toBe("Arr tags");
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: null, addArrTags: ["x"] })).toBe("Arr tags");
    expect(wholeRecordActionOf("MUSIC", { actionEnabled: true, actionType: "DELETE_FILES_LIDARR", searchAfterAction: true })).toBe(
      "Delete Files Only with Search after",
    );
    // Sonarr searches the deleted episodes by id.
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "DELETE_FILES_SONARR", searchAfterAction: true })).toBeNull();
  });

  it("counts Sonarr's Unmonitor Only and Search for New Copy where they act on the whole series (episodeScope false)", () => {
    // The Query page's grouped series view runs them on the whole series.
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "UNMONITOR_SONARR", episodeScope: false })).toBe("Unmonitor Only");
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "SEARCH_SONARR", episodeScope: false })).toBe("Search for New Copy");
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "UNMONITOR_SONARR", episodeScope: true })).toBeNull();
    // Only those two can act on either.
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "DELETE_FILES_SONARR", episodeScope: false })).toBeNull();
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: "DO_NOTHING", episodeScope: false })).toBeNull();
    // With the scope off a member judgement follows; a rule set never sets it.
    expect(groupScopeViolation("SERIES", false, [{ id: "g", condition: "AND", groups: [], rules: [rule("resolution")] }], {
      actionEnabled: true, actionType: "UNMONITOR_SONARR", episodeScope: false,
    })?.judgement).toBe("member");
  });

  it("reads an action turned off, or none configured, as nothing; a scheduled action's snapshot as armed", () => {
    expect(wholeRecordActionOf("SERIES", { actionEnabled: false, actionType: "DELETE_SONARR", addArrTags: ["x"] })).toBeNull();
    expect(wholeRecordActionOf("SERIES", { actionEnabled: true, actionType: null })).toBeNull();
    expect(wholeRecordActionOf("SERIES", { actionType: "DELETE_SONARR" })).toBe("Delete from Sonarr");
    expect(wholeRecordActionOf("SERIES", null)).toBeNull();
    expect(wholeRecordActionOf("MOVIE", { actionEnabled: true, actionType: "DELETE_RADARR" })).toBeNull();
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
    expect(findGroupScopeBlockedCriteria(rules, "SERIES")).toEqual({ fields: ["resolution"], streamQuery: false });
  });

  it("finds a disabled rule, and a rule in a disabled group", () => {
    expect(findGroupScopeBlockedCriteria([group([rule("title"), rule("year", { enabled: false })])], "SERIES")).toEqual({
      fields: ["year"],
      streamQuery: false,
    });
    expect(findGroupScopeBlockedCriteria([group([rule("title")], { groups: [group([rule("audioCodec")], { enabled: false })] })], "MUSIC")).toEqual({
      fields: ["audioCodec"],
      streamQuery: false,
    });
  });

  it("finds a stream query group, even an empty or disabled one", () => {
    const sq = (extra: Record<string, unknown> = {}) =>
      group([rule("sqLanguage")], { streamQuery: { streamType: "audio", quantifier: "any" }, ...extra });
    expect(findGroupScopeBlockedCriteria([group([rule("title")], { groups: [sq()] })], "SERIES")).toEqual({ fields: [], streamQuery: true });
    expect(findGroupScopeBlockedCriteria([group([rule("title")], { groups: [sq({ enabled: false })] })], "SERIES")).toEqual({ fields: [], streamQuery: true });
    expect(findGroupScopeBlockedCriteria([group([], { streamQuery: { streamType: "video" } })], "MUSIC")).toEqual({ fields: [], streamQuery: true });
  });

  it("reads a legacy flat rule list", () => {
    expect(findGroupScopeBlockedCriteria([rule("playCount"), rule("dynamicRange")], "SERIES")).toEqual({ fields: ["dynamicRange"], streamQuery: false });
  });

  it("lists each blocked field once, in tree order", () => {
    const rules = [group([rule("year"), rule("genre"), rule("year")], { groups: [group([rule("genre"), rule("container")])] })];
    expect(findGroupScopeBlockedCriteria(rules, "SERIES")?.fields).toEqual(["year", "genre", "container"]);
  });

  it("finds nothing in rules using only allowed fields", () => {
    const rules = [group(
      ["title", "parentTitle", "playCount", "lastPlayedAt", "addedAt", "fileSize", "watchedByUser", "serverCount",
        "matchedByRuleSet", "hasPendingAction", "hasExternalId", "arrEnded", "arrFirstAired", "seerrRequested",
        "watchedEpisodePercentage", "seriesLastPlayedAt"].map((f) => rule(f)),
    )];
    expect(findGroupScopeBlockedCriteria(rules, "SERIES")).toBeNull();
    expect(findGroupScopeBlockedCriteria([], "SERIES")).toBeNull();
    expect(findGroupScopeBlockedCriteria(undefined, "MUSIC")).toBeNull();
  });

  it("reads the member judgement's list when asked", () => {
    const rules = [group([rule("parentTitle"), rule("playCount"), rule("arrEnded"), rule("watchedEpisodePercentage")])];
    expect(findGroupScopeBlockedCriteria(rules, "SERIES", "group")).toBeNull();
    expect(findGroupScopeBlockedCriteria(rules, "SERIES", "member")).toEqual({ fields: ["playCount"], streamQuery: false });
  });
});

describe("groupScopeViolation", () => {
  const blocked = [group([rule("playCount"), rule("resolution")], { groups: [group([], { streamQuery: { streamType: "audio" } })] })];
  const deleteSeries = { actionEnabled: true, actionType: "DELETE_SONARR", addArrTags: [], removeArrTags: [], searchAfterAction: false };
  const deleteArtist = { ...deleteSeries, actionType: "DELETE_LIDARR" };

  it("refuses a series-scoped or artist-scoped rule set holding blocked criteria, whatever its action", () => {
    for (const action of [undefined, null, { ...deleteSeries, actionType: "DELETE_FILES_SONARR" }]) {
      expect(groupScopeViolation("SERIES", true, blocked, action)).toEqual({
        type: "SERIES", judgement: "group", wholeRecordAction: null, scopeOnResolves: false, fields: ["resolution"], streamQuery: true,
      });
    }
    expect(groupScopeViolation("MUSIC", true, blocked)).toMatchObject({ type: "MUSIC", judgement: "group", fields: ["resolution"] });
    // An armed whole-show action is named: turning the scope off alone would not do.
    expect(groupScopeViolation("SERIES", true, blocked, deleteSeries)).toMatchObject({ judgement: "group", wholeRecordAction: "Delete from Sonarr" });
  });

  it("refuses a music rule set at artist scope reading a track's genre", () => {
    expect(groupScopeViolation("MUSIC", true, [group([rule("genre", { operator: "contains", value: "Rock", negate: true })])])).toMatchObject({
      judgement: "group",
      fields: ["genre"],
    });
  });

  it("refuses the same rules with the scope off when the action acts on the whole show or artist", () => {
    expect(groupScopeViolation("SERIES", false, blocked, deleteSeries)).toEqual({
      type: "SERIES",
      judgement: "member",
      wholeRecordAction: "Delete from Sonarr",
      // Resolution and the stream query describe one episode at series scope too.
      scopeOnResolves: false,
      fields: ["playCount", "resolution"],
      streamQuery: true,
    });
    expect(groupScopeViolation("MUSIC", false, [group([rule("audioCodec")])], deleteArtist)).toMatchObject({
      judgement: "member",
      wholeRecordAction: "Delete from Lidarr",
      fields: ["audioCodec"],
    });
    // Play Count alone: the whole show answers it at series scope.
    expect(groupScopeViolation("SERIES", false, [group([rule("playCount")])], deleteSeries)).toMatchObject({
      judgement: "member",
      scopeOnResolves: true,
    });
  });

  it("allows the same rules with the scope off under an action on the matched members, or none", () => {
    for (const action of [
      undefined,
      { ...deleteSeries, actionEnabled: false },
      { ...deleteSeries, actionType: "DELETE_FILES_SONARR", searchAfterAction: true },
      { ...deleteSeries, actionType: "UNMONITOR_SONARR" },
      { ...deleteSeries, actionType: "SEARCH_SONARR" },
      { ...deleteSeries, actionType: "DO_NOTHING" },
    ]) {
      expect(groupScopeViolation("SERIES", false, blocked, action)).toBeNull();
    }
    expect(groupScopeViolation("MUSIC", false, blocked, { ...deleteArtist, actionType: "DELETE_FILES_LIDARR" })).toBeNull();
    expect(groupScopeViolation("MOVIE", true, blocked, { ...deleteSeries, actionType: "DELETE_RADARR" })).toBeNull();
    expect(groupScopeViolation("MOVIE", false, blocked)).toBeNull();
  });

  it("allows whole-show criteria under a whole-show action with the scope off", () => {
    const showLevel = [group([rule("parentTitle"), rule("arrEnded"), rule("watchedEpisodePercentage"), rule("seerrRequested")])];
    expect(groupScopeViolation("SERIES", false, showLevel, deleteSeries)).toBeNull();
    expect(groupScopeViolation("MUSIC", false, [group([rule("parentTitle"), rule("arrMonitored")])], deleteArtist)).toBeNull();
  });

  it("allows allowed criteria with the scope on", () => {
    expect(groupScopeViolation("SERIES", true, [group([rule("playCount"), rule("arrEnded"), rule("availableEpisodeCount")])], deleteSeries)).toBeNull();
    expect(groupScopeViolation("MUSIC", true, [group([rule("playCount"), rule("fileSize")])], deleteArtist)).toBeNull();
  });
});

describe("wholeRecordActionBlockedBy", () => {
  it("names the criteria a whole-show action may not follow with the scope off", () => {
    const rules = [group([rule("arrEnded"), rule("resolution")])];
    expect(wholeRecordActionBlockedBy("SERIES", false, rules, "DELETE_SONARR")).toEqual({ fields: ["resolution"], streamQuery: false });
    expect(wholeRecordActionBlockedBy("SERIES", false, rules, "DELETE_FILES_SONARR")).toBeNull();
    // With the scope on, the scope decides alone.
    expect(wholeRecordActionBlockedBy("SERIES", true, rules, "DELETE_SONARR")).toBeNull();
    expect(wholeRecordActionBlockedBy("SERIES", false, [group([rule("arrEnded")])], "DELETE_SONARR")).toBeNull();
    expect(wholeRecordActionBlockedBy("MOVIE", false, rules, "DELETE_RADARR")).toBeNull();
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

  it("never offer turning the scope off alone while the action acts on the whole show", () => {
    const violation = groupScopeViolation("SERIES", true, [group([rule("genre")])], { actionEnabled: true, actionType: "DELETE_SONARR" })!;
    expect(groupScopeSaveError(violation)).toBe(
      `With "Match against entire series" on, a rule judges a whole show, so it can't use criteria that describe one ` +
        `episode or file: Genre. Remove them, or turn "Match against entire series" off and switch to an action that ` +
        `acts only on the matched episodes (Delete Files Only, Unmonitor & Delete Files, Unmonitor Only or Search for New Copy, without Arr tags) — ` +
        `"Delete from Sonarr" acts on the whole show.`,
    );
    expect(groupScopeHoldReason(violation)).toMatch(
      /until it is edited: remove those criteria, or turn series scope off and switch to an action that acts only on the matched episodes\.$/,
    );
  });

  it("say why an action on the whole show may not follow per-episode criteria, and the ways out", () => {
    const deleteSeries = { actionEnabled: true, actionType: "DELETE_SONARR" };
    const resolution = groupScopeViolation("SERIES", false, [group([rule("resolution")])], deleteSeries)!;
    expect(groupScopeSaveError(resolution)).toBe(
      `"Delete from Sonarr" acts on the whole show, so with "Match against entire series" off it can't follow criteria ` +
        `that describe one episode or file: Resolution — one episode would decide for the whole show. Remove them, or ` +
        `switch to an action that acts only on the matched episodes (Delete Files Only, Unmonitor & Delete Files, ` +
        `Unmonitor Only or Search for New Copy, without Arr tags).`,
    );
    expect(groupScopeHoldReason(resolution)).toBe(
      `This rule set's action ("Delete from Sonarr") acts on the whole show but follows per-episode criteria ` +
        `(Resolution) with series scope off, which would let one episode decide for the whole show. It is not ` +
        `evaluated and its actions are held until it is edited: remove those criteria or switch to an action that ` +
        `acts only on the matched episodes.`,
    );
    // Turning the scope on is offered only when the whole show answers them.
    const plays = groupScopeViolation("SERIES", false, [group([rule("playCount")])], deleteSeries)!;
    expect(groupScopeSaveError(plays)).toMatch(/, or turn "Match against entire series" on to judge the whole show\.$/);
    expect(groupScopeHoldReason(plays)).toMatch(/, or turn series scope on\.$/);
    const tracks = groupScopeViolation("MUSIC", false, [group([rule("genre")])], { actionEnabled: true, actionType: "DO_NOTHING", addArrTags: ["x"] })!;
    expect(groupScopeSaveError(tracks)).toMatch(
      /^"Arr tags" acts on the whole artist, .*Genre — one track would decide for the whole artist\. Remove them, or switch to an action that acts only on the matched tracks \(Delete Files Only, without Search after or Arr tags\)\.$/,
    );
  });
});
