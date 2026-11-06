import { describe, it, expect, vi } from "vitest";
import {
  aggregateEpisodesIntoSeries,
  serializeSeriesAggregateForEval,
  withGroupParentTitle,
  isGroupRecord,
  episodesMatchingIndividually,
  isGroupValueField,
  MEMBER_VALUE_COLUMNS,
  memberValuesOf,
  readsMemberValues,
  readsEpisodeValues,
  matchGroupThroughMembers,
  withEvaluatedRecord,
  evaluatedRecordOf,
  isEveryMemberField,
  withEveryMemberValues,
  everyMemberValuesOf,
  type AggregableEpisode,
} from "@/lib/conditions/series-aggregates";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import type { ConditionGroup } from "@/lib/conditions/types";
import { Prisma } from "@/generated/prisma/client";

function ep(overrides: Partial<AggregableEpisode> & { id: string; parentTitle: string | null; libraryId: string }): AggregableEpisode {
  return {
    playCount: 0,
    fileSize: null,
    lastPlayedAt: null,
    addedAt: null,
    originallyAvailableAt: null,
    seasonNumber: null,
    episodeNumber: null,
    title: overrides.title ?? "Episode",
    summary: null,
    parentSummary: null,
    ...overrides,
  };
}

describe("aggregateEpisodesIntoSeries", () => {
  it("groups episodes per library by series (the title when they carry no seriesKey or ids)", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "Show A", libraryId: "L1" }),
      ep({ id: "e2", parentTitle: "Show A", libraryId: "L1" }),
      ep({ id: "e3", parentTitle: "Show B", libraryId: "L1" }),
      ep({ id: "e4", parentTitle: "Show A", libraryId: "L2" }),
    ];
    const result = aggregateEpisodesIntoSeries(episodes);
    expect(result.map((s) => [s.libraryId, s.title, [...s.memberIds].sort()]).sort()).toEqual([
      ["L1", "Show A", ["e1", "e2"]],
      ["L1", "Show B", ["e3"]],
      ["L2", "Show A", ["e4"]],
    ]);
  });

  it("splits two same-titled shows with different seriesKeys within a library", () => {
    // Both shows are "The Office" in the same library; only the seriesKey differs.
    const episodes: AggregableEpisode[] = [
      ep({ id: "uk1", parentTitle: "The Office", libraryId: "L1", seriesKey: "tvdb:78107" }),
      ep({ id: "us1", parentTitle: "The Office", libraryId: "L1", seriesKey: "tvdb:73244" }),
      ep({ id: "us2", parentTitle: "The Office", libraryId: "L1", seriesKey: "tvdb:73244" }),
    ];
    const result = aggregateEpisodesIntoSeries(episodes);
    // Two aggregates, not one blended series.
    expect(result).toHaveLength(2);
    const uk = result.find((s) => s.memberIds.includes("uk1"))!;
    const us = result.find((s) => s.memberIds.includes("us1"))!;
    expect(uk.episodeCount).toBe(1);
    expect(us.episodeCount).toBe(2);
    expect(us.memberIds.sort()).toEqual(["us1", "us2"]);
  });

  it("keeps the same show as separate per-library aggregates (collapsed by Arr id downstream)", () => {
    // Same seriesKey on two libraries/servers stays two aggregates so episode
    // counts aren't doubled; the multi-server caller collapses them by Arr id.
    const episodes: AggregableEpisode[] = [
      ep({ id: "a", parentTitle: "BSG", libraryId: "L1", seriesKey: "tvdb:73545" }),
      ep({ id: "b", parentTitle: "BSG", libraryId: "L2", seriesKey: "tvdb:73545" }),
    ];
    const result = aggregateEpisodesIntoSeries(episodes);
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.episodeCount === 1)).toBe(true);
  });

  it("sums playCount across episodes", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", playCount: 2 }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", playCount: 5 }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.playCount).toBe(7);
  });

  it("counts watched episodes (playCount > 0)", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", playCount: 1 }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", playCount: 0 }),
      ep({ id: "e3", parentTitle: "S", libraryId: "L", playCount: 3 }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.watchedEpisodeCount).toBe(2);
    expect(series.episodeCount).toBe(3);
  });

  it("uses lastPlayedAt of the highest-numbered episode for latestEpisodeViewDate", () => {
    const oldDate = new Date("2024-01-01");
    const newDate = new Date("2025-01-01");
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", seasonNumber: 1, episodeNumber: 1, lastPlayedAt: newDate }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", seasonNumber: 2, episodeNumber: 5, lastPlayedAt: oldDate }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    // The S2E5 episode is "newest" by season/episode → its lastPlayedAt is the latestEpisodeViewDate
    expect(series.latestEpisodeViewDate).toEqual(oldDate);
  });

  it("computes lastEpisodeAiredAt as max of originallyAvailableAt", () => {
    const a = new Date("2024-01-01");
    const b = new Date("2025-06-01");
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", originallyAvailableAt: a }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", originallyAvailableAt: b }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.lastEpisodeAiredAt).toEqual(b);
  });

  it("sums fileSize across episodes (BigInt → string)", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", fileSize: BigInt(1000) }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", fileSize: BigInt(500) }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.fileSize).toBe("1500");
  });

  it("returns null fileSize when all episodes have no size", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L" }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.fileSize).toBeNull();
  });

  it("uses parentTitle as the aggregate's title and clears episode-only fields", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "Show A", libraryId: "L", title: "Pilot", seasonNumber: 1, episodeNumber: 1 }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.title).toBe("Show A");
    expect(series.parentTitle).toBeNull();
    expect(series.seasonNumber).toBeNull();
    expect(series.episodeNumber).toBeNull();
  });

  it("flattens streams across episodes when includeStreams=true", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", streams: [{ codec: "h264" }] }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", streams: [{ codec: "aac" }] }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes, { includeStreams: true });
    expect(series.allStreams).toEqual([{ codec: "h264" }, { codec: "aac" }]);
    // Not asked for, not carried.
    expect(aggregateEpisodesIntoSeries(episodes)[0].allStreams).toBeUndefined();
  });

  it("collects the distinct users who played any episode, keeping their casing", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", watchHistory: [{ serverUsername: "Alice" }, { serverUsername: null }] }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", watchHistory: [{ serverUsername: "Alice" }, { serverUsername: "bob" }] }),
      ep({ id: "e3", parentTitle: "S", libraryId: "L" }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.watchedByUsers).toEqual(["Alice", "bob"]);
  });

  it("takes the earliest addedAt for the show and the latest for lastEpisodeAddedAt", () => {
    const first = new Date("2023-05-01T00:00:00.000Z");
    const latest = new Date("2025-02-01T00:00:00.000Z");
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", addedAt: latest }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", addedAt: first }),
      ep({ id: "e3", parentTitle: "S", libraryId: "L" }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    expect(series.addedAt).toEqual(first);
    expect(series.lastEpisodeAddedAt).toEqual(latest);
  });
});

