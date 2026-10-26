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
    create: vi.fn(),
    // Pass 1 cancels and pass 2 records with the *Many forms, so a row removed
    // mid-run cannot abort the run.
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    // Pass 2 re-reads each action before acting; found = still pending,
    // unchanged and due, unless a test says otherwise.
    findFirst: vi.fn().mockResolvedValue({ id: "found" }),
  },
  ruleMatch: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  lifecycleException: {
    findMany: vi.fn(),
    // Pass 2 asks whether an exception was filed during the run: none.
    count: vi.fn().mockResolvedValue(0),
  },
  appSettings: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    // Read by the deletion ceiling. Defaults to no row, i.e. unlimited, which
    // is the shipped default and keeps every existing test's behaviour.
    findFirst: vi.fn().mockResolvedValue(null),
  },
  mediaItem: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
  },
  // Scheduling reads the Arr external id of items detection returned without
  // `externalIds`. Defaults to none found.
  mediaItemExternalId: {
    findMany: vi.fn().mockResolvedValue([]),
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
    describeActionError: actual.describeActionError,
  };
});
vi.mock("@/lib/lifecycle/collections", () => ({
  syncAllCollections: mockSyncAllCollections,
}));
vi.mock("@/lib/lifecycle/fetch-arr-metadata", () => ({
  fetchArrMetadata: mockFetchArrMetadata,
  hasEnabledArrInstances: mockHasEnabledArrInstances,
  // Read by the real evaluability guard when a rule set names its instance.
  resolveArrInstanceScope: vi.fn().mockResolvedValue(null),
  arrFamilyLabel: (type: string) =>
    type === "MOVIE" ? "Radarr" : type === "MUSIC" ? "Lidarr" : "Sonarr",
  invalidateArrMetadataCache: () => {},
}));
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", () => ({
  fetchSeerrMetadata: mockFetchSeerrMetadata,
  // One walk for every type a run needs; delegated per type so each
  // test can keep stubbing the per-type answer.
  fetchSeerrMetadataByType: async (userId: string, types: string[]) =>
    Object.fromEntries(await Promise.all(types.map(async (t) => [t, await mockFetchSeerrMetadata(userId, t)]))),
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
  // The evaluability guard now also checks watch history: an empty
  // `WatchHistory` makes negative `watchedByUser` rules match everything.
  hasWatchedByUserRules: vi.fn(() => false),
  hasPlayActivityRules: vi.fn(() => false),
  hasAnyActiveRules: mockHasAnyActiveRules,
  hasCustomFormatScoreRules: () => false,
}));

import {
  processLifecycleRules,
  executeLifecycleActions,
} from "@/lib/lifecycle/processor";

/*
 * Extra coverage for src/lib/lifecycle/processor.ts: the pass-1 member
 * narrowing, the pass-2 "excepted since the run started" re-check (the only
 * thing that catches a sibling exception filed mid-run against a whole-record
 * delete), result recording when the row vanished, the post-delete re-sync
 * failing, and the match-change notification ordering.
 */
import { logger } from "@/lib/logger";

const show = {
  id: "show1", title: "Pilot", parentTitle: "Show", type: "SERIES", seriesKey: "title:show", year: 2020,
  library: { key: "2", mediaServerId: "s1" }, externalIds: [],
};

function seriesAction(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    userId: "u1",
    mediaItemId: "show1",
    mediaItemTitle: "Show",
    mediaItemParentTitle: null,
    mediaItem: show,
    ruleSetId: "rs1",
    ruleSetType: "SERIES",
    actionType: "DELETE_FILES_SONARR",
    matchedMediaItemIds: ["e1", "e2"],
    updatedAt: new Date("2025-01-01"),
    scheduledFor: new Date("2025-01-01"),
    ruleSet: { name: "Ended shows", discordNotifyOnAction: false, userId: "u1", type: "SERIES" },
    ...overrides,
  };
}

