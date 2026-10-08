import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

/**
 * The targeted recovery pass for a re-added item, whose plays the cascade
 * deleted with its old row. The invariants worth locking down are the ones
 * whose failure is invisible: `rating_key` takes ONE value per request, so the
 * 7-day window and the cap are what bound the request count, and the records
 * must go through the shared importer — a second copy of the row mapping or
 * the ON CONFLICT merge would drift silently.
 */

const m = vi.hoisted(() => ({
  prisma: {
    mediaServer: { findFirst: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getHistoryForItem: vi.fn(),
  getServerAccountNames: vi.fn(),
  buildTracearrJoinIndex: vi.fn(),
  resolveMediaItemId: vi.fn(),
  importTracearrRecords: vi.fn(),
  resolveInstanceForServer: vi.fn(),
  forwardPassBoundary: vi.fn(),
  reconcileWatchStateFromHistory: vi.fn(),
  invalidateMediaCaches: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: m.prisma }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: m.invalidateMediaCaches }));
vi.mock("@/lib/sync/watch-reconcile", () => ({ reconcileWatchStateFromHistory: m.reconcileWatchStateFromHistory }));
vi.mock("@/lib/sync/tracearr-join", () => ({
  buildTracearrJoinIndex: m.buildTracearrJoinIndex,
  resolveMediaItemId: m.resolveMediaItemId,
}));
vi.mock("@/lib/sync/sync-tracearr-history", () => ({
  importTracearrRecords: m.importTracearrRecords,
  resolveInstanceForServer: m.resolveInstanceForServer,
  forwardPassBoundary: m.forwardPassBoundary,
}));
vi.mock("@/lib/tracearr/tracearr-client", () => ({
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryForItem = m.getHistoryForItem;
    this.getServerAccountNames = m.getServerAccountNames;
  },
}));

import { IntegrationError } from "@/lib/integration-error";
import {
  recoverHistoryForNewItems,
  RECENT_ADDITION_WINDOW_MS,
  DEFAULT_CANDIDATE_LIMIT,
  MAX_CANDIDATE_LIMIT,
  MAX_RECOVERY_ASKS,
  RECOVERY_REASK_MS,
  resetRecoveryAnswers,
} from "@/lib/sync/tracearr-backfill-additions";
import { TracearrMappingChangedError } from "@/lib/sync/tracearr-mapping-changed";

const SERVER_ID = "server-1";
const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";
const MAPPING_VERSION = 6;
/** The guard the pass hands the shared importer: the mapping AND its version. */
const GUARD = { tracearrServerId: TRACEARR_SERVER_ID, mappingVersion: MAPPING_VERSION };
/** The join index is opaque here — only that the SAME one is reused matters. */
const JOIN_INDEX = { serverId: SERVER_ID, itemCount: 3 };
/** The account-name map: the only state in which this pass may write. */
const NAMES = new Map([["srv-user-1", "weingart"]]);

/** Only `id`, `server_id` and `started_at` are read here; the mapping is the importer's business. */
function play(id: string, startedAt?: string, serverId = TRACEARR_SERVER_ID): TracearrHistoryRecord {
  return { id, server_id: serverId, ...(startedAt ? { started_at: startedAt } : {}) } as TracearrHistoryRecord;
}

type Candidate = {
  id: string;
  ratingKey: string;
  title: string;
  type?: string;
  parentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  tmdbId: string | null;
  imdbId: string | null;
};

/** A movie candidate with no provider ids: the rating-key path alone, unless a test adds some. */
function candidate(n: number, extra: Partial<Candidate> = {}): Candidate {
  return { id: `item-${n}`, ratingKey: `${1000 + n}`, title: `Item ${n}`, type: "MOVIE", tmdbId: null, imdbId: null, ...extra };
}

let candidates: Candidate[];

/** The candidate query's SQL and bind params. */
function candidateQuery(): { sql: string; params: unknown[] } {
  const call = m.prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
  return { sql: call[0], params: call.slice(1) };
}

