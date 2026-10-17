import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  resolveStatsScope: vi.fn(),
  computeLibraryStats: vi.fn(),
  computeBreakdown: vi.fn(),
  computeCrossTab: vi.fn(),
  computeTimeline: vi.fn(),
  computeWatchTrends: vi.fn(),
  computeWatchLeaderboard: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/media/stats-scope", () => ({ resolveStatsScope: m.resolveStatsScope }));
vi.mock("@/lib/media/library-stats", () => ({ computeLibraryStats: m.computeLibraryStats }));
vi.mock("@/lib/media/breakdown", () => ({ computeBreakdown: m.computeBreakdown }));
vi.mock("@/lib/media/cross-tab", () => ({ computeCrossTab: m.computeCrossTab }));
vi.mock("@/lib/media/timeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media/timeline")>()),
  computeTimeline: m.computeTimeline,
}));
vi.mock("@/lib/media/watch-analytics", () => ({
  computeWatchTrends: m.computeWatchTrends,
  computeWatchLeaderboard: m.computeWatchLeaderboard,
}));
vi.mock("@/lib/query/query-engine", () => ({ executeQuery: m.executeQuery }));

import { getAiToolMap, getAiTools } from "@/lib/ai/tools";

const tools = getAiToolMap();
function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute("u1", args);
}

const SCOPE = { serverIds: ["s1"], dedupEnabled: false };
const NO_SERVERS_NOTE = "No media servers are connected yet, so there's nothing to analyze.";

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.resolveStatsScope.mockResolvedValue(SCOPE);
});

describe("tool registry", () => {
  it("exposes the seven read-only tools", () => {
    expect(getAiTools().map((t) => t.definition.name)).toEqual([
      "get_library_overview",
      "get_breakdown",
      "get_cross_tab",
      "get_timeline",
      "search_media",
      "get_watch_trends",
      "get_watch_leaderboard",
    ]);
  });
});

describe("no connected servers", () => {
  it.each([
    ["server-not-found"],
    [{ serverIds: [], dedupEnabled: false }],
  ])("every tool answers with the no-servers note (%o)", async (scopeResult) => {
    m.resolveStatsScope.mockResolvedValue(scopeResult);
    const calls: [string, Record<string, unknown>][] = [
      ["get_library_overview", {}],
      ["get_breakdown", { dimension: "resolution" }],
      ["get_cross_tab", { dimension1: "resolution", dimension2: "videoCodec" }],
      ["get_timeline", { dateField: "addedAt" }],
      ["search_media", {}],
      ["get_watch_trends", {}],
      ["get_watch_leaderboard", { groupBy: "user" }],
    ];
    for (const [name, args] of calls) {
      const result = await run(name, args);
      expect(result.data, name).toEqual({ note: NO_SERVERS_NOTE });
      expect(result.evidence, name).toBeUndefined();
    }
    expect(m.computeLibraryStats).not.toHaveBeenCalled();
    expect(m.executeQuery).not.toHaveBeenCalled();
  });
});

describe("get_library_overview", () => {
  it("summarises counts, GB sizes and top lists", async () => {
    m.computeLibraryStats.mockResolvedValue({
      movieCount: 2, seriesCount: 1, seasonCount: 3, episodeCount: 10,
      artistCount: 0, albumCount: 0, musicCount: 0,
      totalSize: "3500000000", movieSize: BigInt(2_000_000_000), seriesSize: null, musicSize: undefined,
      qualityBreakdown: [
        { resolution: "1080", type: "MOVIE", _count: 2 },
        { resolution: "1080", type: "SERIES", _count: 5 },
        { resolution: null, type: "SERIES", _count: 1 },
      ],
      videoCodecBreakdown: [{ videoCodec: "hevc", type: "MOVIE", _count: 2 }],
      genreBreakdown: Array.from({ length: 12 }, (_, i) => ({ value: `G${i}`, _count: 12 - i })),
      topMovies: [{ title: "Heat", playCount: 4 }],
      topSeries: [{ parentTitle: "Lost", totalPlays: 9 }],
    });
    const result = await run("get_library_overview");
    const data = result.data as Record<string, unknown>;
    expect(m.computeLibraryStats).toHaveBeenCalledWith(["s1"], false);
    expect(data.counts).toEqual({ movies: 2, series: 1, seasons: 3, episodes: 10, artists: 0, albums: 0, tracks: 0 });
    expect(data.storageGB).toEqual({ total: 3.5, movies: 2, series: 0, music: 0 });
    expect(data.topResolutions).toEqual([{ value: "1080", count: 7 }, { value: "Unknown", count: 1 }]);
    expect(data.topVideoCodecs).toEqual([{ value: "hevc", count: 2 }]);
    // The ten largest of twelve, in the order the stats came back.
    expect(data.topGenres).toEqual(Array.from({ length: 10 }, (_, i) => ({ value: `G${i}`, count: 12 - i })));
    expect(data.topPlayedMovies).toEqual([{ title: "Heat", plays: 4 }]);
    expect(data.topPlayedSeries).toEqual([{ title: "Lost", plays: 9 }]);
    expect(result.evidence).toEqual({ tool: "get_library_overview", kind: "overview", title: "Library overview", data });
  });
});