describe("executeLifecycleActions — narrowing and late exceptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.lifecycleAction.findFirst.mockResolvedValue({ id: "found" });
    mockPrisma.lifecycleAction.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.lifecycleException.count.mockResolvedValue(0);
    mockPrisma.appSettings.findFirst.mockResolvedValue(null);
    mockPrisma.appSettings.findMany.mockResolvedValue([]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
    mockExecuteAction.mockResolvedValue({});
  });

  it("cancels a member-scoped action none of whose members still match", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([seriesAction()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "show1", itemData: { memberIds: ["e3"] } },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({ where: { id: "a1" } });
  });

  it("acts only on the members that still match", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([seriesAction()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { ruleSetId: "rs1", mediaItemId: "show1", itemData: { memberIds: ["e2", "e9"] } },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    expect(mockExecuteAction.mock.calls[0][0].matchedMediaItemIds).toEqual(["e2"]);
    // History records what it acted on, not what was scheduled.
    expect(mockPrisma.lifecycleAction.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({ status: "COMPLETED", matchedMediaItemIds: ["e2"] }),
    });
  });

  it("cancels a member-scoped action whose every member is excepted", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([seriesAction()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1", itemData: null }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { userId: "u1", mediaItemId: "e1", mediaItem: { dedupKey: null } },
      { userId: "u1", mediaItemId: "e2", mediaItem: { dedupKey: null } },
    ]);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({ where: { id: "a1" } });
  });

  it("leaves an action PENDING when one of its members was excepted after the run started", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([seriesAction()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1", itemData: null }]);
    mockPrisma.lifecycleException.findMany
      .mockResolvedValueOnce([]) // the run's own load: nothing excepted yet
      .mockResolvedValueOnce([{ mediaItemId: "e2", mediaItem: { dedupKey: null } }]); // filed mid-run
    mockPrisma.lifecycleException.count.mockResolvedValue(1);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleAction.updateMany).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("excluded after this run started"));
  });

  it("leaves a whole-record DELETE_SONARR PENDING when a sibling episode was excepted after the run started", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      seriesAction({ actionType: "DELETE_SONARR", matchedMediaItemIds: [] }),
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1", itemData: null }]);
    mockPrisma.lifecycleException.findMany
      .mockResolvedValueOnce([]) // run start
      .mockResolvedValueOnce([{ mediaItemId: "sibling", mediaItem: { dedupKey: null } }]) // findExceptedItemIds
      .mockResolvedValueOnce([{ mediaItem: { parentTitle: "Show", seriesKey: "title:show", type: "SERIES" } }]); // groups
    mockPrisma.lifecycleException.count.mockResolvedValue(1);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("excluded after this run started"));
  });

  it("runs a member-scoped action when the mid-run exception touches none of its members", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([seriesAction()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1", itemData: null }]);
    mockPrisma.lifecycleException.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ mediaItemId: "elsewhere", mediaItem: { dedupKey: null } }]);
    mockPrisma.lifecycleException.count.mockResolvedValue(1);

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
  });

  it("keeps running when the post-delete re-sync fails", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      seriesAction({ actionType: "DELETE_SONARR", matchedMediaItemIds: [] }),
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1", itemData: null }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.mediaItem.aggregate.mockResolvedValue({ _sum: { fileSize: null } });
    mockSyncMediaServer.mockRejectedValue(new Error("plex down"));

    await expect(executeLifecycleActions("u1")).resolves.toBeUndefined();

    // The delete itself is recorded as done before the re-sync is attempted.
    expect(mockPrisma.lifecycleAction.updateMany).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
    expect(mockSyncMediaServer).toHaveBeenCalledWith("s1", "2", expect.objectContaining({ skipWatchHistory: true }));
    expect(logger.error).toHaveBeenCalledWith("Lifecycle", expect.stringContaining("Failed to sync library 2"), expect.any(Object));
  });

  it("logs, and does not throw, when the result of an action whose row vanished cannot be recorded", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      seriesAction({ actionType: "UNMONITOR_SONARR", matchedMediaItemIds: [] }),
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "show1", itemData: null }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.create.mockRejectedValue(new Error("fk"));

    await executeLifecycleActions("u1");

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.lifecycleAction.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.lifecycleAction.create.mock.calls[1][0].data).toMatchObject({ ruleSetId: null, mediaItemId: null });
    expect(logger.error).toHaveBeenCalledWith("Lifecycle", "Could not record the result of action a1", expect.any(Object));
  });
});

