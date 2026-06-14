import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  ruleMatch: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  ruleSet: {
    findMany: vi.fn(),
  },
  mediaItem: {
    findMany: vi.fn(),
  },
  lifecycleException: {
    findMany: vi.fn(),
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
const mockGetMatchedCriteriaForItems = vi.hoisted(() => vi.fn());
const mockGetActualValuesForAllRules = vi.hoisted(() => vi.fn());
const mockFetchArrMetadata = vi.hoisted(() => vi.fn());
const mockFetchSeerrMetadata = vi.hoisted(() => vi.fn());
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
  getMatchedCriteriaForItems: mockGetMatchedCriteriaForItems,
  getActualValuesForAllRules: mockGetActualValuesForAllRules,
}));
vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: mockFetchArrMetadata,
}));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: mockFetchSeerrMetadata,
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
