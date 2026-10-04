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
  // The evaluability guard now also checks watch history: an empty
  // `WatchHistory` makes negative `watchedByUser` rules match everything.
  hasWatchedByUserRules: vi.fn(() => false),
  hasPlayActivityRules: vi.fn(() => false),
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

  it("records the identity the executor re-checks: titles, year and the Arr external id", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 2 });
    // Only the item detection returned WITHOUT external ids is looked up.
    mockPrisma.mediaItemExternalId.findMany.mockResolvedValueOnce([
      { mediaItemId: "bare", externalId: "438631" },
    ]);

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
      [
        {
          id: "loaded",
          title: "The Matrix",
          parentTitle: null,
          year: 1999,
          externalIds: [
            { source: "IMDB", externalId: "tt0133093" },
            { source: "TMDB", externalId: "603" },
          ],
        },
        { id: "bare", title: "Dune", parentTitle: null, year: 2021 },
      ],
      new Map(),
    );

    expect(mockPrisma.mediaItemExternalId.findMany).toHaveBeenCalledWith({
      where: { mediaItemId: { in: ["bare"] }, source: "TMDB" },
      select: { mediaItemId: true, externalId: true },
    });
    const data = mockPrisma.lifecycleAction.createMany.mock.calls[0][0].data;
    expect(data).toEqual([
      expect.objectContaining({ mediaItemId: "loaded", mediaItemTitle: "The Matrix", mediaItemYear: 1999, mediaItemExternalId: "603" }),
      expect.objectContaining({ mediaItemId: "bare", mediaItemTitle: "Dune", mediaItemYear: 2021, mediaItemExternalId: "438631" }),
    ]);
  });

  it("records a series group's show-level TVDB id and leaves an id-less item's snapshot empty", async () => {
    mockPrisma.lifecycleAction.findMany
      .mockResolvedValueOnce([]) // previousPending
      .mockResolvedValueOnce([]) // allPending (dedup)
      .mockResolvedValueOnce([]); // existingActions
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 2 });

    await scheduleActionsForRuleSet(
      {
        id: "rs1",
        userId: "u1",
        name: "Test",
        type: "SERIES",
        actionEnabled: true,
        actionType: "DELETE_SONARR",
        actionDelayDays: 7,
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
        addImportExclusion: false,
        searchAfterAction: false,
        addArrTags: [],
        removeArrTags: [],
      },
      [
        // Detection's group record: the show as the title, no parent.
        { id: "ep1", title: "Breaking Bad", parentTitle: null, year: 2008, externalIds: [{ source: "TVDB", externalId: "81189" }] },
        { id: "ep9", title: "Unknown Show", parentTitle: null, year: null, externalIds: [] },
      ],
      new Map([["ep1", ["ep1", "ep2"]], ["ep9", ["ep9"]]]),
    );

    expect(mockPrisma.mediaItemExternalId.findMany).not.toHaveBeenCalled();
    const data = mockPrisma.lifecycleAction.createMany.mock.calls[0][0].data;
    expect(data).toEqual([
      expect.objectContaining({ mediaItemTitle: "Breaking Bad", mediaItemParentTitle: null, mediaItemExternalId: "81189" }),
      expect.objectContaining({ mediaItemTitle: "Unknown Show", mediaItemYear: null, mediaItemExternalId: null }),
    ]);
  });

  describe("the one-time upgrade hold on grouped actions", () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function schedule(
      type: "MOVIE" | "SERIES" | "MUSIC",
      item: Record<string, unknown>,
      heldUntil: Date | null,
      actionDelayDays = 0,
    ): Promise<Date> {
      mockPrisma.lifecycleAction.findMany
        .mockResolvedValueOnce([]) // previousPending
        .mockResolvedValueOnce([]) // allPending (dedup)
        .mockResolvedValueOnce([]); // existingActions
      mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.lifecycleAction.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.appSettings.findUnique.mockResolvedValueOnce({ groupedActionsHeldUntil: heldUntil });
      await scheduleActionsForRuleSet(
        {
          id: "rs1",
          userId: "u1",
          name: "Test",
          type,
          actionEnabled: true,
          actionType: "DELETE_SONARR",
          actionDelayDays,
          arrInstanceId: "arr1",
          targetQualityProfileId: null,
          addImportExclusion: false,
          searchAfterAction: false,
          addArrTags: [],
          removeArrTags: [],
        },
        [{ externalIds: [], ...item }],
        new Map(),
      );
      return mockPrisma.lifecycleAction.createMany.mock.calls.at(-1)![0].data[0].scheduledFor;
    }

    it("schedules a show's or an artist's action no earlier than the hold", async () => {
      const hold = new Date(Date.now() + 5 * DAY);
      expect(await schedule("SERIES", { id: "ep1", title: "Breaking Bad", parentTitle: null }, hold)).toEqual(hold);
      expect(await schedule("MUSIC", { id: "t1", title: "Radiohead", parentTitle: null }, hold)).toEqual(hold);
      expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledWith({
        where: { userId: "u1" },
        select: { groupedActionsHeldUntil: true },
      });
    });

    it("leaves a single item's action, a later delay and a passed hold alone", async () => {
      const hold = new Date(Date.now() + 5 * DAY);
      const now = Date.now();
      // A track matched on its own, and a movie: the old check never cancelled them.
      expect((await schedule("MUSIC", { id: "t2", title: "Creep", parentTitle: "Radiohead" }, hold)).getTime())
        .toBeLessThan(now + DAY);
      expect((await schedule("MOVIE", { id: "m1", title: "Dune", parentTitle: null }, hold)).getTime())
        .toBeLessThan(now + DAY);
      // A delay that already ends after the hold keeps its own date.
      expect((await schedule("SERIES", { id: "ep2", title: "The Wire", parentTitle: null }, hold, 30)).getTime())
        .toBeGreaterThan(hold.getTime());
      // Once the hold has passed it no longer applies.
      expect((await schedule("SERIES", { id: "ep3", title: "The Wire", parentTitle: null }, new Date(now - DAY))).getTime())
        .toBeLessThan(now + DAY);
    });
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

    expect(mockFetchArrMetadata).toHaveBeenCalledWith("u1", "MOVIE", undefined, null);
    expect(mockDetectAndSaveMatches).toHaveBeenCalled();
  });

  it("fetches Seerr metadata once per type across rule sets", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);
    mockFetchSeerrMetadata.mockResolvedValue({});
    mockDetectAndSaveMatches.mockResolvedValue({
      items: [],
      count: 0,
      episodeIdMap: new Map(),
      currentItems: [],
    });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    const ruleSet = (id: string, type: string) => ({
      id, userId: "u1", name: id, type,
      rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
      seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null,
      actionDelayDays: 0, arrInstanceId: null, targetQualityProfileId: null,
      addImportExclusion: false, addArrTags: [], removeArrTags: [], collectionId: null,
      discordNotifyOnMatch: false, stickyMatches: false, searchAfterAction: false,
      user: { mediaServers: [{ id: "s1" }] },
    });
    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      ruleSet("m1", "MOVIE"),
      ruleSet("m2", "MOVIE"),
      ruleSet("s1", "SERIES"),
    ]);

    await processLifecycleRules("u1");

    expect(mockFetchSeerrMetadata).toHaveBeenCalledTimes(2);
    expect(mockFetchSeerrMetadata).toHaveBeenCalledWith("u1", "MOVIE");
    expect(mockFetchSeerrMetadata).toHaveBeenCalledWith("u1", "SERIES");
    expect(mockDetectAndSaveMatches).toHaveBeenCalledTimes(3);
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

  it("skips AND DISARMS MUSIC rule sets with Seerr rules (permanently unevaluable)", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(true);
    // Pre-existing vacuous flood: matches + armed actions from before the guard
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 3 });
    mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 40 });

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
    // A permanently unevaluable rule set is DISARMED, not just skipped — its
    // vacuous whole-library matches and armed actions must not survive.
    expect(mockPrisma.lifecycleAction.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1", status: "PENDING" },
    });
    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({
      where: { ruleSetId: "rs1" },
    });
  });

  it("does NOT disarm on the transient no-instance skip (matches stay untouched)", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(true);
    mockHasSeerrRules.mockReturnValue(false);
    mockHasEnabledArrInstances.mockResolvedValue(false);

    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      {
        id: "rs1",
        userId: "u1",
        name: "Transient",
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

    expect(mockDetectAndSaveMatches).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleAction.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.ruleMatch.deleteMany).not.toHaveBeenCalled();
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

  it("names a removed series match by its show in the match-change notification, in episode scope too", async () => {
    mockHasAnyActiveRules.mockReturnValue(true);
    mockHasArrRules.mockReturnValue(false);
    mockHasSeerrRules.mockReturnValue(false);
    // The show matched last run (stored against an episode) and no longer does.
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([{ mediaItemId: "old-ep" }]);
    mockDetectAndSaveMatches.mockResolvedValue({ items: [], count: 0, episodeIdMap: new Map(), currentItems: [] });
    mockPrisma.appSettings.findUnique.mockResolvedValue({
      discordWebhookUrl: "https://discord.com/webhook/123", discordWebhookUsername: null, discordWebhookAvatarUrl: null,
    });
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([{ title: "Pilot", parentTitle: "Breaking Bad", titleSort: "Pilot" }]);
    mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
    mockSyncAllCollections.mockResolvedValue(undefined);
    mockSendDiscordNotification.mockResolvedValue(undefined);

    mockPrisma.ruleSet.findMany.mockResolvedValueOnce([
      {
        id: "rs1", userId: "u1", name: "Episodes", type: "SERIES",
        rules: [{ field: "title", operator: "contains", value: "x", enabled: true }],
        seriesScope: false, serverIds: ["s1"], actionEnabled: false, actionType: null, actionDelayDays: 0,
        arrInstanceId: null, targetQualityProfileId: null, addImportExclusion: false, addArrTags: [], removeArrTags: [],
        collectionId: null, discordNotifyOnMatch: true, stickyMatches: false, searchAfterAction: false,
        user: { mediaServers: [{ id: "s1" }] },
      },
    ]);

    await processLifecycleRules("u1");

    expect(mockBuildMatchChangeEmbed).toHaveBeenCalledWith("Episodes", 0, 1, "SERIES", [], ["Breaking Bad"]);
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
    // The match went stale with it: the next detection evaluates the new title.
    expect(mockPrisma.ruleMatch.deleteMany).toHaveBeenCalledWith({ where: { ruleSetId: "rs1", mediaItemId: "item1" } });
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

  describe("identity guard on grouped (series / artist) actions", () => {
    // Detection stores a series or artist match as its GROUP — the show or
    // artist as the title, no parent — against a representative episode or
    // track, whose own title is the episode's or track's.
    function groupedAction(
      type: "SERIES" | "MUSIC",
      snapshot: { title: string; externalId?: string },
      row: { title: string; parentTitle: string | null; externalIds?: Array<{ source: string; externalId: string }> },
    ) {
      return {
        id: "a1",
        userId: "u1",
        mediaItemId: "rep1",
        mediaItemTitle: snapshot.title,
        mediaItemParentTitle: null,
        mediaItemYear: null,
        mediaItemExternalId: snapshot.externalId ?? null,
        mediaItem: {
          id: "rep1",
          year: 2008,
          externalIds: [],
          library: { key: "1", mediaServerId: "s1" },
          ...row,
        },
        ruleSetId: "rs1",
        actionType: "DO_NOTHING",
        matchedMediaItemIds: [],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1", type, rules: [] },
      };
    }

    beforeEach(() => {
      mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "rep1" }]);
      mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
      mockPrisma.lifecycleAction.delete.mockResolvedValue({});
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);
    });

    it("executes a series action whose group title is the representative episode's show", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([
        groupedAction(
          "SERIES",
          { title: "Breaking Bad", externalId: "81189" },
          { title: "Pilot", parentTitle: "Breaking Bad", externalIds: [{ source: "TVDB", externalId: "81189" }] },
        ),
      ]);

      await executeLifecycleActions("u1");

      expect(mockPrisma.lifecycleAction.delete).not.toHaveBeenCalled();
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    });

    it("executes an artist action whose group title is the representative track's artist", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([
        groupedAction("MUSIC", { title: "Radiohead" }, { title: "Creep", parentTitle: "Radiohead" }),
      ]);

      await executeLifecycleActions("u1");

      expect(mockPrisma.lifecycleAction.delete).not.toHaveBeenCalled();
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    });

    it("cancels a series action whose show was re-identified", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([
        groupedAction("SERIES", { title: "Breaking Bad" }, { title: "Pilot", parentTitle: "Better Call Saul" }),
      ]);

      await executeLifecycleActions("u1");

      expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });

    it("cancels a series action whose show's TVDB id changed under the same title", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([
        groupedAction(
          "SERIES",
          { title: "Battlestar Galactica", externalId: "71173" },
          { title: "Pilot", parentTitle: "Battlestar Galactica", externalIds: [{ source: "TVDB", externalId: "73545" }] },
        ),
      ]);

      await executeLifecycleActions("u1");

      expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });
  });

  it("cancels a movie action whose row became a remake of the same title (TMDB id and year)", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItemTitle: "Dune",
        mediaItemParentTitle: null,
        mediaItemYear: 1984,
        mediaItemExternalId: "841",
        mediaItem: {
          id: "item1", title: "Dune", parentTitle: null, year: 2021,
          library: { key: "1", mediaServerId: "s1" },
          externalIds: [{ source: "TMDB", externalId: "438631" }],
        },
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        matchedMediaItemIds: [],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1", type: "MOVIE", rules: [] },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "item1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("cancels a movie action whose year moved by more than one even when no id was recorded", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "item1",
        mediaItemTitle: "Dune",
        mediaItemParentTitle: null,
        mediaItemYear: 1984,
        mediaItemExternalId: null,
        mediaItem: { id: "item1", title: "Dune", parentTitle: null, year: 2021, library: { key: "1", mediaServerId: "s1" }, externalIds: [] },
        ruleSetId: "rs1",
        actionType: "DELETE_RADARR",
        matchedMediaItemIds: [],
        ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1", type: "MOVIE", rules: [] },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "item1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mockExecuteAction).not.toHaveBeenCalled();
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

  it("cancels armed actions of a permanently unevaluable MUSIC+Seerr rule set (backstop)", async () => {
    // Detection disarms such rule sets, but this executor can run BEFORE the
    // first post-upgrade detection cycle — a pre-existing vacuous flood of
    // DELETE_LIDARR actions must not fire.
    mockHasSeerrRules.mockReturnValue(true);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      {
        id: "a1",
        userId: "u1",
        mediaItemId: "track1",
        mediaItemTitle: "Track",
        mediaItem: {
          id: "track1",
          title: "Track",
          parentTitle: "Artist",
          type: "MUSIC",
          year: null,
          library: { key: "1", mediaServerId: "s1" },
          externalIds: [],
        },
        ruleSetId: "rs1",
        actionType: "DELETE_LIDARR",
        matchedMediaItemIds: [],
        ruleSet: {
          name: "Music seerr",
          discordNotifyOnAction: false,
          userId: "u1",
          type: "MUSIC",
          rules: [{ field: "seerrRequested", operator: "equals", value: "false", enabled: true }],
        },
      },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "track1" }]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.delete.mockResolvedValue({});

    await executeLifecycleActions("u1");

    expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mockExecuteAction).not.toHaveBeenCalled();
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
          // The guard identifies a SERIES group by this, not by the title.
          seriesKey: "tvdb:1",
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
    // matched member). Second shape: the exception-guard's group lookup, which
    // selects `seriesKey` and `type` because a SERIES group is identified by
    // `seriesKey` — the title alone cannot tell two same-named shows apart, and
    // cannot recognise one show under two servers' titles.
    mockPrisma.lifecycleException.findMany.mockImplementation(
      async (args: { where?: { mediaItem?: unknown } }) =>
        args?.where?.mediaItem
          ? [{ mediaItem: { parentTitle: "Show", seriesKey: "tvdb:1", type: "SERIES" } }]
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
          // The guard identifies a SERIES group by this, not by the title.
          seriesKey: "tvdb:1",
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
          ? [{ mediaItem: { parentTitle: "Show", seriesKey: "tvdb:1", type: "SERIES" } }]
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

  it("leaves the remaining actions PENDING once their Arr instance fails at the host level", async () => {
    // A dead instance would otherwise cost the client's whole retry budget per
    // action on the serial MAIN_QUEUE, to reach the same failure.
    const { IntegrationError } = await import("@/lib/integration-error");
    const mediaItem = (n: number) => ({
      id: `item${n}`,
      title: `Movie ${n}`,
      parentTitle: null,
      year: 2024,
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [],
    });
    const action = (n: number, arrInstanceId: string) => ({
      id: `a${n}`,
      userId: "u1",
      mediaItemId: `item${n}`,
      mediaItem: mediaItem(n),
      ruleSetId: "rs1",
      actionType: "UNMONITOR_RADARR",
      arrInstanceId,
      ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
    });
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      action(1, "radarr-down"),
      action(2, "radarr-down"),
      action(3, "radarr-ok"),
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([1, 2, 3].map((n) => ({ ruleSetId: "rs1", mediaItemId: `item${n}` })));
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    mockExecuteAction.mockImplementation(async (a: { arrInstanceId: string }) => {
      if (a.arrInstanceId === "radarr-down") {
        throw new IntegrationError("Radarr", { config: { url: "/x", method: "get" }, code: "ECONNABORTED" } as never);
      }
    });
    mockExtractActionError.mockReturnValue("Radarr unreachable");
    mockPrisma.lifecycleAction.update.mockResolvedValue({});
    mockPrisma.$transaction.mockResolvedValue([]);

    await executeLifecycleActions("u1");

    const executedIds = mockExecuteAction.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(executedIds).toEqual(["a1", "a3"]);
    // a1 failed; a2 was neither executed nor touched — it stays PENDING.
    const updatedIds = mockPrisma.lifecycleAction.update.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toContain("a1");
    expect(updatedIds).not.toContain("a2");
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

    // The re-sync says why it runs, and skips the server-wide watch-history
    // scan: a deletion changes no play, and with several libraries touched the
    // scan ran once per library.
    expect(mockSyncMediaServer).toHaveBeenCalledWith(
      "s1",
      "1",
      { trigger: "lifecycle execution: re-sync after destructive actions", skipWatchHistory: true },
    );
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

  describe("a grouped action that runs", () => {
    // A series match is stored against a representative episode: its own
    // title, year and file size are the episode's, not the show's.
    const episode = {
      id: "rep1",
      title: "Pilot",
      parentTitle: "Battlestar Galactica",
      year: 2003,
      seriesKey: "tvdb:73545",
      libraryId: "lib1",
      fileSize: BigInt(100),
      library: { key: "1", mediaServerId: "s1" },
      externalIds: [{ source: "TVDB", externalId: "73545" }],
    };

    function showAction(actionType: string) {
      return {
        id: "a1",
        userId: "u1",
        mediaItemId: "rep1",
        mediaItemTitle: "Battlestar Galactica",
        mediaItemParentTitle: null,
        mediaItemYear: 2003,
        mediaItemExternalId: "73545",
        mediaItem: episode,
        ruleSetId: "rs1",
        actionType,
        matchedMediaItemIds: [],
        ruleSet: { name: "Shows", discordNotifyOnAction: true, userId: "u1", type: "SERIES", rules: [] },
      };
    }

    beforeEach(() => {
      mockPrisma.ruleMatch.findMany.mockResolvedValue([{ ruleSetId: "rs1", mediaItemId: "rep1" }]);
      mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
      mockPrisma.lifecycleAction.update.mockResolvedValue({});
      mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.appSettings.findMany.mockResolvedValue([
        { userId: "u1", discordWebhookUrl: "https://discord.com/webhook/123", discordWebhookUsername: null, discordWebhookAvatarUrl: null },
      ]);
      mockSyncMediaServer.mockResolvedValue(undefined);
      mockSendDiscordNotification.mockResolvedValue(undefined);
    });

    it("counts a whole-series delete by the show's seriesKey, not every show sharing its title", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([showAction("DELETE_SONARR")]);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({ _sum: { fileSize: BigInt(300) } });
      mockExecuteAction.mockResolvedValue(undefined);

      await executeLifecycleActions("u1");

      expect(mockPrisma.mediaItem.aggregate).toHaveBeenCalledWith({
        where: { type: "SERIES", libraryId: "lib1", seriesKey: "tvdb:73545" },
        _sum: { fileSize: true },
      });
      expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED", deletedBytes: BigInt(300) }) }),
      );
    });

    it("logs and records a series action by its show, never the episode it is stored against", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([
        { ...showAction("UNMONITOR_SONARR"), mediaItem: { ...episode, type: "SERIES", seasonNumber: 1, episodeNumber: 1 } },
      ]);
      mockExecuteAction.mockResolvedValue(undefined);

      await executeLifecycleActions("u1");

      const { logger } = await import("@/lib/logger");
      expect(logger.info).toHaveBeenCalledWith(
        "Lifecycle",
        'Executed UNMONITOR_SONARR for "Battlestar Galactica" in rule set "Shows"',
      );
      expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ mediaItemTitle: "Battlestar Galactica", mediaItemParentTitle: null }),
      }));
    });

    it("names a file delete on one episode by show and SxxExx in its log, Discord and history", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([{
        ...showAction("DELETE_FILES_SONARR"),
        matchedMediaItemIds: ["rep1"],
        mediaItem: { ...episode, type: "SERIES", seasonNumber: 1, episodeNumber: 1 },
      }]);
      mockPrisma.mediaItem.findMany.mockResolvedValue([{ fileSize: BigInt(100) }]);
      mockExecuteAction.mockResolvedValue(undefined);

      await executeLifecycleActions("u1");

      const { logger } = await import("@/lib/logger");
      expect(logger.info).toHaveBeenCalledWith(
        "Lifecycle",
        'Executed DELETE_FILES_SONARR for "Battlestar Galactica S01E01" in rule set "Shows"',
      );
      expect(mockBuildSuccessSummaryEmbed).toHaveBeenCalledWith("Shows", "DELETE_FILES_SONARR", ["Battlestar Galactica S01E01"]);
      expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          mediaItemTitle: "Battlestar Galactica",
          mediaItemSeasonNumber: 1,
          mediaItemEpisodeNumber: 1,
        }),
      }));
    });

    it("names a file delete on one episode it is not stored against after that episode", async () => {
      // Series scope forced by an aggregate field: stored against the show's
      // lowest-id episode, acting only on the one episode that matched.
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([{
        ...showAction("DELETE_FILES_SONARR"),
        matchedMediaItemIds: ["ep310"],
        mediaItem: { ...episode, type: "SERIES", seasonNumber: 1, episodeNumber: 1 },
      }]);
      mockPrisma.mediaItem.findMany.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
        args.select?.seasonNumber
          ? [{ id: "ep310", title: "Unfinished Business", seasonNumber: 3, episodeNumber: 10 }]
          : [{ fileSize: BigInt(100) }],
      );
      mockExecuteAction.mockResolvedValue(undefined);

      await executeLifecycleActions("u1");

      const { logger } = await import("@/lib/logger");
      expect(logger.info).toHaveBeenCalledWith(
        "Lifecycle",
        'Executed DELETE_FILES_SONARR for "Battlestar Galactica S03E10" in rule set "Shows"',
      );
      expect(mockBuildSuccessSummaryEmbed).toHaveBeenCalledWith("Shows", "DELETE_FILES_SONARR", ["Battlestar Galactica S03E10"]);
      expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ mediaItemSeasonNumber: 3, mediaItemEpisodeNumber: 10 }),
      }));
      mockPrisma.mediaItem.findMany.mockReset();
    });

    it("records the members it acted on, and names the one left after the rest stopped matching", async () => {
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        { ruleSetId: "rs1", mediaItemId: "rep1", itemData: { memberIds: ["ep2"] } },
      ]);
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([{
        ...showAction("DELETE_FILES_SONARR"),
        matchedMediaItemIds: ["rep1", "ep2"],
        mediaItem: { ...episode, type: "SERIES", seasonNumber: 1, episodeNumber: 1 },
      }]);
      mockPrisma.mediaItem.findMany.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
        args.select?.seasonNumber
          ? [{ id: "ep2", title: "Water", seasonNumber: 1, episodeNumber: 2 }]
          : [{ fileSize: BigInt(100) }],
      );
      mockExecuteAction.mockResolvedValue(undefined);

      await executeLifecycleActions("u1");

      expect(mockExecuteAction).toHaveBeenCalledWith(expect.objectContaining({ matchedMediaItemIds: ["ep2"] }));
      expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: "COMPLETED",
          matchedMediaItemIds: ["ep2"],
          mediaItemSeasonNumber: 1,
          mediaItemEpisodeNumber: 2,
        }),
      }));
      expect(mockBuildSuccessSummaryEmbed).toHaveBeenCalledWith("Shows", "DELETE_FILES_SONARR", ["Battlestar Galactica S01E02"]);
      mockPrisma.mediaItem.findMany.mockReset();
    });

    it("names the show when it cancels a series action that no longer matches", async () => {
      mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([
        { ...showAction("DELETE_SONARR"), mediaItem: { ...episode, type: "SERIES", seasonNumber: 1, episodeNumber: 1 } },
      ]);
      mockPrisma.lifecycleAction.delete.mockResolvedValue({});

      await executeLifecycleActions("u1");

      const { logger } = await import("@/lib/logger");
      expect(logger.info).toHaveBeenCalledWith(
        "Lifecycle",
        'Deleted stale action a1 — "Battlestar Galactica" is no longer a match for rule set "Shows"',
      );
    });

    it("names the show in Discord without the episode's year, on success and on failure", async () => {
      mockPrisma.lifecycleAction.findMany.mockResolvedValue([showAction("UNMONITOR_SONARR")]);
      mockExecuteAction.mockResolvedValue(undefined);
      await executeLifecycleActions("u1");
      expect(mockBuildSuccessSummaryEmbed).toHaveBeenCalledWith("Shows", "UNMONITOR_SONARR", ["Battlestar Galactica"]);

      mockPrisma.lifecycleAction.findMany.mockResolvedValue([showAction("UNMONITOR_SONARR")]);
      mockExecuteAction.mockRejectedValue(new Error("Sonarr said no"));
      mockExtractActionError.mockReturnValue("Sonarr said no");
      await executeLifecycleActions("u1");
      expect(mockBuildFailureSummaryEmbed).toHaveBeenCalledWith(
        "Shows",
        "UNMONITOR_SONARR",
        [{ title: "Battlestar Galactica", error: "Sonarr said no" }],
      );
    });
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

  describe("deletion ceiling", () => {
    /** Two pending DELETE_RADARR actions for one user, both currently matching. */
    function setupTwoPendingDeletes() {
      const items = ["item1", "item2"].map((id) => ({
        id,
        title: `Movie ${id}`,
        parentTitle: null,
        year: 2024,
        library: { key: "1", mediaServerId: "s1" },
        externalIds: [],
      }));
      mockPrisma.lifecycleAction.findMany.mockResolvedValue(
        items.map((mediaItem, i) => ({
          id: `a${i + 1}`,
          userId: "u1",
          mediaItemId: mediaItem.id,
          mediaItem,
          ruleSetId: "rs1",
          actionType: "DELETE_RADARR",
          ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
        })),
      );
      mockPrisma.ruleMatch.findMany.mockResolvedValue(
        items.map((m) => ({ ruleSetId: "rs1", mediaItemId: m.id })),
      );
      mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
      mockExecuteAction.mockResolvedValue(undefined);
      mockPrisma.lifecycleAction.update.mockResolvedValue({});
      mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
    }

    // The automated executor is the path that fires with nobody watching, so it
    // is the one the ceiling exists for. Held actions stay PENDING and
    // untouched — the Pending page's existing Execute button IS the manual
    // approval, so there is no separate approval queue to build or to desync.
    it("holds destructive actions when the run exceeds the ceiling", async () => {
      mockPrisma.appSettings.findFirst.mockResolvedValue({ maxAutoDeleteItems: 1 });
      setupTwoPendingDeletes();

      await executeLifecycleActions();

      expect(mockExecuteAction).not.toHaveBeenCalled();
      // Untouched, not cancelled: the user still needs to find and run them.
      expect(mockPrisma.lifecycleAction.update).not.toHaveBeenCalled();
      expect(mockPrisma.lifecycleAction.delete).not.toHaveBeenCalled();
    });

    it("runs normally when the ceiling is not configured", async () => {
      mockPrisma.appSettings.findFirst.mockResolvedValue(null);
      setupTwoPendingDeletes();

      await executeLifecycleActions();

      expect(mockExecuteAction).toHaveBeenCalledTimes(2);
    });

    // The count has to be what the run would ACTUALLY destroy. Counting the
    // raw pending list instead counted actions that are about to be cancelled
    // for being stale, excepted, identity-swapped or sibling-protected — so a
    // ceiling of 1 was tripped by a batch whose real destructive count was 1,
    // the run was held, the operator was told a number that was never true,
    // and (because the held branch used to `continue` ahead of those checks)
    // the doomed actions were not cleaned up either, so the next run counted
    // them again.
    it("does not count actions it is about to cancel as stale", async () => {
      mockPrisma.appSettings.findFirst.mockResolvedValue({ maxAutoDeleteItems: 1 });
      setupTwoPendingDeletes();
      // item2 stopped matching, so its action is cancelled, not executed.
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        { ruleSetId: "rs1", mediaItemId: "item1" },
      ]);
      mockPrisma.lifecycleAction.delete.mockResolvedValue({});

      await executeLifecycleActions();

      // One real destructive target, ceiling of 1 — under the limit, so it runs.
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
      // ...and the stale one is cleaned up rather than left to inflate the
      // next run's count too.
      expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a2" } });
    });

    it("cancels doomed actions even when the ceiling holds the run", async () => {
      mockPrisma.appSettings.findFirst.mockResolvedValue({ maxAutoDeleteItems: 1 });
      // Three pending deletes, one of which no longer matches: two survivors
      // against a ceiling of one, so the run is held.
      const ids = ["item1", "item2", "item3"];
      mockPrisma.lifecycleAction.findMany.mockResolvedValue(
        ids.map((id, i) => ({
          id: `a${i + 1}`,
          userId: "u1",
          mediaItemId: id,
          mediaItem: {
            id,
            title: `Movie ${id}`,
            parentTitle: null,
            year: 2024,
            library: { key: "1", mediaServerId: "s1" },
            externalIds: [],
          },
          ruleSetId: "rs1",
          actionType: "DELETE_RADARR",
          ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
        })),
      );
      mockPrisma.ruleMatch.findMany.mockResolvedValue([
        { ruleSetId: "rs1", mediaItemId: "item1" },
        { ruleSetId: "rs1", mediaItemId: "item2" },
      ]);
      mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
      mockExecuteAction.mockResolvedValue(undefined);
      mockPrisma.lifecycleAction.update.mockResolvedValue({});
      mockPrisma.lifecycleAction.delete.mockResolvedValue({});

      await executeLifecycleActions();

      // Held: nothing was destroyed...
      expect(mockExecuteAction).not.toHaveBeenCalled();
      // ...but the filtering still ran, so the stale action is gone and the
      // hold cannot feed on its own leftovers.
      expect(mockPrisma.lifecycleAction.delete).toHaveBeenCalledWith({ where: { id: "a3" } });
      // The surviving actions are untouched, waiting for the Pending page.
      expect(mockPrisma.lifecycleAction.delete).not.toHaveBeenCalledWith({ where: { id: "a1" } });
      expect(mockPrisma.lifecycleAction.delete).not.toHaveBeenCalledWith({ where: { id: "a2" } });
    });

    it("runs normally at exactly the ceiling", async () => {
      mockPrisma.appSettings.findFirst.mockResolvedValue({ maxAutoDeleteItems: 2 });
      setupTwoPendingDeletes();

      await executeLifecycleActions();

      expect(mockExecuteAction).toHaveBeenCalledTimes(2);
    });
  });

  // A run queued through `POST /api/v1/jobs/execution` is held to the same
  // limits the execute endpoint enforces — 25 destructive items per request,
  // 100 per hour across every key — or queueing a run would be the way round
  // them. A scheduled run (no `viaApiKey`) is never affected.
  describe("a run queued through an API key", () => {
    function setupPendingDeletes(count: number, actionType = "DELETE_RADARR") {
      const items = Array.from({ length: count }, (_, i) => ({
        id: `item${i}`,
        title: `Movie ${i}`,
        parentTitle: null,
        year: 2024,
        library: { key: "1", mediaServerId: "s1" },
        externalIds: [],
      }));
      mockPrisma.lifecycleAction.findMany.mockResolvedValue(
        items.map((mediaItem, i) => ({
          id: `a${i}`,
          userId: "u1",
          mediaItemId: mediaItem.id,
          mediaItem,
          ruleSetId: "rs1",
          actionType,
          ruleSet: { name: "Test", discordNotifyOnAction: false, userId: "u1" },
        })),
      );
      mockPrisma.ruleMatch.findMany.mockResolvedValue(items.map((m) => ({ ruleSetId: "rs1", mediaItemId: m.id })));
      mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
      mockPrisma.appSettings.findFirst.mockResolvedValue(null);
      mockExecuteAction.mockResolvedValue(undefined);
      mockPrisma.lifecycleAction.update.mockResolvedValue({});
      mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 1 });
    }

    beforeEach(async () => {
      const { resetApiDestructiveBudget } = await import("@/lib/api-keys/destructive-budget");
      resetApiDestructiveBudget();
    });

    it("holds the whole run when it would delete more than 25 items", async () => {
      setupPendingDeletes(26);
      await executeLifecycleActions("u1", { viaApiKey: "n8n" });
      expect(mockExecuteAction).not.toHaveBeenCalled();
      // Left pending for the schedule or the Pending page — not cancelled.
      expect(mockPrisma.lifecycleAction.update).not.toHaveBeenCalled();
      expect(mockPrisma.lifecycleAction.delete).not.toHaveBeenCalled();
    });

    it("runs up to 25, charging them to the hourly budget, then holds once it is spent", async () => {
      for (let i = 0; i < 4; i++) {
        vi.clearAllMocks();
        setupPendingDeletes(25);
        await executeLifecycleActions("u1", { viaApiKey: "n8n" });
        expect(mockExecuteAction).toHaveBeenCalledTimes(25);
      }
      vi.clearAllMocks();
      setupPendingDeletes(1);
      await executeLifecycleActions("u1", { viaApiKey: "n8n" });
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });

    it("still applies non-destructive actions a held run carries", async () => {
      setupPendingDeletes(26, "UNMONITOR_RADARR");
      await executeLifecycleActions("u1", { viaApiKey: "n8n" });
      expect(mockExecuteAction).toHaveBeenCalledTimes(26);
    });

    it("never limits a scheduled run", async () => {
      setupPendingDeletes(30);
      await executeLifecycleActions("u1");
      expect(mockExecuteAction).toHaveBeenCalledTimes(30);
    });
  });

});