describe("processLifecycleRules — match-change notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(false);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockSyncAllCollections.mockResolvedValue(undefined);
  });

  const ruleSet = (o: Record<string, unknown> = {}) => ({
    id: "rs1", userId: "u1", name: "Old movies", type: "MOVIE",
    rules: [{ field: "title", operator: "contains", value: "x", enabled: true }],
    seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null, actionDelayDays: 0,
    arrInstanceId: null, targetQualityProfileId: null, addImportExclusion: false, addArrTags: [], removeArrTags: [],
    collectionId: null, discordNotifyOnMatch: true, stickyMatches: false, searchAfterAction: false,
    user: { mediaServers: [{ id: "s1" }] },
    ...o,
  });

  it("sorts added titles by sort title, and runs for every user when none is given", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([ruleSet()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([]);
    mockDetectAndSaveMatches.mockResolvedValue({
      items: [
        { id: "m2", title: "Zodiac", titleSort: "Zodiac" },
        { id: "m1", title: "The Abyss", titleSort: "Abyss" },
        { id: "m3", title: "No Sort" },
      ],
      count: 3, episodeIdMap: new Map(), currentItems: [],
    });
    mockPrisma.appSettings.findUnique.mockResolvedValue({
      discordWebhookUrl: "https://discord.example/hook", discordWebhookUsername: "Bot", discordWebhookAvatarUrl: "https://a/x.png",
    });
    mockSendDiscordNotification.mockResolvedValue(undefined);

    await processLifecycleRules();

    expect(mockPrisma.ruleSet.findMany.mock.calls[0][0].where).toEqual({ enabled: true });
    expect(mockBuildMatchChangeEmbed).toHaveBeenCalledWith("Old movies", 3, 0, "MOVIE", ["No Sort", "The Abyss", "Zodiac"], []);
    expect(mockSendDiscordNotification).toHaveBeenCalledWith("https://discord.example/hook", expect.objectContaining({ username: "Bot", avatar_url: "https://a/x.png" }));
    expect(mockSyncAllCollections).toHaveBeenCalledWith(undefined, expect.any(Map));
  });

  it("sends nothing when the match set did not change, or no webhook is set", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([ruleSet(), ruleSet({ id: "rs2" })]);
    mockPrisma.ruleMatch.findMany
      .mockResolvedValueOnce([{ mediaItemId: "m1" }])
      .mockResolvedValueOnce([]);
    mockDetectAndSaveMatches
      .mockResolvedValueOnce({ items: [{ id: "m1", title: "A" }], count: 1, episodeIdMap: new Map(), currentItems: [] })
      .mockResolvedValueOnce({ items: [{ id: "m2", title: "B" }], count: 1, episodeIdMap: new Map(), currentItems: [] });
    mockPrisma.appSettings.findUnique.mockResolvedValue({ discordWebhookUrl: null });

    await processLifecycleRules("u1");

    expect(mockSendDiscordNotification).not.toHaveBeenCalled();
    expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("does not let a notification failure stop scheduling", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([ruleSet()]);
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([]);
    mockDetectAndSaveMatches.mockResolvedValue({ items: [{ id: "m1", title: "A" }], count: 1, episodeIdMap: new Map(), currentItems: [] });
    mockPrisma.appSettings.findUnique.mockRejectedValue(new Error("db"));

    await processLifecycleRules("u1");

    // Scheduling still ran (actions disabled → pending actions cleared).
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({ where: { ruleSetId: "rs1", status: "PENDING" } });
  });
});
