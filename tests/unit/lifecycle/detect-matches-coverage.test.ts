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
  hasCustomFormatScoreRules: () => false,
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
  resolveArrInstanceScope: vi.fn().mockResolvedValue(null),
  arrFamilyLabel: (type: string) =>
    type === "MOVIE" ? "Radarr" : type === "MUSIC" ? "Lidarr" : "Sonarr",
}));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: mockFetchSeerrMetadata,
  // One walk for every type a run needs; delegated per type so each
  // test can keep stubbing the per-type answer.
  fetchSeerrMetadataByType: async (userId: string, types: string[]) =>
    Object.fromEntries(await Promise.all(types.map(async (t) => [t, await mockFetchSeerrMetadata(userId, t)]))),
  hasEnabledSeerrInstances: mockHasEnabledSeerrInstances,
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollectionById: mockSyncCollectionById,
  syncAllCollections: mockSyncAllCollections,
}));

import { detectAndSaveMatches, runDetection } from "@/lib/lifecycle/detect-matches";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";

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

/*
 * Extra coverage for src/lib/lifecycle/detect-matches.ts: the stale-match
 * explanations (which rule stopped matching), server de-duplication when
 * copies collapse, and runDetection's skip/disarm branches.
 */
import { logger } from "@/lib/logger";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMatchedCriteriaForItems.mockReturnValue(new Map());
  mockGetActualValuesForAllRules.mockReturnValue(new Map());
  mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
  mockPrisma.mediaItem.findMany.mockResolvedValue([]);
  mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
  mockPrisma.ruleMatch.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.ruleMatch.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
  mockPrisma.lifecycleAction.updateMany.mockResolvedValue({ count: 1 });
  mockHasEnabledArrInstances.mockResolvedValue(true);
  mockHasEnabledSeerrInstances.mockResolvedValue(true);
  mockHasArrRules.mockReturnValue(false);
  mockHasSeerrRules.mockReturnValue(false);
  mockHasSeriesAggregateRules.mockReturnValue(false);
  mockHasWatchedByUserRules.mockReturnValue(false);
  mockHasPlayActivityRules.mockReturnValue(false);
});

describe("stale match explanations", () => {
  const criteria = [
    { ruleId: "r1", field: "resolution", operator: "equals", value: "4K" },
    { ruleId: "r2", field: "playCount", operator: "equals", value: 0, negate: true },
  ];

  it("names the rules that stopped matching, the ones that still do, and items that are gone", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    // A watchedByUser rule reads play activity too (its servers' history is
    // established: the default mediaServer.findMany finds none unevidenced).
    mockHasWatchedByUserRules.mockReturnValue(true);
    mockHasPlayActivityRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { mediaItemId: "dropped", itemData: { id: "dropped", title: "Dropped", matchedCriteria: criteria } },
      { mediaItemId: "unexplained", itemData: { id: "unexplained", title: "Pilot", parentTitle: "Some Show", matchedCriteria: criteria } },
      { mediaItemId: "gone", itemData: { id: "gone", title: "Gone", matchedCriteria: criteria } },
      { mediaItemId: "legacy", itemData: { id: "legacy", title: "Legacy" } },
    ]);
    mockPrisma.mediaItem.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args.where?.id?.in ?? [];
      return ids.filter((id) => id === "dropped" || id === "unexplained").map((id) => ({ id, title: id }));
    });
    mockGetMatchedCriteriaForItems.mockImplementation((items: Array<{ id: string }>) => {
      const id = items[0]?.id;
      if (id === "dropped") return new Map([["dropped", [criteria[0]]]]);
      if (id === "unexplained") return new Map([["unexplained", criteria]]);
      return new Map();
    });

    const result = await detectAndSaveMatches(makeRuleSetConfig(), ["s1"]);

    expect(result.items).toHaveLength(0);
    const info = vi.mocked(logger.info).mock.calls.map((c) => c[1] as string);
    expect(info).toContain(`Removed stale match "Dropped" from rule set "Test Rule Set" (no longer matching: NOT playCount equals 0)`);
    expect(info).toContain(`Removed stale match "Some Show" from rule set "Test Rule Set" (was matching: resolution equals 4K, NOT playCount equals 0)`);
    expect(info).toContain(`Removed stale match "Gone" from rule set "Test Rule Set" (item no longer exists)`);
    expect(info).toContain(`Removed stale match "Legacy" from rule set "Test Rule Set"`);
    // The re-evaluation loads only completed plays for watchedByUser rules.
    const staleLoad = mockPrisma.mediaItem.findMany.mock.calls.find((c) => (c[0] as { include?: object }).include);
    expect((staleLoad![0] as { include: { watchHistory?: unknown } }).include.watchHistory).toEqual({
      where: COMPLETED_PLAY_FILTER,
      select: { serverUsername: true },
    });
    expect((staleLoad![0] as { where: unknown }).where).toEqual({
      id: { in: ["dropped", "unexplained", "gone", "legacy"] },
      library: { mediaServerId: { in: ["s1"] } },
    });
  });
});

describe("cross-server collapse", () => {
  it("lists a server once when two collapsed copies live in two libraries of the same server", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockEvaluateRules.mockResolvedValue([
      {
        id: "a", title: "Movie", parentTitle: null, titleSort: "movie", libraryId: "lib-4k",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
      {
        id: "b", title: "Movie", parentTitle: null, titleSort: "movie", libraryId: "lib-hd",
        library: { mediaServer: { id: "s1", name: "Plex", type: "PLEX" } },
        externalIds: [{ source: "TMDB", externalId: "111" }],
      },
    ]);

    const result = await detectAndSaveMatches(
      makeRuleSetConfig({ serverIds: ["s1", "s2"] }),
      ["s1", "s2"],
      { "111": { arrId: 42 } } as never,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("a");
    expect(result.items[0].servers).toEqual([{ serverId: "s1", serverName: "Plex", serverType: "PLEX" }]);
    expect((result.items[0].copies as Array<{ id: string }>).map((c) => c.id)).toEqual(["b"]);
    // The one stored match records the absorbed copy for the indexed lookup.
    expect(mockPrisma.ruleMatch.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ ruleSetId: "rs1", mediaItemId: "a", copyIds: ["b"] })],
      skipDuplicates: true,
    });
  });
});

describe("runDetection skips", () => {
  const rs = (o: Record<string, unknown> = {}) => ({
    id: "rs1", userId: "u1", name: "Music seerr", type: "MUSIC",
    rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
    seriesScope: true, serverIds: ["s1"], actionEnabled: false, actionType: null,
    actionDelayDays: 0, arrInstanceId: null, addImportExclusion: false,
    addArrTags: [], removeArrTags: [], collectionId: null, stickyMatches: false,
    user: { mediaServers: [{ id: "s1" }] },
    ...o,
  });

  it("skips a rule set with no enabled rule", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);
    mockPrisma.ruleSet.findMany.mockResolvedValue([rs()]);
    expect(await runDetection("u1")).toEqual([]);
    expect(mockEvaluateMusicScope).not.toHaveBeenCalled();
    expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
  });

  it("does not warn about disarming when a permanently unevaluable rule set had nothing armed", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(true);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.ruleSet.findMany.mockResolvedValue([rs()]);

    expect(await runDetection("u1")).toEqual([]);

    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({ where: { ruleSetId: "rs1" } });
    expect(logger.warn).not.toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Disarmed"));
  });
});
