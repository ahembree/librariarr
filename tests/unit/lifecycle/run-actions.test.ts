import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  executeAction: vi.fn(),
  prisma: {
    lifecycleAction: { create: vi.fn(), deleteMany: vi.fn() },
    ruleMatch: { deleteMany: vi.fn() },
    mediaItem: { aggregate: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: m.prisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/actions")>()),
  executeAction: m.executeAction,
}));

import { executeActionsForItems } from "@/lib/lifecycle/run-actions";
import { IntegrationError } from "@/lib/integration-error";

const CONFIG = {
  actionType: "UNMONITOR_RADARR",
  arrInstanceId: "radarr-1",
  targetQualityProfileId: null,
  addImportExclusion: false,
  searchAfterAction: false,
  addArrTags: [],
  removeArrTags: [],
};
const HISTORY = { ruleSetId: null, ruleSetName: "Query", ruleSetType: "MOVIE" };

const item = (n: number) => ({
  id: `m${n}`,
  type: "MOVIE",
  title: `Movie ${n}`,
  parentTitle: null,
  seasonNumber: null,
  episodeNumber: null,
  year: 2020,
  fileSize: null,
  libraryId: "lib",
  externalIds: [],
});

function radarrReadError(status: number | null) {
  return new IntegrationError("Radarr", {
    // A read: only a read has been through the retries, so only a read's
    // timeout says the host is down (see isHostLevelFailure).
    config: { url: "/api/v3/movie", method: "get" },
    code: status === null ? "ECONNABORTED" : "ERR_BAD_RESPONSE",
    response: status === null ? undefined : { status, data: {} },
  } as never);
}