describe("serializeSeriesAggregateForEval", () => {
  it("computes watchedEpisodePercentage from watchedCount and episodeCount", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", playCount: 1 }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", playCount: 0 }),
      ep({ id: "e3", parentTitle: "S", libraryId: "L", playCount: 0 }),
      ep({ id: "e4", parentTitle: "S", libraryId: "L", playCount: 1 }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    const item = serializeSeriesAggregateForEval(series);
    expect(item.watchedEpisodePercentage).toBe(50);
  });

  it("returns 0% when there are no episodes (defensive)", () => {
    // Aggregate produced from a single (empty) call shouldn't divide by zero.
    const series = {
      ...aggregateEpisodesIntoSeries([
        ep({ id: "e1", parentTitle: "S", libraryId: "L" }),
      ])[0],
      episodeCount: 0,
      watchedEpisodeCount: 0,
    };
    const item = serializeSeriesAggregateForEval(series);
    expect(item.watchedEpisodePercentage).toBe(0);
  });

  it("converts Date fields to ISO strings", () => {
    const d = new Date("2025-03-15T12:00:00.000Z");
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L", lastPlayedAt: d, addedAt: d }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    const item = serializeSeriesAggregateForEval(series);
    expect(item.lastPlayedAt).toBe("2025-03-15T12:00:00.000Z");
    expect(item.addedAt).toBe("2025-03-15T12:00:00.000Z");
    expect(item.lastEpisodeAddedAt).toBe("2025-03-15T12:00:00.000Z");
    expect(item.lastEpisodeAiredAt).toBeNull();
  });

  it("exposes seriesLastPlayedAt as MAX(lastPlayedAt) across all episodes", () => {
    const recent = new Date("2025-12-01T00:00:00.000Z");
    const old = new Date("2024-01-01T00:00:00.000Z");
    const episodes: AggregableEpisode[] = [
      // Newest episode by number played long ago; an earlier episode played recently.
      ep({ id: "e1", parentTitle: "S", libraryId: "L", seasonNumber: 1, episodeNumber: 1, lastPlayedAt: recent }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L", seasonNumber: 9, episodeNumber: 9, lastPlayedAt: old }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    const item = serializeSeriesAggregateForEval(series);
    // MAX across all episodes — distinct from latestEpisodeViewDate (newest episode's date).
    expect(item.seriesLastPlayedAt).toBe("2025-12-01T00:00:00.000Z");
    expect(item.latestEpisodeViewDate).toBe("2024-01-01T00:00:00.000Z");
  });

  it("seriesLastPlayedAt is null when no episode has been played", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L" }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L" }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    const item = serializeSeriesAggregateForEval(series);
    expect(item.seriesLastPlayedAt).toBeNull();
  });

  it("aliases episodeCount to availableEpisodeCount on the eval object", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "S", libraryId: "L" }),
      ep({ id: "e2", parentTitle: "S", libraryId: "L" }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    const item = serializeSeriesAggregateForEval(series);
    expect(item.availableEpisodeCount).toBe(2);
  });

  // "Artist / Series" is the series name. Read as NULL off the aggregate it
  // matched no show for `equals` and every show for its negations.
  it("answers parentTitle with the show's name, leaving the aggregate's own record cleared", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "Show A", libraryId: "L", title: "Pilot" }),
    ];
    const [series] = aggregateEpisodesIntoSeries(episodes);
    const item = serializeSeriesAggregateForEval(series);
    expect(item.parentTitle).toBe("Show A");
    expect(item.title).toBe("Show A");
    expect(series.parentTitle).toBeNull();
  });
});

