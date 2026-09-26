import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  ruleMatch: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  },
  ruleSet: {
    findMany: vi.fn(),
  },
  mediaItem: {
    findMany: vi.fn(),
  },
  mediaItemExternalId: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  lifecycleException: {
    findMany: vi.fn(),
  },
  lifecycleAction: {
    deleteMany: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn(),
  },
  // Read by the real `checkLifecycleRuleEvaluability` when a rule set uses
  // `watchedByUser` — see the serverIds scoping test below.
  mediaServer: {
    // `findMany`, not `count`: the guard reports WHICH server is unevidenced
    // and why, so it has to read the rows rather than tally them.
    findMany: vi.fn().mockResolvedValue([]),
  },
  // Detection runs its match writes inside a transaction in two shapes:
  //   - callback form: $transaction(async (tx) => { ... }) (full re-eval)
  //   - array form:    $transaction([p1, p2])              (incremental)
  // Execute both against the same mock so the createMany/deleteMany assertions hold.
  $transaction: vi.fn((arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    }
    if (Array.isArray(arg)) return Promise.all(arg);
    return Promise.resolve(undefined);
  }),
}));

const mockEvaluateRules = vi.hoisted(() => vi.fn());
const mockEvaluateSeriesScope = vi.hoisted(() => vi.fn());
const mockEvaluateMusicScope = vi.hoisted(() => vi.fn());
const mockGroupSeriesResults = vi.hoisted(() => vi.fn());
const mockHasAnyActiveRules = vi.hoisted(() => vi.fn());
const mockHasArrRules = vi.hoisted(() => vi.fn());
const mockHasSeerrRules = vi.hoisted(() => vi.fn());
const mockHasSeriesAggregateRules = vi.hoisted(() => vi.fn());
const mockHasWatchedByUserRules = vi.hoisted(() => vi.fn());
const mockHasPlayActivityRules = vi.hoisted(() => vi.fn());
const mockGetMatchedCriteriaForItems = vi.hoisted(() => vi.fn());
const mockGetActualValuesForAllRules = vi.hoisted(() => vi.fn());
const mockFetchArrMetadata = vi.hoisted(() => vi.fn());
const mockFetchSeerrMetadata = vi.hoisted(() => vi.fn());
const mockHasEnabledArrInstances = vi.hoisted(() => vi.fn());
const mockHasEnabledSeerrInstances = vi.hoisted(() => vi.fn());
const mockSyncCollectionById = vi.hoisted(() => vi.fn());
const mockSyncAllCollections = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rules/lifecycle-engine", () => ({
  evaluateLifecycleRules: mockEvaluateRules,
  evaluateSeriesScope: mockEvaluateSeriesScope,
  evaluateMusicScope: mockEvaluateMusicScope,
  groupSeriesResults: mockGroupSeriesResults,
  hasAnyActiveRules: mockHasAnyActiveRules,
  hasArrRules: mockHasArrRules,
  hasSeerrRules: mockHasSeerrRules,
  hasSeriesAggregateRules: mockHasSeriesAggregateRules,
  hasWatchedByUserRules: mockHasWatchedByUserRules,
  hasPlayActivityRules: mockHasPlayActivityRules,
  getMatchedCriteriaForItems: mockGetMatchedCriteriaForItems,
  getActualValuesForAllRules: mockGetActualValuesForAllRules,
}));
vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: mockFetchArrMetadata,
  hasEnabledArrInstances: mockHasEnabledArrInstances,
  arrFamilyLabel: (type: string) =>
    type === "MOVIE" ? "Radarr" : type === "MUSIC" ? "Lidarr" : "Sonarr",
}));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: mockFetchSeerrMetadata,
  hasEnabledSeerrInstances: mockHasEnabledSeerrInstances,
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollectionById: mockSyncCollectionById,
  syncAllCollections: mockSyncAllCollections,
}));

import { detectAndSaveMatches, runDetection, syncCollectionsAfterDetection } from "@/lib/lifecycle/detect-matches";

function makeRuleSetConfig(overrides: Partial<Parameters<typeof detectAndSaveMatches>[0]> = {}) {
  return {
    id: "rs1",
    name: "Test Rule Set",
    userId: "u1",
    type: "MOVIE" as const,
    rules: [{ field: "title", operator: "contains", value: "test", enabled: true }],
    seriesScope: false,
    serverIds: ["s1"],
    actionEnabled: false,
    actionType: null,
    actionDelayDays: 0,
    arrInstanceId: null,
    addImportExclusion: false,
    addArrTags: [],
    removeArrTags: [],
    stickyMatches: false,
    ...overrides,
  };
}