describe("executeActionsForItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.prisma.$transaction.mockResolvedValue([]);
    m.prisma.lifecycleAction.create.mockResolvedValue({});
  });

  it("fails the remaining items at once when the Arr instance is down, without asking it again", async () => {
    // Each attempt against a dead instance costs the client's whole retry budget.
    m.executeAction.mockRejectedValue(radarrReadError(null));

    const result = await executeActionsForItems("u1", [item(1), item(2), item(3)], CONFIG, new Map(), HISTORY);

    expect(m.executeAction).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(3);
    expect(result.executed).toBe(0);
    // The two never sent are reported as such (the public API refunds them).
    expect(result.notAttempted).toBe(2);
    // Every item still gets its FAILED history row, carrying the host error.
    expect(m.prisma.lifecycleAction.create).toHaveBeenCalledTimes(3);
    for (const f of result.failures) expect(f.error).toMatch(/Radarr did not answer in time/);
  });

  it("stops where beforeEach answers a reason, leaving that item and the rest untouched", async () => {
    // The rule-set Execute route re-checks before each item that the rule set
    // is still the version it judged the items under.
    m.executeAction.mockResolvedValue({});
    const asked: string[] = [];
    const beforeEach = vi.fn(async (it: { id: string }) => {
      asked.push(it.id);
      return it.id === "m2" ? "The rule set was edited" : null;
    });

    const result = await executeActionsForItems("u1", [item(1), item(2), item(3)], CONFIG, new Map(), HISTORY, undefined, { beforeEach });

    expect(asked).toEqual(["m1", "m2"]);
    expect(m.executeAction).toHaveBeenCalledTimes(1);
    expect(m.executeAction.mock.calls[0][0]).toMatchObject({ mediaItem: { id: "m1" } });
    expect(result).toMatchObject({ executed: 1, failed: 0, stopped: { reason: "The rule set was edited", remaining: 2 } });
    // Only the item that ran is recorded.
    expect(m.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(m.prisma.lifecycleAction.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.lifecycleAction.create.mock.calls[0][0]).toMatchObject({ data: { mediaItemId: "m1", status: "COMPLETED" } });
  });

  it("runs every item and reports no stop without beforeEach, or while it answers null", async () => {
    m.executeAction.mockResolvedValue({});
    const plain = await executeActionsForItems("u1", [item(1), item(2)], CONFIG, new Map(), HISTORY);
    expect(plain.stopped).toBeUndefined();
    const checked = await executeActionsForItems("u1", [item(1), item(2)], CONFIG, new Map(), HISTORY, undefined, {
      beforeEach: async () => null,
    });
    expect(checked).toMatchObject({ executed: 2 });
    expect(checked.stopped).toBeUndefined();
  });

  it("keeps going after a write times out — a slow write is not a dead host", async () => {
    // A bulk episode-file delete into a recycle bin on another mount outlives
    // the client timeout while the app is healthy; writes are never retried.
    const slowDelete = new IntegrationError("Radarr", {
      config: { url: "/api/v3/moviefile/1", method: "delete" },
      code: "ECONNABORTED",
    } as never);
    m.executeAction.mockRejectedValueOnce(slowDelete).mockResolvedValue(undefined);

    const result = await executeActionsForItems("u1", [item(1), item(2), item(3)], CONFIG, new Map(), HISTORY);

    expect(m.executeAction).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ executed: 2, failed: 1, notAttempted: 0 });
  });

  it("keeps going after an item-specific failure", async () => {
    m.executeAction
      .mockRejectedValueOnce(radarrReadError(404))
      .mockResolvedValue(undefined);

    const result = await executeActionsForItems("u1", [item(1), item(2), item(3)], CONFIG, new Map(), HISTORY);

    expect(m.executeAction).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ executed: 2, failed: 1, notAttempted: 0 });
    expect(result.failures.map((f) => f.title)).toEqual(["Movie 1"]);
  });

  it("still records a failure whose item was purged mid-run, and carries on", async () => {
    // The item's row went while its Arr call ran: the FAILED row's foreign key
    // no longer resolves, so it is written without its links.
    m.executeAction.mockRejectedValueOnce(radarrReadError(404)).mockResolvedValue(undefined);
    m.prisma.lifecycleAction.create.mockRejectedValueOnce(new Error("Foreign key constraint violated"));

    const result = await executeActionsForItems("u1", [item(1), item(2)], CONFIG, new Map(), HISTORY);

    expect(result).toMatchObject({ executed: 1, failed: 1 });
    expect(m.prisma.lifecycleAction.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ mediaItemId: "m1", status: "FAILED" }),
    });
    expect(m.prisma.lifecycleAction.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ mediaItemId: null, ruleSetId: null, status: "FAILED", mediaItemTitle: "Movie 1" }),
    });
    expect(m.executeAction).toHaveBeenCalledTimes(2);
  });

  describe("naming a series item", () => {
    // Episodes are stored against their show; `title` is the episode's own.
    const episode = (n: number) => ({
      id: `ep${n}`,
      type: "SERIES",
      title: `Episode Title ${n}`,
      parentTitle: "Breaking Bad",
      seasonNumber: 2,
      episodeNumber: n,
      year: 2009,
      fileSize: null,
      libraryId: "lib",
      externalIds: [],
    });
    const SERIES_HISTORY = { ruleSetId: null, ruleSetName: "Query", ruleSetType: "SERIES" };

    it("passes a step's share of the item through to the progress", async () => {
      m.executeAction.mockImplementation(async (_action: unknown, onStep?: (label: string, fraction?: number) => void) => {
        onStep?.("Delete Files Only (Sonarr) — 25 of 100 files deleted", 0.25);
        return {};
      });
      const seen: Array<{ step: string; fraction?: number }> = [];

      await executeActionsForItems(
        "u1",
        [episode(1)],
        { ...CONFIG, actionType: "DELETE_FILES_SONARR", arrInstanceId: "sonarr-1" },
        new Map([["ep1", ["ep1"]]]),
        SERIES_HISTORY,
        ({ current }) => { if (current) seen.push({ step: current.step, fraction: current.fraction }); },
      );

      expect(seen).toContainEqual({ step: "Delete Files Only (Sonarr) — 25 of 100 files deleted", fraction: 0.25 });
    });

    it("names a whole-series action by the show in its progress, errors and failures", async () => {
      m.executeAction.mockRejectedValue(new Error("Series not found in Sonarr"));
      const steps: string[] = [];

      const result = await executeActionsForItems(
        "u1",
        [episode(1)],
        { ...CONFIG, actionType: "DELETE_SONARR", arrInstanceId: "sonarr-1" },
        new Map([["ep1", ["ep1", "ep2"]]]),
        SERIES_HISTORY,
        ({ current }) => { if (current) steps.push(current.title); },
      );

      expect(steps).toEqual(["Breaking Bad"]);
      expect(result.errors).toEqual(["Breaking Bad: Series not found in Sonarr"]);
      expect(result.failures).toEqual([{ title: "Breaking Bad", error: "Series not found in Sonarr" }]);
      // The history row records the show, not the episode it is stored against.
      expect(m.prisma.lifecycleAction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ mediaItemTitle: "Breaking Bad", mediaItemParentTitle: null }),
      });
    });

    it("names a file delete on one episode it is not stored against after that episode", async () => {
      m.executeAction.mockRejectedValue(new Error("No episode file"));
      m.prisma.mediaItem.findMany.mockResolvedValueOnce([
        { id: "ep10", title: "Fly", seasonNumber: 3, episodeNumber: 10 },
      ]);

      const result = await executeActionsForItems(
        "u1",
        [episode(1)],
        { ...CONFIG, actionType: "DELETE_FILES_SONARR", arrInstanceId: "sonarr-1" },
        new Map([["ep1", ["ep10"]]]),
        SERIES_HISTORY,
      );

      expect(result.errors).toEqual(["Breaking Bad S03E10: No episode file"]);
      expect(m.executeAction).toHaveBeenCalledWith(
        expect.objectContaining({ targetTitle: "Breaking Bad S03E10" }),
        undefined,
        expect.anything(),
      );
      expect(m.prisma.lifecycleAction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ mediaItemSeasonNumber: 3, mediaItemEpisodeNumber: 10 }),
      });
    });

    it("names a file delete on one episode by show and SxxExx", async () => {
      m.executeAction.mockRejectedValue(new Error("No episode file"));

      const result = await executeActionsForItems(
        "u1",
        [episode(5)],
        { ...CONFIG, actionType: "DELETE_FILES_SONARR", arrInstanceId: "sonarr-1" },
        new Map([["ep5", ["ep5"]]]),
        SERIES_HISTORY,
      );

      expect(result.errors).toEqual(["Breaking Bad S02E05: No episode file"]);
      expect(m.prisma.lifecycleAction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaItemTitle: "Breaking Bad",
          mediaItemSeasonNumber: 2,
          mediaItemEpisodeNumber: 5,
        }),
      });
    });
  });
});