describe("withGroupParentTitle / isGroupRecord", () => {
  it("names a group's parentTitle after its title", () => {
    expect(withGroupParentTitle({ id: "a", title: "Artist", parentTitle: null })).toEqual({
      id: "a", title: "Artist", parentTitle: "Artist",
    });
    expect(withGroupParentTitle({ id: "a", title: undefined }).parentTitle).toBeNull();
  });

  it("recognises a group record by its members, its title and its cleared parent", () => {
    expect(isGroupRecord({ id: "a", title: "Show", parentTitle: null, memberIds: ["a", "b"] })).toBe(true);
    // A single episode or track carries its parent and no members.
    expect(isGroupRecord({ id: "a", title: "Pilot", parentTitle: "Show" })).toBe(false);
    expect(isGroupRecord({ id: "a", title: "Pilot", parentTitle: "Show", memberIds: ["a"] })).toBe(false);
    expect(isGroupRecord({ id: "a", title: "Film", parentTitle: null })).toBe(false);
  });
});

describe("episodesMatchingIndividually", () => {
  it("keeps the episodes that pass on their own, with every series aggregate carried over", () => {
    const aggregate = {
      title: "Show", resolution: "4k",
      availableEpisodeCount: 3, watchedEpisodeCount: 1, watchedEpisodePercentage: 33,
      latestEpisodeViewDate: "2026-01-01T00:00:00.000Z", seriesLastPlayedAt: "2026-01-02T00:00:00.000Z",
      lastEpisodeAddedAt: "2026-01-03T00:00:00.000Z", lastEpisodeAiredAt: "2026-01-04T00:00:00.000Z",
    };
    const episodes = [
      { id: "e1", resolution: "4k" },
      { id: "e2", resolution: "1080" },
      { id: "e3", resolution: "4k" },
    ];
    const seen: Array<Record<string, unknown>> = [];
    const kept = episodesMatchingIndividually(episodes, aggregate, (ep, seriesFields) => {
      const item: Record<string, unknown> = { ...ep, ...seriesFields };
      seen.push(item);
      return item.resolution === "4k" && Number(item.availableEpisodeCount) >= 3;
    });
    expect(kept).toEqual(["e1", "e3"]);
    // The episode's own fields stay its own; only the aggregates are injected.
    expect(seen[1]).toEqual({
      id: "e2", resolution: "1080",
      availableEpisodeCount: 3, watchedEpisodeCount: 1, watchedEpisodePercentage: 33,
      latestEpisodeViewDate: "2026-01-01T00:00:00.000Z", seriesLastPlayedAt: "2026-01-02T00:00:00.000Z",
      lastEpisodeAddedAt: "2026-01-03T00:00:00.000Z", lastEpisodeAiredAt: "2026-01-04T00:00:00.000Z",
    });
  });

  it("evaluates one episode and keeps every episode or none when no rule reads an episode's own value", () => {
    const episodes = [{ id: "e1" }, { id: "e2" }, { id: "e3" }];
    const pass = vi.fn(() => true);
    expect(episodesMatchingIndividually(episodes, { availableEpisodeCount: 3 }, pass, false)).toEqual(["e1", "e2", "e3"]);
    expect(pass).toHaveBeenCalledTimes(1);
    const fail = vi.fn(() => false);
    expect(episodesMatchingIndividually(episodes, { availableEpisodeCount: 3 }, fail, false)).toEqual([]);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(episodesMatchingIndividually([], {}, pass, false)).toEqual([]);
  });
});

