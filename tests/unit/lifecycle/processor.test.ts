import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted mocks for use inside vi.mock factories
const mockPrisma = vi.hoisted(() => ({
  ruleSet: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  lifecycleAction: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
  ruleMatch: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  lifecycleException: {
    findMany: vi.fn(),
  },
  appSettings: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  mediaItem: {
    findMany: vi.fn(),
  },
  // $transaction supports both the array form (returns resolved array) and the
  // callback form (invokes the callback with the same mock client). Production
  // code uses both shapes.
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => unknown)(mockPrisma);
    }
    return Promise.all(arg as Promise<unknown>[]);
  }),
}));

const mockDetectAndSaveMatches = vi.hoisted(() => vi.fn());
const mockExecuteAction = vi.hoisted(() => vi.fn());
const mockExtractActionError = vi.hoisted(() => vi.fn());
const mockSyncAllCollections = vi.hoisted(() => vi.fn());
const mockFetchArrMetadata = vi.hoisted(() => vi.fn());
const mockFetchSeerrMetadata = vi.hoisted(() => vi.fn());
const mockHasEnabledArrInstances = vi.hoisted(() => vi.fn());
const mockHasEnabledSeerrInstances = vi.hoisted(() => vi.fn());
const mockSyncMediaServer = vi.hoisted(() => vi.fn());
const mockSendDiscordNotification = vi.hoisted(() => vi.fn());
const mockBuildSuccessSummaryEmbed = vi.hoisted(() => vi.fn());
const mockBuildMatchChangeEmbed = vi.hoisted(() => vi.fn());
const mockBuildFailureSummaryEmbed = vi.hoisted(() => vi.fn());
const mockHasArrRules = vi.hoisted(() => vi.fn());
const mockHasSeerrRules = vi.hoisted(() => vi.fn());
const mockHasAnyActiveRules = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/lifecycle/detect-matches", () => ({
  detectAndSaveMatches: mockDetectAndSaveMatches,
}));
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return {
    // Keep the real normalizeTitle so the identity-swap guard behaves as in prod
    normalizeTitle: actual.normalizeTitle,
    executeAction: mockExecuteAction,
    extractActionError: mockExtractActionError,
  };
});
vi.mock("@/lib/lifecycle/collections", () => ({
  syncAllCollections: mockSyncAllCollections,
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
vi.mock("@/lib/sync/sync-server", () => ({
  syncMediaServer: mockSyncMediaServer,
}));
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: mockSendDiscordNotification,
  buildSuccessSummaryEmbed: mockBuildSuccessSummaryEmbed,
  buildMatchChangeEmbed: mockBuildMatchChangeEmbed,
  buildFailureSummaryEmbed: mockBuildFailureSummaryEmbed,
}));
vi.mock("@/lib/rules/lifecycle-engine", () => ({
  hasArrRules: mockHasArrRules,
  hasSeerrRules: mockHasSeerrRules,
  hasAnyActiveRules: mockHasAnyActiveRules,
}));

import {
  scheduleActionsForRuleSet,
  processLifecycleRules,
  executeLifecycleActions,
} from "@/lib/lifecycle/processor";