describe("get_breakdown", () => {
  it("refuses an unknown dimension before touching the scope", async () => {
    const result = await run("get_breakdown", { dimension: "mood" });
    expect((result.data as { error: string }).error).toMatch(/^Unknown dimension/);
    expect(m.resolveStatsScope).not.toHaveBeenCalled();
  });

  it("filters to a valid media type and ignores an invalid one", async () => {
    const rows = [
      { value: "4K", type: "MOVIE", _count: 3 },
      { value: "4K", type: "SERIES", _count: 4 },
      { value: null, type: "MOVIE", _count: 1 },
    ];
    m.computeBreakdown.mockResolvedValue(rows);
    const movies = await run("get_breakdown", { dimension: "resolution", mediaType: "MOVIE" });
    expect(movies.data).toEqual({ dimension: "Resolution", rows: [{ value: "4K", count: 3 }, { value: "Unknown", count: 1 }] });
    expect(movies.evidence?.title).toBe("Resolution distribution");

    const all = await run("get_breakdown", { dimension: "resolution", mediaType: "BOOKS" });
    expect((all.data as { rows: unknown[] }).rows).toEqual([{ value: "4K", count: 7 }, { value: "Unknown", count: 1 }]);
  });
});

describe("get_cross_tab", () => {
  it.each([
    [{ dimension1: "mood", dimension2: "resolution" }, /^Unknown dimension/],
    [{ dimension2: "resolution" }, /^Unknown dimension/],
    [{ dimension1: "resolution", dimension2: "resolution" }, /must be different/],
    [{ dimension1: "audioLanguage", dimension2: "subtitleLanguage" }, /Cannot cross two stream dimensions/],
  ])("refuses %o", async (args, error) => {
    const result = await run("get_cross_tab", args);
    expect((result.data as { error: string }).error).toMatch(error);
    expect(m.computeCrossTab).not.toHaveBeenCalled();
  });

  it("merges rows per combination, labelling nulls Unknown, sorted by count", async () => {
    m.computeCrossTab.mockResolvedValue([
      { dim1: "4K", dim2: "hevc", _count: 2 },
      { dim1: "4K", dim2: "hevc", _count: 3 },
      { dim1: null, dim2: null, _count: 9 },
      { dim1: "1080", dim2: "h264", _count: 1 },
    ]);
    const result = await run("get_cross_tab", { dimension1: "resolution", dimension2: "videoCodec" });
    expect(result.data).toEqual({
      dimension1: "Resolution",
      dimension2: "Video Codec",
      rows: [
        { dim1: "Unknown", dim2: "Unknown", count: 9 },
        { dim1: "4K", dim2: "hevc", count: 5 },
        { dim1: "1080", dim2: "h264", count: 1 },
      ],
    });
    expect(result.evidence?.title).toBe("Resolution × Video Codec");
  });
});