function ruleGroups(fields: string[], extra: Partial<ConditionGroup> = {}): ConditionGroup[] {
  return [{
    id: "g", condition: "AND", groups: [], ...extra,
    rules: fields.map((field, i) => ({ id: `r${i}`, field, operator: "equals", value: "x", condition: "AND" as const })),
  }];
}

const AUDIO_STREAM_QUERY = { streamQuery: { streamType: "audio" as const, quantifier: "any" as const } };

describe("group values and member values", () => {
  // A field a group answers per member is read off the member that satisfies
  // the rule; read off the representative alone, "Resolution = 4K" matched a
  // show only when its lowest-id episode was 4K. A new condition field has to
  // be placed on one side or the other here.
  it("answers every per-item field per member and the group's own values once", () => {
    const perMember = CONDITION_FIELDS.map((f) => f.value).filter((f) => !isGroupValueField(f) && !isEveryMemberField(f));
    expect(perMember.sort()).toEqual([
      "albumTitle", "aspectRatio", "audienceRating", "audioBitrate", "audioChannels", "audioCodec",
      "audioProfile", "audioSamplingRate", "container", "contentRating", "country", "duration",
      "dynamicRange", "episodeNumber", "genre", "isWatchlisted", "labels", "originallyAvailableAt", "rating",
      "ratingCount", "resolution", "scanType", "seasonNumber", "seasonsBehindLatest", "studio", "videoBitDepth",
      "videoBitrate", "videoCodec", "videoFrameRate", "videoProfile", "year",
    ]);
    for (const field of [
      "title", "parentTitle", "playCount", "lastPlayedAt", "addedAt", "fileSize", "watchedByUser",
      "audioLanguage", "subtitleLanguage", "streamAudioCodec", "audioStreamCount", "subtitleStreamCount",
      "hasExternalId",
      "availableEpisodeCount", "seriesLastPlayedAt", "arrTag", "arrMonitored", "seerrRequested", "sqCodec",
    ]) {
      expect(isGroupValueField(field), field).toBe(true);
      expect(isEveryMemberField(field), field).toBe(false);
    }
  });

  it("answers the cross-system fields through every member, never as one folded value for the group", () => {
    // Folded — matched if any episode was, pending if any was, the highest
    // count — one episode decided for the whole show.
    expect(CONDITION_FIELDS.map((f) => f.value).filter(isEveryMemberField).sort()).toEqual([
      "hasPendingAction", "matchedByRuleSet", "serverCount",
    ]);
    for (const field of ["serverCount", "matchedByRuleSet", "hasPendingAction"]) {
      expect(isGroupValueField(field), field).toBe(false);
    }
    // Not member columns: the values come from fetchCrossSystemData, per member.
    expect(MEMBER_VALUE_COLUMNS).not.toContain("serverCount");
    expect(MEMBER_VALUE_COLUMNS).not.toContain("matchedByRuleSet");
    expect(MEMBER_VALUE_COLUMNS).not.toContain("hasPendingAction");
  });

  it("takes each per-member field from a column a media item has", () => {
    const columns = new Set<string>(Object.values(Prisma.MediaItemScalarFieldEnum));
    // Seasons Behind Latest is no column: the engines attach it to each
    // episode before Phase 2 (`attachSeasonsBehindLatest`).
    expect(MEMBER_VALUE_COLUMNS.filter((c) => !columns.has(c))).toEqual(["seasonsBehindLatest"]);
    expect(MEMBER_VALUE_COLUMNS).toContain("genres");
    expect(MEMBER_VALUE_COLUMNS).toContain("countries");
  });

  it("copies a member's per-member values and nothing of the group's", () => {
    const values = memberValuesOf({
      id: "e2", title: "Pilot", playCount: 4, fileSize: BigInt(5), resolution: "4k", year: 2021, genres: ["Drama"],
    });
    expect(values).toEqual({ resolution: "4k", year: 2021, genres: ["Drama"] });
  });

  it("tells whether a rule reads a per-member value", () => {
    expect(readsMemberValues(ruleGroups(["resolution"]))).toBe(true);
    expect(readsMemberValues(ruleGroups(["playCount", "title", "availableEpisodeCount", "arrTag", "serverCount"]))).toBe(false);
    // A stream query reads the union of the group's streams.
    expect(readsMemberValues(ruleGroups(["sqCodec"], AUDIO_STREAM_QUERY))).toBe(false);
    // A disabled rule is never evaluated.
    expect(readsMemberValues([{
      id: "g", condition: "AND", groups: [],
      rules: [
        { id: "a", field: "playCount", operator: "equals", value: "0", condition: "AND" },
        { id: "b", field: "resolution", operator: "equals", value: "4K", condition: "AND", enabled: false },
      ],
    }])).toBe(false);
  });

  it("tells whether a per-episode run reads an episode's own value", () => {
    // Series scope off: the episode's own play count, title and streams.
    expect(readsEpisodeValues(ruleGroups(["availableEpisodeCount", "playCount"]))).toBe(true);
    expect(readsEpisodeValues(ruleGroups(["availableEpisodeCount", "resolution"]))).toBe(true);
    expect(readsEpisodeValues(ruleGroups(["sqCodec"], AUDIO_STREAM_QUERY))).toBe(true);
    // Aggregates, Arr and Seerr are the show's, alike for every episode.
    expect(readsEpisodeValues(ruleGroups(["availableEpisodeCount", "watchedEpisodePercentage", "arrTag", "seerrRequested"]))).toBe(false);
  });
});