describe("scheduleActionsForRuleSet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes all pending actions when actions are disabled", async () => {
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 3 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", status: "PENDING" },
    });
  });

  it("does not create actions when actions are disabled", async () => {
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie" }],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.createMany).not.toHaveBeenCalled();
  });

  it("deletes pending actions and returns early when actionType is null", async () => {
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 2 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie" }],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", status: "PENDING" },
    });
    expect(mockPrisma.lifecycleAction.createMany).not.toHaveBeenCalled();
  });

  it("deletes stale pending actions for items no longer matching", async () => {
    // First deleteMany for disabled check won't be reached (actionEnabled = true)
    // findMany returns previous pending
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([{ mediaItemId: "item1" }, { mediaItemId: "item2" }]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 0 });

    // Only item1 still matches
    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 7,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    // Should delete stale action for item2
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ruleSetId: "rs1",
          status: "PENDING",
          mediaItemId: { in: ["item2"] },
        }),
      }),
    );
  });

  it("sweeps orphaned pending actions whose media item was purged from the DB", async () => {
    // The orphaned action has a null mediaItemId (FK SetNull after the item was deleted),
    // so it never appears in the non-null stale-id set — it must be swept separately.
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([{ mediaItemId: "item1" }]) // previousPending (only the still-matching item)
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([{ mediaItemId: "item1", status: "PENDING" }]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 0 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 7,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", status: "PENDING", mediaItemId: null },
    });
  });

  it("creates new actions for matched items without existing actions", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 1 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 7,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            userId: "u1",
            mediaItemId: "item1",
            ruleSetId: "rs1",
            actionType: "DELETE_RADARR",
          }),
        ]),
        skipDuplicates: true,
      }),
    );
  });

  it("skips items that already have existing actions", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([{ mediaItemId: "item1", status: "PENDING" }]); // existingActions — item1 already has one
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 0 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 0,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    // createMany should not be called since all items are existing
    expect(mockPrisma.lifecycleAction.createMany).not.toHaveBeenCalled();
  });

  // Helper: the existingActions probe is the lifecycleAction.findMany call whose
  // where carries an OR list (the previous-pending and dedup probes do not).
  function existingActionsWhere() {
    const arg = mockPrisma.lifecycleAction.findMany.mock.calls
      .map((c) => c[0] as { where?: { OR?: unknown } } | undefined)
      .find((a) => a?.where?.OR);
    return (arg as { where: { OR: unknown[] } }).where;
  }

  it("scopes the completed/failed re-schedule block to the current action type", async () => {
    // A non-destructive action only suppresses re-scheduling against a prior
    // action OF THE SAME TYPE — so a completed "Search for New Copy" can't block
    // a freshly-configured "Unmonitor", and vice versa.
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 1 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "UNMONITOR_RADARR",
        actionDelayDays: 0,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    expect(existingActionsWhere().OR).toEqual([
      { status: "PENDING" },
      { status: { in: ["COMPLETED", "FAILED"] }, actionType: "UNMONITOR_RADARR" },
    ]);
  });

  it("never blocks completed/failed actions when the current action is destructive", async () => {
    // DELETE* actions are always re-schedulable: a completed action of ANY other
    // type (e.g. the user changed "Search for New Copy" → "Delete from Radarr")
    // must not suppress the new delete. Only a PENDING action dedupes.
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 1 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 0,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    expect(existingActionsWhere().OR).toEqual([{ status: "PENDING" }]);
    expect(mockPrisma.lifecycleAction.createMany).toHaveBeenCalled();
  });

  it("blocks re-scheduling when a completed action has an identical config", async () => {
    // Same type AND same config (tags) as what we'd schedule now → no-op loop → block.
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([
        {
          mediaItemId: "item1",
          status: "COMPLETED",
          actionType: "DO_NOTHING",
          arrInstanceId: null,
          targetQualityProfileId: null,
          addImportExclusion: false,
          searchAfterAction: false,
          addArrTags: ["keep"],
          removeArrTags: [],
        },
      ]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 0 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: ["keep"],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.createMany).not.toHaveBeenCalled();
  });

  it("re-schedules when a completed action's config differs (tags changed)", async () => {
    // The rule's action was re-configured (added a tag) without recreating it —
    // a different signature, so the new action must be scheduled.
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([
        {
          mediaItemId: "item1",
          status: "COMPLETED",
          actionType: "DO_NOTHING",
          arrInstanceId: null,
          targetQualityProfileId: null,
          addImportExclusion: false,
          searchAfterAction: false,
          addArrTags: ["keep"],
          removeArrTags: [],
        },
      ]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 1 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: ["keep", "new"],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    expect(mockPrisma.lifecycleAction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ mediaItemId: "item1", actionType: "DO_NOTHING" }),
        ]),
      }),
    );
  });

  it("deduplicates pending actions from concurrent runs", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([
        { id: "a1", mediaItemId: "item1" },
        { id: "a2", mediaItemId: "item1" }, // duplicate
      ]) // allPending (dedup)
      .mockResolvedValueOnce([{ mediaItemId: "item1", status: "PENDING" }]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 1 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 0,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    // Should delete the duplicate action a2
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a2"] } },
    });
  });

  it("includes episodeIdMap in matchedMediaItemIds", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 1 });

    const episodeIdMap = new Map([["item1", ["ep1", "ep2"]]]);

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "SERIES",
        actionEnabled: true,
        actionType: "DELETE_SONARR",
        actionDelayDays: 0,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Show" }],
      episodeIdMap,
    );

    expect(mockPrisma.lifecycleAction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            matchedMediaItemIds: ["ep1", "ep2"],
          }),
        ]),
      }),
    );
  });
});