/** Another pass; which ids its candidate query left out, and which it offered again as due. */
async function nextPassAnswered() {
  m.prisma.$queryRawUnsafe.mockClear();
  await recoverHistoryForNewItems(SERVER_ID);
  return { excluded: candidateQuery().params[3], due: candidateQuery().params[4] };
}

function serverRow(extra: Record<string, unknown> = {}) {
  return {
    id: SERVER_ID,
    name: "Test Plex",
    enabled: true,
    tracearrServerId: TRACEARR_SERVER_ID,
    tracearrMappingVersion: MAPPING_VERSION,
    tracearrBackfillComplete: true,
    userId: "user-1",
    ...extra,
  };
}

function imports(inserted: number, updated: number, skipped: number, rowsInserted: number) {
  m.importTracearrRecords.mockResolvedValue({ inserted, updated, skipped, rowsInserted });
}

function tracearrError(code: string, status?: number) {
  return new IntegrationError("Tracearr", {
    config: { url: "/api/v2/public/history", method: "get" },
    code,
    response: status === undefined ? undefined : { status, data: {} },
  } as never);
}

const askedFilters = () => m.getHistoryForItem.mock.calls.map((c) => c[1]);
const NONE = { checked: 0, imported: 0 };

describe("recoverHistoryForNewItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRecoveryAnswers();
    candidates = [candidate(1)];
    m.prisma.mediaServer.findFirst.mockResolvedValue(serverRow());
    m.prisma.$queryRawUnsafe.mockImplementation(async () => candidates);
    // Far ahead unless a test says otherwise.
    m.forwardPassBoundary.mockResolvedValue(new Date("2100-01-01T00:00:00.000Z"));
    m.resolveInstanceForServer.mockResolvedValue({ id: "tracearr-1", name: "Tracearr", url: "http://tracearr:8080", apiKey: "key" });
    m.buildTracearrJoinIndex.mockResolvedValue(JOIN_INDEX);
    // Every play resolves to the first candidate unless a test says otherwise.
    m.resolveMediaItemId.mockReturnValue({ mediaItemId: "item-1" });
    m.getHistoryForItem.mockResolvedValue([]);
    m.getServerAccountNames.mockResolvedValue(NAMES);
    imports(0, 0, 0, 0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("candidate selection", () => {
    it("shapes the candidate query: this server, no Tracearr play from well before creation, never-asked first", async () => {
      await recoverHistoryForNewItems(SERVER_ID);

      const { sql, params } = candidateQuery();
      expect(sql).toContain('l."mediaServerId" = $1');
      expect(params[0]).toBe(SERVER_ID);
      // A re-added item's first NEW play usually lands before this pass, so
      // "has any TRACEARR row" must not end candidacy; a play from a window
      // before `createdAt` (only the walk or a recovery stores one) does.
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain(`wh."source" = 'TRACEARR'`);
      expect(sql).toContain(`wh."watchedAt" < mi."createdAt" - ($6::integer * interval '1 second')`);
      expect(params[5]).toBe(RECENT_ADDITION_WINDOW_MS / 1000);
      expect(sql).toContain('NOT (mi."id" = ANY($4::text[]))');
      expect(sql).toContain('ORDER BY (mi."id" = ANY($5::text[])) ASC, mi."createdAt" DESC, mi."id" ASC');
      expect(params[4]).toEqual([]);
    });

    it("restricts candidates to the recent-addition window", async () => {
      const before = Date.now();
      await recoverHistoryForNewItems(SERVER_ID);
      const after = Date.now();

      // Without it the candidates are most of a library, one request each, every run.
      const { sql, params } = candidateQuery();
      expect(sql).toContain('mi."createdAt" > $2');
      const addedAfter = params[1] as Date;
      expect(addedAfter.getTime()).toBeGreaterThanOrEqual(before - RECENT_ADDITION_WINDOW_MS);
      expect(addedAfter.getTime()).toBeLessThanOrEqual(after - RECENT_ADDITION_WINDOW_MS);
      expect(RECENT_ADDITION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it.each([
      [undefined, DEFAULT_CANDIDATE_LIMIT],
      [5, 5],
      // A caller may ask for less of the budget, never more.
      [50_000, MAX_CANDIDATE_LIMIT],
    ])("caps the candidate count (limit %s → %i), because the cap IS the request budget", async (limit, cap) => {
      await recoverHistoryForNewItems(SERVER_ID, limit === undefined ? {} : { limit });
      expect(candidateQuery().sql).toContain("LIMIT $3");
      expect(candidateQuery().params[2]).toBe(cap);
    });

    it("does no work at all when nothing has been added", async () => {
      candidates = [];

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual(NONE);
      // The steady state: one indexed query, no instance lookup, join index or HTTP.
      expect(m.resolveInstanceForServer).not.toHaveBeenCalled();
      expect(m.buildTracearrJoinIndex).not.toHaveBeenCalled();
      expect(m.getHistoryForItem).not.toHaveBeenCalled();
    });

    it.each([
      ["a disabled server", { enabled: false }],
      ["an unmapped server", { tracearrServerId: null }],
      // By its own read of the row: the task's view predates a restart or a
      // re-link, and plays written into an archive owed a walk would become
      // its resume boundary.
      ["an archive whose walk is not complete", { tracearrBackfillComplete: false }],
    ])("does nothing for %s, querying nothing", async (_label, extra) => {
      m.prisma.mediaServer.findFirst.mockResolvedValue(serverRow(extra));

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual(NONE);
      expect(m.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(m.resolveInstanceForServer).not.toHaveBeenCalled();
      expect(m.getHistoryForItem).not.toHaveBeenCalled();
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
    });
  });

  describe("lookup and import", () => {
    it("issues exactly one request per candidate rating key, on the mapped Tracearr server", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];

      await recoverHistoryForNewItems(SERVER_ID);

      expect(askedFilters()).toEqual([{ ratingKey: "1001" }, { ratingKey: "1002" }, { ratingKey: "1003" }]);
      for (const call of m.getHistoryForItem.mock.calls) expect(call[0]).toBe(TRACEARR_SERVER_ID);
    });

    it("upserts found records through the shared importer and join index, then reconciles and drops caches", async () => {
      const records = [play("chain-1"), play("chain-2")];
      m.getHistoryForItem.mockResolvedValue(records);
      imports(2, 0, 0, 2);

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 2 });
      // The shared path, with the account map (one username vocabulary per
      // server) and the mapping AND version every write re-checks.
      expect(m.importTracearrRecords).toHaveBeenCalledWith(SERVER_ID, records, JOIN_INDEX, NAMES, GUARD);
      // Without the reconcile the item still reports playCount 0 to the rules.
      expect(m.reconcileWatchStateFromHistory).toHaveBeenCalledWith(SERVER_ID);
      expect(m.invalidateMediaCaches).toHaveBeenCalledTimes(1);
    });

    it("stores only plays at or below the forward boundary, read once with the server's walk state", async () => {
      // A newer play stored here would move MAX(watchedAt) past plays no walk has read.
      const boundary = new Date("2026-06-10T12:00:00.000Z");
      m.forwardPassBoundary.mockResolvedValue(boundary);
      const older = play("chain-old", "2026-05-01T00:00:00.000Z");
      const atBoundary = play("chain-edge", boundary.toISOString());
      m.getHistoryForItem.mockResolvedValue([older, atBoundary, play("chain-new", "2026-06-10T13:00:00.000Z")]);
      imports(2, 0, 0, 2);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.importTracearrRecords).toHaveBeenCalledWith(SERVER_ID, [older, atBoundary], JOIN_INDEX, NAMES, GUARD);
      expect(m.forwardPassBoundary).toHaveBeenCalledTimes(1);
      expect(m.forwardPassBoundary).toHaveBeenCalledWith(SERVER_ID, {
        backfillComplete: true,
        cursorAt: undefined,
        forwardFloorAt: undefined,
        lastWalkAt: undefined,
        forwardWatermarkAt: undefined,
      });
    });

    // A play left to the catch-up keeps the item deferred, however its other
    // plays resolved: the catch-up can step over it (a Refresh whose join index
    // predates the item), and a day on it is old enough to store here.
    it.each([
      ["its plays are all newer than the boundary", [], null, 0],
      ["its older plays resolved to it", ["chain-old"], null, 0],
      // The new play resolving here says nothing about where its OLD ones went.
      ["only its newer play resolves to it", ["chain-old"], "old-copy", 1],
    ])("defers an item with a play left to the catch-up when %s", async (_label, stored, oldResolvesTo, elsewhere) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
      m.forwardPassBoundary.mockResolvedValue(new Date("2026-09-30T12:00:00.000Z"));
      const old = play("chain-old", "2026-05-01T00:00:00.000Z");
      const recent = play("chain-new", "2026-09-30T13:00:00.000Z");
      m.getHistoryForItem.mockResolvedValue(stored.length > 0 ? [old, recent] : [recent]);
      if (oldResolvesTo) {
        m.resolveMediaItemId.mockImplementation((_index: unknown, record: { id: string }) =>
          record.id === "chain-new" ? { mediaItemId: "item-1" } : { mediaItemId: oldResolvesTo },
        );
      }

      await recoverHistoryForNewItems(SERVER_ID);

      if (stored.length > 0) {
        expect(m.importTracearrRecords).toHaveBeenCalledWith(SERVER_ID, [old], JOIN_INDEX, NAMES, GUARD);
      } else {
        expect(m.importTracearrRecords).not.toHaveBeenCalled();
      }
      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("1 play(s) newer than the catch-up's boundary left to it (their 1 item(s) asked again later)"),
      );
      // Resolved here or not is judged by the plays stored here only.
      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining(`with no plays, ${elsewhere} deferred (no play resolved to the item itself)`),
      );
      // Left out straight after, offered again a day later.
      expect(await nextPassAnswered()).toEqual({ excluded: ["item-1"], due: [] });
      vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
      expect(await nextPassAnswered()).toEqual({ excluded: [], due: ["item-1"] });
    });

    it("builds the join index once for the whole pass", async () => {
      // It loads every candidate item on the server; per item, the pass is quadratic.
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      imports(1, 0, 0, 1);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.buildTracearrJoinIndex).toHaveBeenCalledTimes(1);
      expect(m.buildTracearrJoinIndex).toHaveBeenCalledWith(SERVER_ID);
    });

    it("counts only NEW rows as imported, and neither reconciles nor drops caches when every row only merged", async () => {
      // `imported` drives the caller's reconcile, cache drop and page refetch.
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      imports(0, 3, 2, 0);

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 0 });
      expect(m.reconcileWatchStateFromHistory).not.toHaveBeenCalled();
      expect(m.invalidateMediaCaches).not.toHaveBeenCalled();
    });

    it("handles an item Tracearr has no plays for without writing anything", async () => {
      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 0 });
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect(m.reconcileWatchStateFromHistory).not.toHaveBeenCalled();
      expect(m.invalidateMediaCaches).not.toHaveBeenCalled();
      expect(m.logger.warn).not.toHaveBeenCalled();
    });

    it("drops records belonging to another media server on the same Tracearr", async () => {
      // A rating key is unique only within one server: a stranger's play, never walked back.
      m.getHistoryForItem.mockResolvedValue([play("chain-1", undefined, "some-other-server")]);

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 0 });
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
    });

    it("keeps the imported rows when the reconcile fails", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      imports(1, 0, 0, 1);
      m.reconcileWatchStateFromHistory.mockRejectedValue(new Error("db down"));

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 1 });
      expect(m.logger.warn).toHaveBeenCalled();
    });
  });

  describe("stopping and failure", () => {
    it("stops between items when the signal aborts, handing the signal to the client too", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      const controller = new AbortController();
      m.getHistoryForItem.mockImplementation(async () => {
        controller.abort();
        return [];
      });

      expect(await recoverHistoryForNewItems(SERVER_ID, { signal: controller.signal })).toEqual({ checked: 1, imported: 0 });
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(m.getHistoryForItem.mock.calls[0][2]).toEqual({ signal: controller.signal });
    });

    it.each([
      ["a plain error", new Error("tracearr 429"), "429"],
      // An item-specific 500 says nothing about the host.
      ["an item-specific 500", tracearrError("ERR_BAD_RESPONSE", 500), "500"],
    ])("keeps going after one item's lookup fails with %s", async (_label, error, detail) => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem.mockRejectedValueOnce(error).mockResolvedValue([play("chain-1")]);
      imports(1, 0, 0, 1);

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 3, imported: 2 });
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(3);
      expect(m.logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Item 1"),
        expect.objectContaining({ error: expect.stringContaining(detail) }),
      );
      expect(m.logger.warn).not.toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Stopping Tracearr play recovery"),
        expect.anything(),
      );
    });

    it.each([
      ["unreachable", null],
      ["a 5xx", 503],
      ["a 429 that outlasted its budget", 429],
    ])("stops the pass when Tracearr itself fails (%s)", async (_label, status) => {
      // Every remaining candidate would pay the client's whole retry budget on the serial queue.
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem.mockRejectedValue(
        status === null ? tracearrError("ECONNABORTED") : tracearrError("ERR_BAD_RESPONSE", status),
      );

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 0 });
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(m.logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Stopping Tracearr play recovery"),
        expect.anything(),
      );
    });

    it("names an episode it could not recover by its show and SxxExx", async () => {
      candidates = [candidate(1, { type: "SERIES", title: "Pilot", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 2 })];
      m.getHistoryForItem.mockRejectedValueOnce(tracearrError("ERR_BAD_RESPONSE", 500));

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        'Could not recover Tracearr history for "Breaking Bad S01E02" on "Test Plex" — continuing with the remaining candidates',
        expect.anything(),
      );
    });

    it("stops quietly when cancelled mid-lookup, without blaming Tracearr", async () => {
      candidates = [candidate(1), candidate(2)];
      const controller = new AbortController();
      m.getHistoryForItem.mockImplementation(async () => {
        controller.abort();
        throw tracearrError("ERR_CANCELED");
      });

      await recoverHistoryForNewItems(SERVER_ID, { signal: controller.signal });

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(m.logger.warn).not.toHaveBeenCalledWith("WatchHistory", expect.stringContaining("not answering"), expect.anything());
    });

    it("does not abort the pass when one item's write fails", async () => {
      // An item deleted between the candidate query and the write rejects its own batch only.
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords
        .mockRejectedValueOnce(new Error("foreign key violation"))
        .mockResolvedValue({ inserted: 1, updated: 0, skipped: 0, rowsInserted: 1 });

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 2, imported: 1 });
    });

    it("logs a summary of what it checked, imported and skipped", async () => {
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      imports(1, 0, 4, 1);

      await recoverHistoryForNewItems(SERVER_ID);

      // Two candidates, each one imported play and four records the resolver refused.
      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringMatching(/checked 2 .*imported 2 new play\(s\).*8 unjoinable/),
      );
    });

    it("stops instead of failing every remaining item when the mapping changes mid-pass", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockRejectedValue(new TracearrMappingChangedError(SERVER_ID));

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 0 });
      expect(m.importTracearrRecords).toHaveBeenCalledTimes(1);
    });
  });

  describe("recovering an item whose rating key changed", () => {
    // Plex mints a NEW rating key when an item is removed and added back, so
    // the old plays are only reachable by provider id.
    const film = (n = 1) => candidate(n, { ratingKey: `900${n}`, title: "Film", tmdbId: "603" });

    it("falls back to the provider id when the rating key has no plays", async () => {
      candidates = [film()];
      m.getHistoryForItem.mockResolvedValueOnce([]).mockResolvedValueOnce([play("chain-1")]);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(askedFilters()).toEqual([{ ratingKey: "9001" }, { tmdbId: "603", imdbId: null }]);
      expect(m.importTracearrRecords).toHaveBeenCalled();
    });

    it("still asks by provider id when the rating key already found plays", async () => {
      // The item played once since it came back: stopping at that answer
      // recovered one play and left the item reading as barely watched.
      candidates = [film()];
      m.getHistoryForItem
        .mockResolvedValueOnce([play("new-play")])
        .mockResolvedValueOnce([play("new-play"), play("old-1"), play("old-2")]);
      imports(3, 0, 0, 3);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(askedFilters()).toEqual([{ ratingKey: "9001" }, { tmdbId: "603", imdbId: null }]);
      // Both answers in one import, the play both returned only once.
      expect(m.importTracearrRecords).toHaveBeenCalledTimes(1);
      const imported = m.importTracearrRecords.mock.calls[0][1] as TracearrHistoryRecord[];
      expect(imported.map((r) => r.id)).toEqual(["new-play", "old-1", "old-2"]);
      expect(m.logger.info).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("1 recovered by provider id"));
    });

    it("does not count a provider answer that only repeats the rating key's as a recovery", async () => {
      candidates = [film()];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      imports(0, 1, 0, 0);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(2);
      expect((m.importTracearrRecords.mock.calls[0][1] as TracearrHistoryRecord[]).map((r) => r.id)).toEqual(["chain-1"]);
      expect(m.logger.info).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("0 recovered by provider id"));
    });

    it("keeps the item a candidate when the provider lookup fails after the rating key answered", async () => {
      candidates = [film()];
      m.getHistoryForItem.mockResolvedValueOnce([play("new-play")]).mockRejectedValueOnce(new Error("provider lookup failed"));

      await recoverHistoryForNewItems(SERVER_ID);
      // Nothing written from half an answer; the next run asks both again.
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect((await nextPassAnswered()).excluded).toEqual([]);
    });

    it("asks a shared provider identity only once across a run", async () => {
      // Two copies of one film (two libraries) carry the same TMDB id.
      candidates = [film(1), film(2)];

      await recoverHistoryForNewItems(SERVER_ID);

      const byProvider = askedFilters().filter((filter) => !(filter as { ratingKey?: string }).ratingKey);
      expect(byProvider).toEqual([{ tmdbId: "603", imdbId: null }]);
    });

    it.each([
      // An episode row stores SERIES-level ids, Tracearr files plays under episode-level ones.
      ["an episode", { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, tmdbId: "1396", imdbId: "tt0903747" }],
      // An unfiltered request would page the server's ENTIRE history for one item.
      ["an item carrying no ids", {}],
    ])("never asks by provider id for %s", async (_label, extra) => {
      candidates = [candidate(1, { ratingKey: "9001", ...extra })];

      await recoverHistoryForNewItems(SERVER_ID);

      expect(askedFilters()).toEqual([{ ratingKey: "9001" }]);
    });
  });

  describe("account-name map", () => {
    // The rows this pass writes are old plays nothing re-delivers: stored
    // under Tracearr's identity labels, one person reads as two to
    // `watchedByUser` for good.
    it.each([
      ["cannot be loaded", () => m.getServerAccountNames.mockRejectedValue(new Error("tracearr 503")), [expect.anything()]],
      // An empty Map is truthy: a bare falsy check would let the recovery through.
      ["comes back empty", () => m.getServerAccountNames.mockResolvedValue(new Map()), []],
    ])("imports nothing when the account map %s", async (_label, fail, errorArgument) => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      fail();

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual(NONE);
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect(m.logger.warn).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("account-name map"), ...errorArgument);
    });
  });

  it("stops between items when the slice's deadline passes, leaving the rest candidates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    candidates = [candidate(1), candidate(2), candidate(3)];
    m.getHistoryForItem.mockImplementation(async () => {
      // Each lookup takes a minute.
      vi.setSystemTime(Date.now() + 60_000);
      return [];
    });

    expect((await recoverHistoryForNewItems(SERVER_ID, { deadlineMs: start + 90_000 })).checked).toBe(2);
    expect(m.getHistoryForItem).toHaveBeenCalledTimes(2);

    // The third was never asked, so it is not recorded as answered.
    vi.setSystemTime(start);
    m.prisma.$queryRawUnsafe.mockClear();
    await recoverHistoryForNewItems(SERVER_ID, { deadlineMs: Date.now() - 1 });
    expect(candidateQuery().params[3]).toEqual(["item-1", "item-2"]);
  });

  describe("items Tracearr has already answered for", () => {
    it("are not asked about again, so the cap cannot starve the window", async () => {
      // Newest-first ordering used to hand the same unplayed items to every pass.
      candidates = [candidate(1), candidate(2)];
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().params[3]).toEqual([]);

      expect((await nextPassAnswered()).excluded).toEqual(["item-1", "item-2"]);
    });

    it("keeps an item whose lookup failed a candidate", async () => {
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem.mockRejectedValueOnce(new Error("item-specific failure")).mockResolvedValueOnce([]);
      await recoverHistoryForNewItems(SERVER_ID);

      expect((await nextPassAnswered()).excluded).toEqual(["item-2"]);
    });

    it("records the item once ANY play resolved to it, whatever the others did", async () => {
      m.getHistoryForItem.mockResolvedValue([play("other"), play("mine")]);
      m.resolveMediaItemId.mockImplementation((_index: unknown, record: { id: string }) =>
        record.id === "mine" ? { mediaItemId: "item-1" } : { mediaItemId: "old-copy" },
      );
      imports(2, 0, 0, 2);
      await recoverHistoryForNewItems(SERVER_ID);

      expect((await nextPassAnswered()).excluded).toEqual(["item-1"]);
    });

    it("settles an item a play reaches as one of its library copies", async () => {
      // A Jellyfin/Emby item two libraries list: this copy gets a row of its own.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.resolveMediaItemId.mockReturnValue({ mediaItemId: "other-copy", copies: ["item-1"] });
      imports(1, 0, 0, 2);
      await recoverHistoryForNewItems(SERVER_ID);

      vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
      expect(await nextPassAnswered()).toEqual({ excluded: ["item-1"], due: [] });
    });

    it("reports, and reconciles, a stored play that only gains a library copy's row", async () => {
      // Not a new play, but the copy reads as unwatched until the reconcile.
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.resolveMediaItemId.mockReturnValue({ mediaItemId: "other-copy", copies: ["item-1"] });
      imports(0, 1, 0, 1);

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 1 });
      expect(m.reconcileWatchStateFromHistory).toHaveBeenCalledWith(SERVER_ID);
      expect(m.invalidateMediaCaches).toHaveBeenCalled();
      expect(m.logger.info).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("imported 0 new play(s) (1 already stored)"));
    });

    // The old copy, not yet purged, claims the plays (they cascade away with
    // it), or a play resolves nowhere (an ambiguity that clears with the
    // purge): settled, the item would never be asked again — but it is not
    // asked every pass either.
    it.each([
      ["resolved to a different row", { mediaItemId: "old-copy" }],
      ["could not be resolved at all", { skipped: "ambiguous" }],
    ])("defers an item whose every play %s, then re-asks it a day later", async (_label, resolution) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
      m.getHistoryForItem.mockResolvedValue([play("old-1"), play("old-2")]);
      m.resolveMediaItemId.mockReturnValue(resolution);
      imports(2, 0, 0, 2);

      await recoverHistoryForNewItems(SERVER_ID);
      expect(m.resolveMediaItemId).toHaveBeenCalledWith(JOIN_INDEX, expect.objectContaining({ id: "old-1" }));
      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("1 deferred (no play resolved to the item itself)"),
      );

      expect(await nextPassAnswered()).toEqual({ excluded: ["item-1"], due: [] });
      // A day later: offered again, but behind every never-asked item.
      vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
      expect(await nextPassAnswered()).toEqual({ excluded: [], due: ["item-1"] });
    });

    it("stops re-asking a deferred item after MAX_RECOVERY_ASKS answers", async () => {
      // A legitimate second copy's plays resolve to the other copy for ever.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
      m.getHistoryForItem.mockResolvedValue([play("other-copy-play")]);
      m.resolveMediaItemId.mockReturnValue({ mediaItemId: "other-copy" });
      imports(0, 1, 0, 0);

      for (let ask = 0; ask < MAX_RECOVERY_ASKS; ask++) {
        await recoverHistoryForNewItems(SERVER_ID);
        vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
      }
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(MAX_RECOVERY_ASKS);
      // Settled: excluded, not offered as due.
      expect(await nextPassAnswered()).toEqual({ excluded: ["item-1"], due: [] });
    });
  });
});