describe("matchGroupThroughMembers", () => {
  const group = { id: "e1", title: "Show", parentTitle: "Show", resolution: "1080", year: 2001, playCount: 9 };
  const members = [
    { id: "e3", resolution: "4k", year: 2003 },
    { id: "e1", resolution: "1080", year: 2001 },
    { id: "e2", resolution: "4k", year: 2002 },
  ];
  const is4k = (record: Record<string, unknown>) => record.resolution === "4k";

  it("matches through the first member, lowest id first, that satisfies the rule", () => {
    // e2, not e3: members are taken lowest id first whatever order they come in.
    expect(matchGroupThroughMembers(group, members, is4k, true)).toEqual({
      record: { ...group, resolution: "4k", year: 2002 },
      memberValues: { resolution: "4k", year: 2002 },
    });
  });

  it("keeps the group's own values whichever member it is seen through", () => {
    const seen: Array<Record<string, unknown>> = [];
    matchGroupThroughMembers(group, members, (record) => { seen.push(record); return false; }, true);
    expect(seen.map((r) => [r.title, r.playCount, r.resolution])).toEqual([
      ["Show", 9, "1080"], ["Show", 9, "4k"], ["Show", 9, "4k"],
    ]);
  });

  it("matches no group none of whose members satisfies the rule", () => {
    expect(matchGroupThroughMembers(group, [members[1]], is4k, true)).toBeNull();
  });

  it("evaluates the group once when no rule reads a per-member value", () => {
    const matches = vi.fn(() => true);
    expect(matchGroupThroughMembers(group, members, matches, false)).toEqual({ record: group, memberValues: {} });
    expect(matches).toHaveBeenCalledTimes(1);
    expect(matches).toHaveBeenCalledWith(group);
  });
});

