import { describe, it, expect } from "vitest";
import {
  aggregateEpisodesIntoSeries,
  serializeSeriesAggregateForEval,
  type AggregableEpisode,
} from "@/lib/conditions/series-aggregates";

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
  it("groups episodes by libraryId+parentTitle into one record per series", () => {
    const episodes: AggregableEpisode[] = [
      ep({ id: "e1", parentTitle: "Show A", libraryId: "L1" }),
      ep({ id: "e2", parentTitle: "Show A", libraryId: "L1" }),
      ep({ id: "e3", parentTitle: "Show B", libraryId: "L1" }),
      ep({ id: "e4", parentTitle: "Show A", libraryId: "L2" }),
    ];
    const result = aggregateEpisodesIntoSeries(episodes);
    expect(result).toHaveLength(3);
    const showALib1 = result.find((s) => s.title === "Show A" && s.memberIds.includes("e1"));
    expect(showALib1?.memberIds.sort()).toEqual(["e1", "e2"]);
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
    expect(series.allStreams).toHaveLength(2);
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
});