describe("processLifecycleRules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: instances exist — individual tests flip these to exercise the
    // no-instance match-all guard.
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
  });

  it("skips rule sets with no valid servers", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockPrisma.ruleSet.findMany
      .mockResolvedValueOnce([
        {
          id: "rs1",
          userId: "u1",
          name: "Test",
          type: "MOVIE",
          rules: [{ field: "title", operator: "contains", value: "test", enabled: true }],
          seriesScope: false,
          serverIds: ["server-gone"],
          actionEnabled: false,
          actionType: null,
          actionDelayDays: 0,
          arrInstanceId: null,
          targetQualityProfileId: null,
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionId: null,
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterAction: false,
          user: { mediaServers: [{ id: "other-server" }] },
        },
      ]);

    await processLifecycleRules("u1");

    expect(mockDetectAndSaveMatches).not.toHaveBeenCalled();
  });

  it("skips rule sets with no active rules", async () => {
    mockHasAnyActiveRules.mockReturnValue(false);
    mockPrisma.ruleSet.findMany
      .mockResolvedValueOnce([
        {
          id: "rs1",
          userId: "u1",
          name: "Test",
          type: "MOVIE",
          rules: [],
          seriesScope: false,
          serverIds: ["s1"],
          actionEnabled: false,
          actionType: null,
          actionDelayDays: 0,
          arrInstanceId: null,
          targetQualityProfileId: null,
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionId: null,
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterAction: false,
          user: { mediaServers: [{ id: "s1" }] },
        },
      ]);

    await processLifecycleRules("u1");

    expect(mockDetectAndSaveMatches).not.toHaveBeenCalled();
  });

  it("fetches arr metadata when rules use arr fields", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(false);
    mockFetchArrMetadata.mockResolvedValue({});
    mockDetectAndSaveMatches.mockResolvedValue({
      items: [],
      count: 0,
      episodeIdMap: new Map(),
      currentItems: [],
    });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);

    mockPrisma.ruleSet.findMany
      .mockResolvedValueOnce([
        {
          id: "rs1",
          userId: "u1",
          name: "Test",
          type: "MOVIE",
          rules: [{ field: "arrMonitored", operator: "equals", value: "true", enabled: true }],
          seriesScope: false,
          serverIds: ["s1"],
          actionEnabled: false,
          actionType: null,
          actionDelayDays: 0,
          arrInstanceId: null,
          targetQualityProfileId: null,
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionId: null,
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterAction: false,
          user: { mediaServers: [{ id: "s1" }] },
        },
      ]);

    await processLifecycleRules("u1");

    expect(mockFetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE");
    expect(mockDetectAndSaveMatches).toHaveBeenCalled();
  });

  it("skips rule sets with Arr rules when no enabled Arr instance exists (match-all guard)", async () => {
    // With zero enabled instances fetchArrMetadata would return {}, and
    // "foundInArr = false" would then match the ENTIRE library — the rule set
    // must be skipped instead, leaving existing matches untouched.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(false);
    mockHasEnabledArrInstances.mockResolvedValue(false);

    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      {
        id: "rs1",
        userId: "u1",
        name: "Orphan hunter",
        type: "MOVIE",
        rules: [{ field: "foundInArr", operator: "equals", value: "false", enabled: true }],
        seriesScope: false,
        serverIds: ["s1"],
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        actionDelayDays: 0,
        arrInstanceId: "radarr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        addArrTags: [],
        removeArrTags: [],
        collectionId: null,
        discordNotifyOnMatch: false,
        stickyMatches: false,
        searchAfterAction: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await processLifecycleRules("u1");

    expect(mockFetchArrMetadata).not.toHaveBeenCalled();
    expect(mockDetectAndSaveMatches).not.toHaveBeenCalled();
  });

  it("skips MUSIC rule sets with Seerr rules (Seerr data is never fetched for music)", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);

    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      {
        id: "rs1",
        userId: "u1",
        name: "Music seerr",
        type: "MUSIC",
        rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
        seriesScope: true,
        serverIds: ["s1"],
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        addArrTags: [],
        removeArrTags: [],
        collectionId: null,
        discordNotifyOnMatch: false,
        stickyMatches: false,
        searchAfterAction: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await processLifecycleRules("u1");

    expect(mockFetchSeerrMetadata).not.toHaveBeenCalled();
    expect(mockDetectAndSaveMatches).not.toHaveBeenCalled();
  });

  it("skips rule sets with Seerr rules when no enabled Seerr instance exists (match-all guard)", async () => {
    // "seerrRequested = false" against an empty Seerr map matches everything.
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(false);

    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      {
        id: "rs1",
        userId: "u1",
        name: "Unrequested",
        type: "MOVIE",
        rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
        seriesScope: false,
        serverIds: ["s1"],
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        addArrTags: [],
        removeArrTags: [],
        collectionId: null,
        discordNotifyOnMatch: false,
        stickyMatches: false,
        searchAfterAction: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await processLifecycleRules("u1");

    expect(mockFetchSeerrMetadata).not.toHaveBeenCalled();
    expect(mockDetectAndSaveMatches).not.toHaveBeenCalled();
  });

  it("syncs collections once after processing all rule sets", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(false);
    mockDetectAndSaveMatches.mockResolvedValue({
      items: [{ id: "item1", title: "Movie" }],
      count: 1,
      episodeIdMap: new Map(),
      currentItems: [],
    });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockSyncAllCollections.mockResolvedValue(undefined);

    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "MOVIE",
        rules: [{ field: "title", operator: "contains", value: "test", enabled: true }],
        seriesScope: false,
        serverIds: ["s1"],
        actionEnabled: false,
        actionType: null,
        actionDelayDays: 0,
        arrInstanceId: null,
        targetQualityProfileId: null,
        addImportExclusion: false,
        addArrTags: [],
        removeArrTags: [],
        collectionId: "col1",
        discordNotifyOnMatch: false,
        stickyMatches: false,
        searchAfterAction: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await processLifecycleRules("u1");

    // Collections are synced exactly once, scoped to the user, after the loop.
    expect(mockSyncAllCollections).toHaveBeenCalledTimes(1);
    expect(mockSyncAllCollections).toHaveBeenCalledWith("u1", expect.anything());
  });
});