describe("detectAndSaveMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMatchedCriteriaForItems.mockReturnValue(new Map());
    mockGetActualValuesForAllRules.mockReturnValue(new Map());
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.updateMany.mockResolvedValue({ count: 1 });
  });

  it("returns empty result when no active rules and incremental mode", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);
    // fullReEval defaults to false, so should preserve existing (empty in this case)
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("clears all matches when no active rules and fullReEval is true", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 5 });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"], undefined, undefined, true);

    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({ where: { ruleSetId: "rs1" } });
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("preserves existing matches when no active rules and incremental mode", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { itemData: { id: "item1", title: "Existing" } },
    ]);

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);

    expect(result.items).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it("evaluates MOVIE rules and returns enriched items", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    const items = [
      {
        id: "item1",
        title: "Test Movie",
        parentTitle: null,
        titleSort: "test movie",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ];
    mockEvaluateRules.mockResolvedValue(items);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: "item1",
        title: "Test Movie",
        matchedCriteria: [],
        servers: [{ serverId: "s1", serverName: "Plex", serverType: "PLEX" }],
      }),
    );
  });

  it("evaluates series-scope rules via evaluateSeriesScope", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateSeriesScope.mockResolvedValue([
      {
        id: "item1",
        title: "Episode 1",
        parentTitle: "Series",
        titleSort: "series",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "SERIES", seriesScope: true }),
      ["s1"],
    );

    expect(mockEvaluateSeriesScope).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("excludes a series group when an exception sits on another server's differently-titled copy", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateSeriesScope.mockResolvedValue([
      {
        id: "ep1",
        title: "The Office",
        parentTitle: "The Office",
        seriesKey: "tvdb:73244",
        titleSort: "office",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
      {
        id: "ep9",
        title: "Other Show",
        parentTitle: "Other Show",
        seriesKey: "tvdb:1",
        titleSort: "other",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    // Filed from server B's show page, which titles the show differently.
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "The Office (US)", seriesKey: "tvdb:73244", type: "SERIES" } },
    ]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "SERIES", seriesScope: true, serverIds: ["s1", "s2"] }),
      ["s1", "s2"],
    );

    expect(result.items.map((i) => i.id)).toEqual(["ep9"]);
    const where = mockPrisma.lifecycleException.findMany.mock.calls[0][0].where;
    expect(where.mediaItem.OR).toEqual(
      expect.arrayContaining([{ seriesKey: { in: expect.arrayContaining(["tvdb:73244", "tvdb:1"]) } }]),
    );
  });

  it("keeps a same-titled different show when only the other one is excepted", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateSeriesScope.mockResolvedValue([
      {
        id: "uk1",
        title: "The Office",
        parentTitle: "The Office",
        seriesKey: "tvdb:78107",
        titleSort: "office",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" } },
    ]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "SERIES", seriesScope: true }),
      ["s1"],
    );

    expect(result.items.map((i) => i.id)).toEqual(["uk1"]);
  });

  it("evaluates music-scope rules via evaluateMusicScope", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateMusicScope.mockResolvedValue([
      {
        id: "item1",
        title: "Track 1",
        parentTitle: "Artist",
        titleSort: "artist",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "MUSIC", seriesScope: true }),
      ["s1"],
    );

    expect(mockEvaluateMusicScope).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("groups series results and builds episodeIdMap for non-scope SERIES", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    const rawItems = [
      {
        id: "ep1",
        title: "Ep 1",
        parentTitle: "Show",
        titleSort: "show",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ];
    mockEvaluateRules.mockResolvedValue(rawItems);
    mockGroupSeriesResults.mockReturnValue([
      { id: "grouped1", title: "Show", parentTitle: "Show", titleSort: "show", memberIds: ["ep1"], library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } }, externalIds: [] },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "SERIES", seriesScope: false }),
      ["s1"],
    );

    expect(mockGroupSeriesResults).toHaveBeenCalledWith(rawItems);
    expect(result.episodeIdMap.get("grouped1")).toEqual(["ep1"]);
  });

  it("routes a seriesScope:false SERIES rule with aggregate fields through evaluateSeriesScope", async () => {
    // A series-aggregate field (e.g. episodeCount) cannot be evaluated per
    // episode; it must use the aggregate path even when seriesScope is false,
    // otherwise the aggregate conjunct is silently dropped (over-match).
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasSeriesAggregateRules.mockReturnValue(true);
    mockEvaluateSeriesScope.mockResolvedValue([
      {
        id: "agg1",
        title: "Series",
        parentTitle: "Series",
        titleSort: "series",
        memberIds: ["ep1", "ep2"],
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "SERIES", seriesScope: false }),
      ["s1"],
    );

    expect(mockEvaluateSeriesScope).toHaveBeenCalled();
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("collapses cross-server duplicate matches by resolved Arr id (multi-server)", async () => {
    // The same movie on two servers resolves to ONE Radarr record — without
    // dedup it would schedule two destructive actions and double-count bytes.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "a", title: "Movie", parentTitle: null, titleSort: "movie",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
      {
        id: "b", title: "Movie", parentTitle: null, titleSort: "movie",
        library: { mediaServer: { id: "s2", name: "Jellyfin", type: "JELLYFIN" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const arrData = { "111": { arrId: 42 } } as never;
    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "MOVIE", serverIds: ["s1", "s2"] }),
      ["s1", "s2"],
      arrData,
    );

    expect(result.items).toHaveLength(1);
    expect((result.items[0] as { arrId: number }).arrId).toBe(42);
    const servers = result.items[0].servers as Array<{ serverId: string }>;
    expect(servers.map((s) => s.serverId).sort()).toEqual(["s1", "s2"]);
  });

  it("collapses cross-server duplicates by external id when no Arr metadata was fetched (armed action)", async () => {
    // A Seerr- or play-count-only rule set fetches no Arr data, so every arrId
    // is null — the two copies still resolve to ONE Radarr record.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "a", title: "Movie", parentTitle: null, titleSort: "movie",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
      {
        // The engine omits externalIds when no rule needed them.
        id: "b", title: "Movie", parentTitle: null, titleSort: "movie",
        library: { mediaServer: { id: "s2", name: "Jellyfin", type: "JELLYFIN" } },
      },
    ]);
    mockPrisma.mediaItemExternalId.findMany.mockResolvedValueOnce([{ mediaItemId: "b", externalId: "111" }]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({
        type: "MOVIE",
        serverIds: ["s1", "s2"],
        actionEnabled: true,
        actionType: "DELETE_RADARR",
      }),
      ["s1", "s2"],
    );

    expect(result.items).toHaveLength(1);
    const servers = result.items[0].servers as Array<{ serverId: string }>;
    expect(servers.map((s) => s.serverId).sort()).toEqual(["s1", "s2"]);
    expect(mockPrisma.mediaItemExternalId.findMany).toHaveBeenCalledWith({
      where: { mediaItemId: { in: ["b"] }, source: "TMDB" },
      select: { mediaItemId: true, externalId: true },
    });
  });

  describe("cross-server collapse", () => {
    const copy = (id: string, server: string, extra: Record<string, unknown> = {}) => ({
      id, title: "Movie", parentTitle: null, titleSort: "movie",
      libraryId: `lib-${server}`, ratingKey: `rk-${id}`,
      library: { mediaServer: { id: server, name: server, type: "PLEX" } },
      externalIds: [{ source: "TMDB", externalId: "111" }],
      ...extra,
    });
    const armed = makeRuleSetConfig({
      type: "MOVIE",
      serverIds: ["s1", "s2"],
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });

    beforeEach(() => {
      mockHasAnyActiveRules.mockReturnValue(true);
      mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 0 });
    });

    it("keeps the copy that is already matched, whatever order the engine returns", async () => {
      // An unordered query swaps the copies after a sync rewrites a row. Keyed
      // on "first seen", the match flipped to the other copy: its PENDING
      // action was cancelled and rescheduled, restarting the delay.
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2")]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        { mediaItemId: "b", itemData: { id: "b", servers: [{ serverId: "s1" }, { serverId: "s2" }], copies: [{ id: "a", libraryId: "lib-s1", ratingKey: "rk-a" }] } },
      ]);

      const result = await detectAndSaveMatches(armed, ["s1", "s2"]);

      expect(result.items.map((i) => i.id)).toEqual(["b"]);
      expect(mockPrisma.ruleMatch.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
    });

    it("picks the lowest id when neither copy is matched yet", async () => {
      mockEvaluateRules.mockResolvedValue([copy("b", "s2"), copy("a", "s1")]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([]);

      const result = await detectAndSaveMatches(armed, ["s1", "s2"]);

      expect(result.items.map((i) => i.id)).toEqual(["a"]);
    });

    it("records the collapsed copies so per-copy consumers can still see them", async () => {
      // Plex collections are written per library from each match's
      // libraryId/ratingKey: without the copy, server 2's collection lost it.
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2")]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([]);

      const result = await detectAndSaveMatches(armed, ["s1", "s2"]);

      expect(result.items[0].copies).toEqual([
        { id: "b", libraryId: "lib-s2", ratingKey: "rk-b", title: "Movie", parentTitle: null },
      ]);
      const saved = mockPrisma.ruleMatch.createMany.mock.calls[0][0].data[0].itemData;
      expect(saved.copies).toHaveLength(1);
    });

    it("merges members as distinct episodes — the same episode on two servers is one file", async () => {
      mockEvaluateRules.mockResolvedValue([
        copy("a", "s1", { memberIds: ["a1", "a2"] }),
        copy("b", "s2", { memberIds: ["b1", "b3"] }),
      ]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
        { id: "a1", dedupKey: "series:tvdb:1:s1e1" },
        { id: "a2", dedupKey: "series:tvdb:1:s1e2" },
        { id: "b1", dedupKey: "series:tvdb:1:s1e1" },
        { id: "b3", dedupKey: "series:tvdb:1:s1e3" },
      ]);

      const result = await detectAndSaveMatches(armed, ["s1", "s2"]);

      expect(result.items[0].memberIds).toEqual(["a1", "a2", "b3"]);
      expect(result.episodeIdMap.get("a")).toEqual(["a1", "a2", "b3"]);
      expect(result.episodeIdMap.has("b")).toBe(false);
    });

    it("drops the whole title when an exception sits on ANY copy of it", async () => {
      // Excluding the one merged row filed the exception on its representative;
      // the next run matched the other copy and scheduled a fresh delete.
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2")]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
      mockPrisma.lifecycleException.findMany.mockResolvedValue([
        { mediaItemId: "a", mediaItem: { dedupKey: "movie:tmdb:111" } },
      ]);
      mockPrisma.mediaItem.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);

      const result = await detectAndSaveMatches(armed, ["s1", "s2"]);

      expect(result.items).toEqual([]);
    });

    it("rewrites a held match whose copies changed", async () => {
      // The incremental run never touched a row it already held, so a match
      // made before the second copy appeared never learned of it.
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2")]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        { mediaItemId: "a", itemData: { id: "a", servers: [{ serverId: "s1" }] } },
      ]);

      await detectAndSaveMatches(armed, ["s1", "s2"]);

      // updateMany, not update: a row deleted since it was read (an exception
      // filed meanwhile) must not fail — and roll back — the whole write.
      expect(mockPrisma.ruleMatch.updateMany).toHaveBeenCalledTimes(1);
      const arg = mockPrisma.ruleMatch.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ ruleSetId: "rs1", mediaItemId: "a" });
      expect(arg.data.itemData.copies).toHaveLength(1);
      expect(arg.data.copyIds).toEqual(["b"]);
      expect(mockPrisma.ruleMatch.createMany).not.toHaveBeenCalled();
    });

    it("tolerates a refreshed match that was deleted concurrently", async () => {
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2"), copy("c", "s1", { externalIds: [{ source: "TMDB", externalId: "222" }] })]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        { mediaItemId: "a", itemData: { id: "a", servers: [{ serverId: "s1" }] } },
      ]);
      mockPrisma.ruleMatch.updateMany.mockResolvedValue({ count: 0 });

      await detectAndSaveMatches(armed, ["s1", "s2"]);

      // The new match is still written.
      expect(mockPrisma.ruleMatch.createMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.ruleMatch.createMany.mock.calls[0][0].data.map((d: { mediaItemId: string }) => d.mediaItemId)).toEqual(["c"]);
    });

    it("writes copyIds with every new collapsed match", async () => {
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2")]);

      await detectAndSaveMatches(armed, ["s1", "s2"]);

      const data = mockPrisma.ruleMatch.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].mediaItemId).toBe("a");
      expect(data[0].copyIds).toEqual(["b"]);
    });

    describe("carry-over when the kept copy stops matching", () => {
      const held = {
        mediaItemId: "a",
        itemData: {
          id: "a",
          servers: [{ serverId: "s1" }, { serverId: "s2" }],
          copies: [{ id: "b", libraryId: "lib-s2", ratingKey: "rk-b", title: "Movie", parentTitle: null }],
        },
      };

      it("moves the match and its PENDING action to the copy instead of re-creating it", async () => {
        mockEvaluateRules.mockResolvedValue([copy("b", "s2")]);
        mockPrisma.ruleMatch.findMany.mockResolvedValue([held]);
        mockPrisma.lifecycleAction.findMany.mockResolvedValue([
          { id: "act1", mediaItemId: "a", matchedMediaItemIds: [] },
        ]);

        const result = await detectAndSaveMatches(armed, ["s1", "s2"]);

        expect(result.items.map((i) => i.id)).toEqual(["b"]);
        expect(mockPrisma.ruleMatch.createMany).not.toHaveBeenCalled();
        expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.ruleMatch.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { ruleSetId: "rs1", mediaItemId: "a" },
            data: expect.objectContaining({ mediaItemId: "b", copyIds: [] }),
          }),
        );
        expect(mockPrisma.lifecycleAction.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { ruleSetId: "rs1", status: "PENDING", mediaItemId: { in: ["a"] } },
          }),
        );
        expect(mockPrisma.lifecycleAction.updateMany).toHaveBeenCalledWith({
          where: { id: "act1", status: "PENDING" },
          data: {
            mediaItemId: "b",
            mediaItemTitle: "Movie",
            mediaItemParentTitle: null,
            matchedMediaItemIds: [],
          },
        });
      });

      it("keeps one match on a sticky rule set rather than holding both copies", async () => {
        mockEvaluateRules.mockResolvedValue([copy("b", "s2")]);
        mockPrisma.ruleMatch.findMany.mockResolvedValue([held]);

        const result = await detectAndSaveMatches({ ...armed, stickyMatches: true }, ["s1", "s2"]);

        expect(result.items.map((i) => i.id)).toEqual(["b"]);
        expect(mockPrisma.ruleMatch.createMany).not.toHaveBeenCalled();
      });

      it("re-expresses a member-scoped action as the new copy's members of the same episodes", async () => {
        mockEvaluateRules.mockResolvedValue([copy("b", "s2", { memberIds: ["b1", "b2", "b3"] })]);
        mockPrisma.ruleMatch.findMany.mockResolvedValue([held]);
        mockPrisma.lifecycleAction.findMany.mockResolvedValue([
          { id: "act1", mediaItemId: "a", matchedMediaItemIds: ["a1", "a2"] },
        ]);
        mockPrisma.mediaItem.findMany.mockResolvedValue([
          { id: "a1", dedupKey: "ep:1" },
          { id: "a2", dedupKey: "ep:2" },
          { id: "b1", dedupKey: "ep:1" },
          { id: "b2", dedupKey: "ep:2" },
          { id: "b3", dedupKey: "ep:3" },
        ]);

        await detectAndSaveMatches(armed, ["s1", "s2"]);

        const arg = mockPrisma.lifecycleAction.updateMany.mock.calls[0][0];
        expect(arg.data.mediaItemId).toBe("b");
        // Episode 3 was never scheduled; it is not added by the move.
        expect(arg.data.matchedMediaItemIds).toEqual(["b1", "b2"]);
      });

      it("does not carry onto a copy that already holds its own match", async () => {
        mockEvaluateRules.mockResolvedValue([copy("b", "s2")]);
        mockPrisma.ruleMatch.findMany.mockResolvedValue([
          held,
          { mediaItemId: "b", itemData: { id: "b", servers: [{ serverId: "s2" }] } },
        ]);

        await detectAndSaveMatches(armed, ["s1", "s2"]);

        expect(mockPrisma.ruleMatch.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: { ruleSetId: "rs1", mediaItemId: "a" } }),
        );
        expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({
          where: { ruleSetId: "rs1", mediaItemId: { in: ["a"] } },
        });
      });

      it("carries over on a full re-evaluation too", async () => {
        mockEvaluateRules.mockResolvedValue([copy("b", "s2")]);
        mockPrisma.ruleMatch.findMany.mockResolvedValue([held]);
        mockPrisma.lifecycleAction.findMany.mockResolvedValue([
          { id: "act1", mediaItemId: "a", matchedMediaItemIds: [] },
        ]);

        await detectAndSaveMatches(armed, ["s1", "s2"], undefined, undefined, true);

        expect(mockPrisma.lifecycleAction.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "act1", status: "PENDING" } }),
        );
      });
    });

    it("leaves a held match alone when nothing it derives changed", async () => {
      mockEvaluateRules.mockResolvedValue([copy("a", "s1"), copy("b", "s2")]);
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        {
          mediaItemId: "a",
          itemData: {
            id: "a",
            servers: [{ serverId: "s2" }, { serverId: "s1" }],
            copies: [{ id: "b", libraryId: "lib-s2", ratingKey: "rk-b", title: "Movie", parentTitle: null }],
          },
        },
      ]);

      await detectAndSaveMatches(armed, ["s1", "s2"]);

      expect(mockPrisma.ruleMatch.updateMany).not.toHaveBeenCalled();
    });
  });

  it("keeps one match per server copy without Arr metadata when no action is armed", async () => {
    // Collection-only rule sets feed a per-server Plex collection.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "a", title: "Movie", parentTitle: null, titleSort: "movie",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
      {
        id: "b", title: "Movie", parentTitle: null, titleSort: "movie",
        library: { mediaServer: { id: "s2", name: "Plex 2", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 2 });

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ type: "MOVIE", serverIds: ["s1", "s2"] }),
      ["s1", "s2"],
    );

    expect(result.items).toHaveLength(2);
  });

  it("filters out excluded items via LifecycleException", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "item1",
        title: "Movie 1",
        parentTitle: null,
        titleSort: "movie 1",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
      {
        id: "item2",
        title: "Movie 2",
        parentTitle: null,
        titleSort: "movie 2",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItemId: "item1" },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("item2");
  });

  it("performs full re-evaluation via transaction", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "item1",
        title: "Movie",
        parentTitle: null,
        titleSort: "movie",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [],
      },
    ]);
    // Full re-eval uses the callback form; handle the array form too so this
    // override (which persists across clearAllMocks) doesn't break the
    // incremental array-form tests that run after it.
    mockPrisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => Promise<unknown>)({
          ruleMatch: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        });
      }
      if (Array.isArray(arg)) return Promise.all(arg);
      return Promise.resolve(undefined);
    });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"], undefined, undefined, true);

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("removes stale matches in incremental mode", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([]); // nothing matches now
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { mediaItemId: "old-item", itemData: { id: "old-item", title: "Old" } },
    ]);
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);

    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", mediaItemId: { in: ["old-item"] } },
    });
    expect(result.items).toHaveLength(0);
  });

  it("preserves stale matches when stickyMatches is true", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([]); // nothing matches now
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { mediaItemId: "old-item", itemData: { id: "old-item", title: "Sticky" } },
    ]);

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ stickyMatches: true }),
      ["s1"],
    );

    expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Sticky");
  });

  it("resolves arrId from external IDs", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "item1",
        title: "Movie",
        parentTitle: null,
        titleSort: "movie",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "12345" }],
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });

    const arrData = { "12345": { arrId: 42, tags: [], monitored: true } } as Record<string, unknown>;

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"], arrData as never);

    expect(result.items[0].arrId).toBe(42);
  });

  it("sorts enriched items by title", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      { id: "b", title: "Zebra", parentTitle: null, titleSort: "zebra", library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } }, externalIds: [] },
      { id: "a", title: "Apple", parentTitle: null, titleSort: "apple", library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } }, externalIds: [] },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 2 });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);

    expect(result.items[0].title).toBe("Apple");
    expect(result.items[1].title).toBe("Zebra");
  });
});

