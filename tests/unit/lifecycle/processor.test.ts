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
  },
  mediaItem: {
    findMany: vi.fn(),
  },
}));

const mockDetectAndSaveMatches = vi.hoisted(() => vi.fn());
const mockExecuteAction = vi.hoisted(() => vi.fn());
const mockExtractActionError = vi.hoisted(() => vi.fn());
const mockSyncPlexCollection = vi.hoisted(() => vi.fn());
const mockRemovePlexCollection = vi.hoisted(() => vi.fn());
const mockFetchArrMetadata = vi.hoisted(() => vi.fn());
const mockFetchSeerrMetadata = vi.hoisted(() => vi.fn());
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
vi.mock("@/lib/lifecycle/actions", () => ({
  executeAction: mockExecuteAction,
  extractActionError: mockExtractActionError,
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncPlexCollection: mockSyncPlexCollection,
  removePlexCollection: mockRemovePlexCollection,
}));
vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: mockFetchArrMetadata,
}));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: mockFetchSeerrMetadata,
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
vi.mock("@/lib/rules/engine", () => ({
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
      .mockResolvedValueOnce([{ mediaItemId: "item1" }]); // existingActions — item1 already has one
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
        addImportExclusion: false,
        searchAfterDelete: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [{ id: "item1", title: "Movie 1" }],
      new Map(),
    );

    // createMany should not be called since all items are existing
    expect(mockPrisma.lifecycleAction.createMany).not.toHaveBeenCalled();
  });

  it("deduplicates pending actions from concurrent runs", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([
        { id: "a1", mediaItemId: "item1" },
        { id: "a2", mediaItemId: "item1" }, // duplicate
      ]) // allPending (dedup)
      .mockResolvedValueOnce([{ mediaItemId: "item1" }]); // existingActions
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
        addImportExclusion: false,
        searchAfterDelete: false,
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
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionEnabled: false,
          collectionName: null,
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterDelete: false,
          user: { mediaServers: [{ id: "other-server" }] },
        },
      ])
      .mockResolvedValueOnce([]); // disabledCollectionRuleSets

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
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionEnabled: false,
          collectionName: null,
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterDelete: false,
          user: { mediaServers: [{ id: "s1" }] },
        },
      ])
      .mockResolvedValueOnce([]); // disabledCollectionRuleSets

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
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionEnabled: false,
          collectionName: null,
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterDelete: false,
          user: { mediaServers: [{ id: "s1" }] },
        },
      ])
      .mockResolvedValueOnce([]); // disabledCollectionRuleSets

    await processLifecycleRules("u1");

    expect(mockFetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE");
    expect(mockDetectAndSaveMatches).toHaveBeenCalled();
  });

  it("cleans up disabled collection rule sets", async () => {
    mockPrisma.ruleSet.findMany
      .mockResolvedValueOnce([]) // no enabled rule sets
      .mockResolvedValueOnce([
        { id: "rs1", userId: "u1", type: "MOVIE", collectionName: "Old Collection" },
      ]);

    mockRemovePlexCollection.mockResolvedValue(undefined);
    mockPrisma.ruleSet.update.mockResolvedValue({});

    await processLifecycleRules();

    expect(mockRemovePlexCollection).toHaveBeenCalledWith("u1", "MOVIE", "Old Collection");
    expect(mockPrisma.ruleSet.update).toHaveBeenCalledWith({
      where: { id: "rs1" },
      data: { collectionName: null },
    });
  });

  it("handles collection cleanup errors gracefully", async () => {
    mockPrisma.ruleSet.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "rs1", userId: "u1", type: "MOVIE", collectionName: "Bad Collection" },
      ]);

    mockRemovePlexCollection.mockRejectedValue(new Error("Plex down"));

    // Should not throw
    await expect(processLifecycleRules()).resolves.toBeUndefined();
  });

  it("syncs Plex collection when collection is enabled", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(false);
    const currentItems = [{ id: "item1", libraryId: "lib1", ratingKey: "rk1", title: "Movie", parentTitle: null }];
    mockDetectAndSaveMatches.mockResolvedValue({
      items: [{ id: "item1", title: "Movie" }],
      count: 1,
      episodeIdMap: new Map(),
      currentItems,
    });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockSyncPlexCollection.mockResolvedValue(undefined);

    mockPrisma.ruleSet.findMany
      .mockResolvedValueOnce([
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
          addImportExclusion: false,
          addArrTags: [],
          removeArrTags: [],
          collectionEnabled: true,
          collectionName: "My Collection",
          discordNotifyOnMatch: false,
          stickyMatches: false,
          searchAfterDelete: false,
          user: { mediaServers: [{ id: "s1" }] },
        },
      ])
      .mockResolvedValueOnce([]); // disabledCollectionRuleSets

    await processLifecycleRules("u1");

    expect(mockSyncPlexCollection).toHaveBeenCalled();
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
    mockPrisma.appSettings.findUnique.mockResolvedValue(null);
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
    mockPrisma.appSettings.findUnique.mockResolvedValue({
      discordWebhookUrl: "https://discord.com/webhook/123",
      discordWebhookUsername: "Bot",
      discordWebhookAvatarUrl: null,
    });
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
    mockPrisma.appSettings.findUnique.mockResolvedValue(null);

    await executeLifecycleActions("u1");

    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", mediaItemId: "item1" },
    });
  });
});