describe("get_timeline", () => {
  it("refuses an invalid date field and bad breakdowns", async () => {
    expect((await run("get_timeline", { dateField: "year" })).data).toMatchObject({ error: expect.stringMatching(/^Invalid dateField/) });
    expect((await run("get_timeline", { dateField: "addedAt", breakdown: "mood" })).data).toEqual({
      error: "Unknown breakdown dimension.",
    });
    expect((await run("get_timeline", { dateField: "addedAt", breakdown: "lastPlayedAt" })).data).toEqual({
      error: "Cannot use a date dimension as the breakdown.",
    });
    expect(m.computeTimeline).not.toHaveBeenCalled();
  });

  it("applies defaults for missing options and keeps only the last 400 points", async () => {
    m.computeTimeline.mockResolvedValue({
      series: [],
      points: Array.from({ length: 450 }, (_, i) => ({ bucket: i })),
    });
    const result = await run("get_timeline", { dateField: "addedAt", bin: "fortnight", measure: "weight", mediaType: "X" });
    expect(m.computeTimeline).toHaveBeenCalledWith({
      dateField: "addedAt",
      bin: "month",
      measure: "count",
      breakdownMeta: null,
      serverIds: ["s1"],
      typeFilter: null,
      topN: null,
      dedupEnabled: false,
    });
    const data = result.data as { points: { bucket: number }[] };
    expect(data.points).toHaveLength(400);
    expect(data.points[0].bucket).toBe(50);
    expect(result.evidence?.title).toBe("Timeline by addedAt");
  });

  it("passes the chosen options, breakdown and a clamped topN", async () => {
    m.computeTimeline.mockResolvedValue({ series: ["4K"], points: [] });
    await run("get_timeline", {
      dateField: "lastPlayedAt",
      bin: "year",
      measure: "size",
      mediaType: "SERIES",
      breakdown: "resolution",
      topN: 99,
    });
    const params = m.computeTimeline.mock.calls[0][0];
    expect(params).toMatchObject({ bin: "year", measure: "size", typeFilter: "SERIES", topN: 20 });
    expect(params.breakdownMeta.id).toBe("resolution");
  });
});