describe("runDetection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMatchedCriteriaForItems.mockReturnValue(new Map());
    mockGetActualValuesForAllRules.mockReturnValue(new Map());
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    // Default: instances exist — individual tests flip these to exercise the
    // no-instance match-all guard.
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
  });

  it("returns empty results when no enabled rule sets", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValue([]);

    const results = await runDetection("u1");

    expect(results).toEqual([]);
  });

  it("skips rule sets with no valid servers", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        rules: [{ field: "title", operator: "contains", value: "test", enabled: true }],
        seriesScope: false,
        serverIds: ["non-existent"],
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        addImportExclusion: false,
        addArrTags: [],
        removeArrTags: [],
        collectionEnabled: false,
        collectionName: null,
        stickyMatches: false,
        user: { mediaServers: [{ id: "other" }] },
      },
    ]);

    const results = await runDetection("u1");

    expect(results).toEqual([]);
  });

  it("caches Arr metadata across rule sets of same type", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(false);
    mockFetchArrMetadata.mockResolvedValue({ "123": { arrId: 1 } });
    mockEvaluateRules.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);

    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1", userId: "u1", name: "Test 1", type: "MOVIE",
        rules: [{ field: "arrMonitored", operator: "equals", value: "true", enabled: true }],
        seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null,
        actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
        addArrTags: [], removeArrTags: [], collectionEnabled: false, collectionName: null,
        stickyMatches: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
      {
        id: "rs2", userId: "u1", name: "Test 2", type: "MOVIE",
        rules: [{ field: "arrMonitored", operator: "equals", value: "false", enabled: true }],
        seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null,
        actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
        addArrTags: [], removeArrTags: [], collectionEnabled: false, collectionName: null,
        stickyMatches: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await runDetection("u1");

    // fetchArrMetadata should only be called once for MOVIE type
    expect(mockFetchArrMetadata).toHaveBeenCalledTimes(1);
  });

  it("isolates a Seerr fetch failure to the rule sets that need it", async () => {
    // One unreachable Seerr used to abort "Re-evaluate All" midway: later rule
    // sets were never evaluated, even those with no Seerr criteria.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockImplementation((rules: Array<{ field: string }>) =>
      rules.some((r) => r.field.startsWith("seerr")),
    );
    mockFetchSeerrMetadata.mockRejectedValue(new Error("Seerr unreachable"));
    mockEvaluateRules.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    const base = {
      userId: "u1", type: "MOVIE", seriesScope: false, serverIds: ["s1"], actionEnabled: false,
      actionType: null, actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
      addArrTags: [], removeArrTags: [], collectionId: null, stickyMatches: false,
      user: { mediaServers: [{ id: "s1" }] },
    };
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      { ...base, id: "rs1", name: "Seerr A", rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }] },
      { ...base, id: "rs2", name: "Seerr B", rules: [{ field: "seerrRequestCount", operator: "equals", value: "0", enabled: true }] },
      { ...base, id: "rs3", name: "Plain", rules: [{ field: "title", operator: "contains", value: "x", enabled: true }] },
    ]);

    const failures: Array<{ ruleSetId: string; name: string; reason: string }> = [];
    const results = await runDetection("u1", undefined, false, failures);

    expect(results.map((r) => r.ruleSet.id)).toEqual(["rs3"]);
    // Both Seerr rule sets are reported, so the caller can say so.
    expect(failures).toEqual([
      { ruleSetId: "rs1", name: "Seerr A", reason: "Detection failed: Seerr unreachable" },
      { ruleSetId: "rs2", name: "Seerr B", reason: "Detection failed: Seerr unreachable" },
    ]);
    // The failed fetch is remembered — the second Seerr rule set doesn't re-walk.
    expect(mockFetchSeerrMetadata).toHaveBeenCalledTimes(1);
  });

  it("surfaces a fetch failure when running a single rule set", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);
    mockFetchSeerrMetadata.mockRejectedValue(new Error("Seerr unreachable"));
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1", userId: "u1", name: "Seerr", type: "MOVIE",
        rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
        seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null,
        actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
        addArrTags: [], removeArrTags: [], collectionId: null, stickyMatches: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await expect(runDetection("u1", "rs1")).rejects.toThrow("Seerr unreachable");
  });

  it("skips rule sets with Arr rules when no enabled Arr instance exists (match-all guard)", async () => {
    // fetchArrMetadata would return {} and "foundInArr = false" would match
    // the whole library — the rule set must be skipped, not evaluated.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(false);
    mockHasEnabledArrInstances.mockResolvedValue(false);

    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1", userId: "u1", name: "Orphans", type: "MOVIE",
        rules: [{ field: "foundInArr", operator: "equals", value: "false", enabled: true }],
        seriesScope: false, serverIds: ["s1"], actionEnabled: true, actionType: "DELETE_RADARR",
        actionDelayDays: 0, arrInstanceId: "radarr1", addImportExclusion: false,
        addArrTags: [], removeArrTags: [], collectionId: null,
        stickyMatches: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    const results = await runDetection("u1");

    expect(results).toEqual([]);
    expect(mockFetchArrMetadata).not.toHaveBeenCalled();
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    // Existing matches must be left untouched — this is a skip, not a clear.
    expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
  });

  it("skips rule sets with Seerr rules when no enabled Seerr instance exists (match-all guard)", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(false);

    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1", userId: "u1", name: "Unrequested", type: "MOVIE",
        rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
        seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null,
        actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
        addArrTags: [], removeArrTags: [], collectionId: null,
        stickyMatches: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    const results = await runDetection("u1");

    expect(results).toEqual([]);
    expect(mockFetchSeerrMetadata).not.toHaveBeenCalled();
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("skips AND DISARMS MUSIC rule sets with Seerr rules (permanently unevaluable)", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 10 });

    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1", userId: "u1", name: "Music seerr", type: "MUSIC",
        rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
        seriesScope: true, serverIds: ["s1"], actionEnabled: false, actionType: null,
        actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
        addArrTags: [], removeArrTags: [], collectionId: null,
        stickyMatches: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    const results = await runDetection("u1");

    expect(results).toEqual([]);
    expect(mockEvaluateMusicScope).not.toHaveBeenCalled();
    // Permanently unevaluable → vacuous matches + armed actions are disarmed
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", status: "PENDING" },
    });
    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({ where: { ruleSetId: "rs1" } });
  });


  it("scopes the evaluability check to the rule set's own servers", async () => {
    // `processLifecycleRules` (the scheduled path) passes `serverIds`; this
    // manual "Re-evaluate All" path did not. The watch-history half of the
    // check is scoped by it, so without it the two paths gave DIFFERENT answers
    // for the same rule set — one unrelated server part-way through its
    // Tracearr import made manual re-evaluation refuse rule sets the scheduler
    // was happily running, with nothing in the UI to explain why.
    // The guard triggers on ANY play-activity field now, not just watchedByUser.
    mockHasPlayActivityRules.mockReturnValue(true);
    mockPrisma.mediaServer.findMany.mockResolvedValue([]);
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        rules: [{ field: "watchedByUser", operator: "notEquals", value: "alice", enabled: true }],
        seriesScope: false,
        serverIds: ["s1", "s-disabled"],
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        addImportExclusion: false,
        addArrTags: [],
        removeArrTags: [],
        collectionEnabled: false,
        collectionName: null,
        stickyMatches: false,
        // `s-disabled` is not among the user's servers, so it is filtered out
        // before the check — the scope passed is the INTERSECTION, exactly what
        // detection will actually read.
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);

    await runDetection("u1");

    expect(mockPrisma.mediaServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["s1"] } }),
      }),
    );
  });
});