describe("matchGroupThroughMembers through every member (cross-system fields)", () => {
  const group = { id: "e1", title: "Show", parentTitle: "Show", playCount: 0 };
  const members = [{ id: "e3" }, { id: "e1" }, { id: "e2" }];
  const cross: Record<string, Record<string, unknown>> = {
    e1: { serverCount: 2, matchedRuleSets: ["Keep"], hasPendingAction: false },
    e2: { serverCount: 1, matchedRuleSets: [], hasPendingAction: false },
    e3: { serverCount: 2, matchedRuleSets: ["Keep"], hasPendingAction: true },
  };
  const everyMember = (m: { id: string }) => cross[m.id];
  const keptBy = (record: Record<string, unknown>) => (record.matchedRuleSets as string[]).includes("Keep");

  it("matches only when the rule holds for every member's own values: one member never decides", () => {
    // Folded, e1 and e3 made the show "matched by Keep" and "on 2 servers".
    expect(matchGroupThroughMembers(group, members, keptBy, false, everyMember)).toBeNull();
    expect(matchGroupThroughMembers(group, members, (r) => (r.serverCount as number) >= 2, false, everyMember)).toBeNull();
    expect(matchGroupThroughMembers(group, members, (r) => r.hasPendingAction === true, false, everyMember)).toBeNull();
    expect(matchGroupThroughMembers(group, [{ id: "e1" }, { id: "e3" }], keptBy, false, everyMember)).not.toBeNull();
  });

  it("keeps the protective forms: excluded when any member is", () => {
    const notKept = (record: Record<string, unknown>) => !keptBy(record);
    const notPending = (record: Record<string, unknown>) => record.hasPendingAction === false;
    expect(matchGroupThroughMembers(group, members, notKept, false, everyMember)).toBeNull();
    expect(matchGroupThroughMembers(group, members, notPending, false, everyMember)).toBeNull();
    expect(matchGroupThroughMembers(group, [{ id: "e2" }], notKept, false, everyMember)).not.toBeNull();
    expect(matchGroupThroughMembers(group, [{ id: "e1" }, { id: "e2" }], notPending, false, everyMember)).not.toBeNull();
  });

  it("reads each member's own values over the group's, and the group's for everything else", () => {
    const seen: Array<Record<string, unknown>> = [];
    matchGroupThroughMembers({ ...group, serverCount: 9 }, members, (record) => { seen.push(record); return true; }, false, everyMember);
    expect(seen.map((r) => [r.title, r.playCount, r.serverCount, r.hasPendingAction])).toEqual([
      ["Show", 0, 2, false], ["Show", 0, 1, false], ["Show", 0, 2, true],
    ]);
  });

  it("evaluates each distinct set of member values once", () => {
    const matches = vi.fn(() => true);
    const same = () => ({ serverCount: 1, matchedRuleSets: [], hasPendingAction: false });
    matchGroupThroughMembers(group, members, matches, false, same);
    expect(matches).toHaveBeenCalledTimes(1);
  });

  it("returns the group carrying every member's values, lowest id first, for reporting", () => {
    const selection = matchGroupThroughMembers(group, members, () => true, false, everyMember)!;
    expect(selection.record).toEqual(group);
    expect(selection.memberValues).toEqual({});
    expect(selection.everyMemberValues).toEqual([cross.e1, cross.e2, cross.e3]);
    expect(everyMemberValuesOf(selection.record)).toEqual([cross.e1, cross.e2, cross.e3]);
  });

  it("matches no group without members", () => {
    expect(matchGroupThroughMembers(group, [], () => true, false, everyMember)).toBeNull();
  });

  it("with per-member values too (a rule set the gate holds), requires every member to pass with all of its own", () => {
    const withRes = [{ id: "e1", resolution: "4k" }, { id: "e2", resolution: "1080" }];
    const fourKOnAServer = (r: Record<string, unknown>) => r.resolution === "4k" && ((r.serverCount as number | undefined) ?? 1) >= 1;
    // e1 alone passes; e2 does not, so the group does not match — the stricter reading.
    expect(matchGroupThroughMembers(group, withRes, fourKOnAServer, true)).not.toBeNull();
    expect(matchGroupThroughMembers(group, withRes, fourKOnAServer, true, everyMember)).toBeNull();
    const selection = matchGroupThroughMembers(group, withRes, (r) => r.resolution !== "720", true, everyMember)!;
    expect(selection.memberValues).toEqual({ resolution: "4k" });
  });
});