describe("executeLifecycleActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no pending actions exist", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("deletes actions when media item no longer exists", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: null,
        mediaItem: null,
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("deletes actions for items excluded via lifecycle exception", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem: { id: "item1", title: "Movie", parentTitle: null, library: { key: "1", mediaServerId: "s1" }, externalIds: [] },
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { userId: "u1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("cancels an action whose item identity changed since scheduling (Fix Match)", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItemTitle: "Alpha",            // snapshot at creation
        mediaItem: { id: "item1", title: "Beta Reborn", parentTitle: null, library: { key: "1", mediaServerId: "s1" }, externalIds: [] }, // current row, re-matched in Plex
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        matchedMediaItemIds: [],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "item1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("does NOT cancel when only cosmetic title differences exist (article/year)", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItemTitle: "The Matrix",
        mediaItem: { id: "item1", title: "Matrix, The", parentTitle: null, year: 1999, library: { key: "1", mediaServerId: "s1" }, externalIds: [] },
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        matchedMediaItemIds: [],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "item1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.$transaction.mockResolvedValue([{}, {}]);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
  });

  it("refuses a whole-record DELETE_SONARR when a member is excepted (exception inviolability)", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "show1",
        mediaItemTitle: "Show",
        mediaItem: { id: "show1", title: "Show", parentTitle: null, library: { key: "1", mediaServerId: "s1" }, externalIds: [] },
        ruleSetId: "rs1",
        actionType: "DELETE_SONARR",          // whole-record; ignores member list
        matchedMediaItemIds: ["e1", "e2", "e3"],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([{ userId: "u1", mediaItemId: "e2" }]); // one episode protected
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mockExecuteAction).not.toHaveBeenCalled();  // whole series NOT deleted
  });

  it("proceeds with member-scoped DELETE_FILES_SONARR, passing only non-excepted members", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "show1",
        mediaItemTitle: "Show",
        mediaItem: { id: "show1", title: "Show", parentTitle: null, library: { key: "1", mediaServerId: "s1" }, externalIds: [] },
        ruleSetId: "rs1",
        actionType: "DELETE_FILES_SONARR",     // member-scoped
        matchedMediaItemIds: ["e1", "e2", "e3"],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([{ userId: "u1", mediaItemId: "e2" }]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.$transaction.mockResolvedValue([{}, {}]);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    const passed = mockExecuteAction.mock.calls[0][0];
    expect(passed.matchedMediaItemIds).toEqual(["e1", "e3"]); // e2 filtered, not deleted
  });

  it("cancels a whole-record DELETE_SONARR when a NON-matching sibling episode is excepted", async () => {
    // The excepted episode e9 never matched the rule, so it is not in
    // matchedMediaItemIds — the member-based inviolability check can't see it.
    // A whole-series delete would still destroy it, so the action must cancel.
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "ep1",
        mediaItemTitle: "Show",
        mediaItem: {
          id: "ep1",
          title: "Show",
          parentTitle: "Show",
          type: "SERIES",
          year: null,
          library: { key: "1", mediaServerId: "s1" },
          externalIds: [],
        },
        ruleSetId: "rs1",
        actionType: "DELETE_SONARR", // whole-record; ignores member list
        matchedMediaItemIds: ["ep1"],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "ep1" }]);
    // First shape: the plain exceptionSet lookup (excepted sibling e9 — not a
    // matched member). Second shape: the exception-guard's parentTitle lookup.
    mockPrisma.lifecycleException.findMany.mockImplementation(
      async (args: { where?: { mediaItem?: unknown } }) =>
        args?.where?.mediaItem
          ? [{ mediaItem: { parentTitle: "Show" } }]
          : [{ userId: "u1", mediaItemId: "e9" }],
    );
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("still runs a member-scoped DELETE_FILES_SONARR when only a non-member sibling is excepted", async () => {
    // Member-scoped deletes act only on matchedMediaItemIds — an exception on
    // a sibling episode outside the member list must not block them.
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "ep1",
        mediaItemTitle: "Show",
        mediaItem: {
          id: "ep1",
          title: "Show",
          parentTitle: "Show",
          type: "SERIES",
          year: null,
          library: { key: "1", mediaServerId: "s1" },
          externalIds: [],
        },
        ruleSetId: "rs1",
        actionType: "DELETE_FILES_SONARR", // member-scoped
        matchedMediaItemIds: ["ep1"],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "ep1" }]);
    mockPrisma.lifecycleException.findMany.mockImplementation(
      async (args: { where?: { mediaItem?: unknown } }) =>
        args?.where?.mediaItem
          ? [{ mediaItem: { parentTitle: "Show" } }]
          : [{ userId: "u1", mediaItemId: "e9" }],
    );
    mockExecuteAction.mockResolvedValue(undefined);
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    expect(mockExecuteAction.mock.calls[0][0].matchedMediaItemIds).toEqual(["ep1"]);
  });

  it("deletes stale actions for items no longer in match set", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem: { id: "item1", title: "Movie", parentTitle: null, library: { key: "1", mediaServerId: "s1" }, externalIds: [] },
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]); // No current matches
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({
      where: { id: "a1" },
    });
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("executes valid pending actions and marks as COMPLETED", async () => {
    const mediaItem = {
      id: "item1",
      title: "Movie",
      parentTitle: null,
      year: 2024,
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [],
    };
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem,
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockExecuteAction.mockResolvedValue(undefined);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1", mediaItem }),
    );
    expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("marks actions as FAILED when execution throws", async () => {
    const mediaItem = {
      id: "item1",
      title: "Movie",
      parentTitle: null,
      year: 2024,
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [],
    };
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem,
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockExecuteAction.mockRejectedValue(new Error("Radarr failed"));
    mockExtractActionError.mockReturnValue("Radarr failed");
    mockPrisma.lifecycleAction.update.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({ status: "FAILED", error: "Radarr failed" }),
      }),
    );
  });

  it("triggers library sync after destructive DELETE actions", async () => {
    const mediaItem = {
      id: "item1",
      title: "Movie",
      parentTitle: null,
      year: 2024,
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [],
    };
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem,
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockExecuteAction.mockResolvedValue(undefined);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.appSettings.findMany.mockResolvedValue([]);
    mockSyncMediaServer.mockResolvedValue(undefined);

    await executeLifecycleActions("u1");

    expect(mockSyncMediaServer).toHaveBeenCalledWith("s1", "1");
  });

  it("sends Discord success notification when configured", async () => {
    const mediaItem = {
      id: "item1",
      title: "Movie",
      parentTitle: null,
      year: 2024,
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [],
    };
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem,
        ruleSetId: "rs1",
        actionType: "UNMONITOR_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: true, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockExecuteAction.mockResolvedValue(undefined);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.appSettings.findMany.mockResolvedValue([
      {
        userId: "u1",
        discordWebhookUrl: "https://discord.com/webhook/123",
        discordWebhookUsername: "Bot",
        discordWebhookAvatarUrl: null,
      },
    ]);
    mockBuildSuccessSummaryEmbed.mockReturnValue({ title: "Success" });
    mockSendDiscordNotification.mockResolvedValue(undefined);

    await executeLifecycleActions("u1");

    expect(mockSendDiscordNotification).toHaveBeenCalled();
    expect(mockBuildSuccessSummaryEmbed).toHaveBeenCalledWith(
      "Test",
      "UNMONITOR_RADARR",
      expect.arrayContaining(["Movie (2024)"]),
    );
  });

  it("removes match after successful action execution", async () => {
    const mediaItem = {
      id: "item1",
      title: "Movie",
      parentTitle: null,
      year: null,
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [],
    };
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItem,
        ruleSetId: "rs1",
        actionType: "UNMONITOR_RADARR",
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "item1" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockExecuteAction.mockResolvedValue(undefined);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.appSettings.findMany.mockResolvedValue([]);

    await executeLifecycleActions("u1");

    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", mediaItemId: "item1" },
    });
  });
});