describe("detectAndSaveMatches evaluability defense-in-depth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMatchedCriteriaForItems.mockReturnValue(new Map());
    mockGetActualValuesForAllRules.mockReturnValue(new Map());
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
  });

  it("refuses to evaluate directly-called rule sets whose Arr instances are unavailable", async () => {
    // The choke point: even a caller that forgets the pre-check cannot make
    // detectAndSaveMatches evaluate arr rules against an empty metadata map.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(false);
    mockHasEnabledArrInstances.mockResolvedValue(false);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { itemData: { id: "item1", title: "Existing Match" } },
    ]);

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({
        rules: [{ field: "foundInArr", operator: "equals", value: "false", enabled: true }],
      }),
      ["s1"],
      {}, // empty ArrDataMap — exactly the vacuous input the guard must refuse
      undefined,
      false,
    );

    // Existing matches preserved, nothing evaluated, nothing written
    expect(result.count).toBe(1);
    expect(result.items[0]).toEqual({ id: "item1", title: "Existing Match" });
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(mockPrisma.ruleMatch.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
  });
});

describe("syncCollectionsAfterDetection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs only the targeted rule set's collection(s) when a ruleSetId is given", async () => {
    mockSyncCollectionById.mockResolvedValue(undefined);

    await syncCollectionsAfterDetection("u1", "rs1", [
      { ruleSet: { collectionId: "col1" } },
      { ruleSet: { collectionId: null } },
    ]);

    expect(mockSyncCollectionById).toHaveBeenCalledTimes(1);
    expect(mockSyncCollectionById).toHaveBeenCalledWith("col1", expect.anything());
    expect(mockSyncAllCollections).not.toHaveBeenCalled();
  });

  it("syncs every collection for a full run (no ruleSetId)", async () => {
    mockSyncAllCollections.mockResolvedValue(undefined);

    await syncCollectionsAfterDetection("u1", undefined, [
      { ruleSet: { collectionId: "col1" } },
    ]);

    expect(mockSyncAllCollections).toHaveBeenCalledWith("u1", expect.anything());
    expect(mockSyncCollectionById).not.toHaveBeenCalled();
  });

  it("does not throw when a collection sync fails", async () => {
    mockSyncCollectionById.mockRejectedValue(new Error("Plex fail"));

    await expect(
      syncCollectionsAfterDetection("u1", "rs1", [{ ruleSet: { collectionId: "col1" } }]),
    ).resolves.toBeUndefined();
  });
});