describe("search_media", () => {
  const item = (over: Record<string, unknown>) => ({
    title: "T", parentTitle: null, year: null, type: "MOVIE", resolution: null, videoCodec: null,
    audioCodec: null, dynamicRange: null, container: null, fileSize: null, playCount: null,
    lastPlayedAt: null, studio: null, dedupKey: null, ...over,
  });

  it.each([
    [{ filters: [{ field: "arrTag", operator: "equals", value: "x" }] }, /Field "arrTag" is not available/],
    [{ filters: [{ field: "title", operator: "approximately", value: "x" }] }, /Operator "approximately" is invalid/],
    [{ filters: [{ field: "title", operator: "equals", value: "" }] }, /requires a value/],
    [{ filters: [{ field: "title", operator: "equals" }] }, /requires a value/],
    [{ filters: [{}] }, /Field "" is not available/],
  ])("refuses %o", async (args, error) => {
    const result = await run("search_media", args);
    expect((result.data as { error: string }).error).toMatch(error);
    expect(m.executeQuery).not.toHaveBeenCalled();
  });

  it("builds a query definition from filters and maps items", async () => {
    m.executeQuery.mockResolvedValue({
      items: [item({ title: "Big", fileSize: "12345000000", playCount: 0, year: 2001, studio: "S" })],
      pagination: { hasMore: true },
    });
    const result = await run("search_media", {
      mediaTypes: ["MOVIE", "BOOK"],
      filters: [
        { field: "playCount", operator: "equals", value: 0 },
        { field: "title", operator: "isNull", value: "ignored" },
        { field: "year", operator: "greaterThan", value: 2000 },
      ],
      match: "any",
      sortBy: "fileSize",
      sortOrder: "desc",
      limit: 500,
    });
    const [definition, userId, page, limit] = m.executeQuery.mock.calls[0];
    expect(userId).toBe("u1");
    expect(page).toBe(1);
    expect(limit).toBe(50);
    expect(definition).toEqual({
      mediaTypes: ["MOVIE"],
      serverIds: [],
      groups: [
        {
          id: "g",
          condition: "AND",
          groups: [],
          rules: [
            { id: "r0", field: "playCount", operator: "equals", value: 0, condition: "OR" },
            { id: "r1", field: "title", operator: "isNull", value: "", condition: "OR" },
            { id: "r2", field: "year", operator: "greaterThan", value: 2000, condition: "OR" },
          ],
        },
      ],
      sortBy: "fileSize",
      sortOrder: "desc",
      includeEpisodes: false,
    });
    expect(result.data).toEqual({
      count: 1,
      hasMore: true,
      items: [
        {
          title: "Big", parentTitle: undefined, year: 2001, type: "MOVIE", resolution: undefined,
          videoCodec: undefined, audioCodec: undefined, dynamicRange: undefined, container: undefined,
          sizeGB: 12.35, playCount: 0, lastPlayedAt: undefined, studio: "S",
        },
      ],
    });
  });

  it("uses defaults and stringifies non-numeric values", async () => {
    m.executeQuery.mockResolvedValue({ items: [], pagination: { hasMore: false } });
    await run("search_media", {
      mediaTypes: "MOVIE",
      filters: [{ field: "title", operator: "contains", value: true }],
      sortBy: "",
      limit: "abc",
    });
    const [definition, , , limit] = m.executeQuery.mock.calls[0];
    expect(limit).toBe(25);
    expect(definition.mediaTypes).toEqual([]);
    expect(definition.sortBy).toBe("title");
    expect(definition.sortOrder).toBe("asc");
    expect(definition.groups[0].rules[0]).toMatchObject({ value: "true", condition: "AND" });
  });

  it("sends no groups without filters and caps filters at twenty", async () => {
    m.executeQuery.mockResolvedValue({ items: [], pagination: { hasMore: false } });
    await run("search_media", { filters: "nope" });
    expect(m.executeQuery.mock.calls[0][0].groups).toEqual([]);

    const many = Array.from({ length: 25 }, () => ({ field: "title", operator: "contains", value: "a" }));
    await run("search_media", { filters: many });
    expect(m.executeQuery.mock.calls[1][0].groups[0].rules).toHaveLength(20);
  });

  it("over-fetches and collapses dedupKey twins when dedup is on", async () => {
    m.resolveStatsScope.mockResolvedValue({ serverIds: ["s1", "s2"], dedupEnabled: true });
    m.executeQuery.mockResolvedValue({
      items: [
        item({ title: "A", dedupKey: "k1" }),
        item({ title: "A (copy)", dedupKey: "k1" }),
        item({ title: "B", dedupKey: null }),
        item({ title: "C", dedupKey: "" }),
        item({ title: "D", dedupKey: "k2" }),
      ],
      pagination: { hasMore: false },
    });
    const result = await run("search_media", { limit: 2 });
    expect(m.executeQuery.mock.calls[0][3]).toBe(6);
    expect(result.data).toMatchObject({ count: 2, hasMore: true });
    expect((result.data as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("reports hasMore false when the deduped set fits", async () => {
    m.resolveStatsScope.mockResolvedValue({ serverIds: ["s1"], dedupEnabled: true });
    m.executeQuery.mockResolvedValue({ items: [item({ dedupKey: "k" })], pagination: { hasMore: false } });
    const result = await run("search_media", { limit: 100 });
    expect(m.executeQuery.mock.calls[0][3]).toBe(150);
    expect(result.data).toMatchObject({ count: 1, hasMore: false });
  });
});

describe("watch analytics tools", () => {
  it("get_watch_trends clamps the window and limit and labels the type", async () => {
    m.computeWatchTrends.mockResolvedValue([{ title: "X", plays: 3 }]);
    const all = await run("get_watch_trends", { days: 0, limit: 1000 });
    expect(m.computeWatchTrends).toHaveBeenCalledWith(["s1"], { mediaType: undefined, days: 1, limit: 100 });
    expect(all.data).toEqual({ days: 1, mediaType: "all", rows: [{ title: "X", plays: 3 }] });
    expect(all.evidence?.title).toBe("Most-played (last 1 days)");

    const series = await run("get_watch_trends", { mediaType: "SERIES", days: "7" });
    expect(m.computeWatchTrends).toHaveBeenLastCalledWith(["s1"], { mediaType: "SERIES", days: 7, limit: 10 });
    expect(series.data).toMatchObject({ mediaType: "SERIES", days: 7 });
  });

  it("get_watch_leaderboard refuses an unknown grouping and defaults the window", async () => {
    expect((await run("get_watch_leaderboard", { groupBy: "country" })).data).toEqual({
      error: "groupBy must be one of: user, device, platform.",
    });
    m.computeWatchLeaderboard.mockResolvedValue([]);
    for (const groupBy of ["user", "device", "platform"]) {
      const result = await run("get_watch_leaderboard", { groupBy, days: Number.NaN });
      expect(result.data).toEqual({ groupBy, days: 30, rows: [] });
      expect(result.evidence?.title).toBe(`Top ${groupBy}s (last 30 days)`);
    }
    expect(m.computeWatchLeaderboard).toHaveBeenCalledWith(["s1"], { groupBy: "platform", days: 30, limit: 15 });
  });
});