describe("withEveryMemberValues", () => {
  it("carries the members' values without a spread or JSON ever copying them", () => {
    const values = [{ serverCount: 1 }];
    const record = withEveryMemberValues({ id: "e1", title: "Show" }, values);
    expect(everyMemberValuesOf(record)).toBe(values);
    expect(Object.keys(record)).toEqual(["id", "title"]);
    expect(everyMemberValuesOf({ ...record })).toBeUndefined();
    expect(JSON.parse(JSON.stringify(record))).toEqual({ id: "e1", title: "Show" });
    expect(everyMemberValuesOf(withEveryMemberValues({ id: "x" }, undefined))).toBeUndefined();
  });
});

describe("withEvaluatedRecord", () => {
  it("carries the evaluated record without a spread or JSON ever copying it", () => {
    const evaluated = { id: "e2", title: "Pilot", playCount: 0 };
    const record = withEvaluatedRecord({ id: "e1", title: "Show", parentTitle: null }, evaluated);
    expect(evaluatedRecordOf(record)).toBe(evaluated);
    expect(Object.keys(record)).toEqual(["id", "title", "parentTitle"]);
    expect(evaluatedRecordOf({ ...record })).toBeUndefined();
    expect(JSON.parse(JSON.stringify(record))).toEqual({ id: "e1", title: "Show", parentTitle: null });
    expect(evaluatedRecordOf({ id: "x" })).toBeUndefined();
  });
});
