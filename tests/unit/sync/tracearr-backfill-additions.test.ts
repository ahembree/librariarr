import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

/**
 * The targeted recovery pass for a re-added item.
 *
 * Deleting a `MediaItem` cascade-deletes its `WatchHistory`, so an item that
 * comes back reads as never watched — `playCount 0`, `lastPlayedAt null` — which
 * is exactly the state a "not played in N months" or `playCount = 0` DELETE rule
 * fires on. The plays still exist in Tracearr; this pass asks for them by rating
 * key.
 *
 * The invariants worth locking down are the ones whose failure is invisible:
 * `rating_key` takes ONE value per request, so an unbounded candidate set is
 * thousands of requests per run against a rolling per-minute rate limit — both
 * the 7-day window and the cap are load-bearing, and a query that quietly lost
 * either would still pass every "it recovers the plays" assertion. Likewise the
 * records must go through the shared importer: a second copy of the row mapping
 * or the ON CONFLICT merge rules would drift silently.
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
  reconcileWatchStateFromHistory: vi.fn(),
  invalidateMediaCaches: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: m.prisma }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateMediaCaches: m.invalidateMediaCaches,
}));
vi.mock("@/lib/sync/watch-reconcile", () => ({
  reconcileWatchStateFromHistory: m.reconcileWatchStateFromHistory,
}));
vi.mock("@/lib/sync/tracearr-join", () => ({
  buildTracearrJoinIndex: m.buildTracearrJoinIndex,
  resolveMediaItemId: m.resolveMediaItemId,
}));
vi.mock("@/lib/sync/sync-tracearr-history", () => ({
  importTracearrRecords: m.importTracearrRecords,
  resolveInstanceForServer: m.resolveInstanceForServer,
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

/** The join index is opaque here — only that the SAME one is reused matters. */
const JOIN_INDEX = { serverId: SERVER_ID, itemCount: 3 };

/**
 * Only `id` and `server_id` are read by this module; everything else about a
 * record is the shared importer's business, and its mapping is covered where it
 * lives (`sync-tracearr-history.test.ts`). Casting keeps that boundary visible
 * rather than pretending this pass inspects the full shape.
 */
function play(id: string, serverId = TRACEARR_SERVER_ID): TracearrHistoryRecord {
  return { id, server_id: serverId } as TracearrHistoryRecord;
}

function candidate(n: number) {
  return {
    id: `item-${n}`,
    ratingKey: `${1000 + n}`,
    title: `Item ${n}`,
    type: "MOVIE",
    parentTitle: null as string | null,
    seasonNumber: null as number | null,
    episodeNumber: null as number | null,
    // No provider ids by default: the rating-key path is the common case, and a
    // candidate that carries ids would silently exercise the fallback too.
    tmdbId: null,
    imdbId: null,
  };
}

let candidates: Array<{
  id: string;
  ratingKey: string;
  title: string;
  type?: string;
  parentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  tmdbId: string | null;
  imdbId: string | null;
}>;

/** The candidate query's SQL and bind params. */
function candidateQuery(): { sql: string; params: unknown[] } {
  const call = m.prisma.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
  return { sql: call[0], params: call.slice(1) };
}

describe("recoverHistoryForNewItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRecoveryAnswers();

    candidates = [candidate(1)];

    m.prisma.mediaServer.findFirst.mockResolvedValue({
      id: SERVER_ID,
      name: "Test Plex",
      enabled: true,
      tracearrServerId: TRACEARR_SERVER_ID,
      userId: "user-1",
    });
    m.prisma.$queryRawUnsafe.mockImplementation(async () => candidates);
    m.resolveInstanceForServer.mockResolvedValue({
      id: "tracearr-1",
      name: "Tracearr",
      url: "http://tracearr:8080",
      apiKey: "key",
    });
    m.buildTracearrJoinIndex.mockResolvedValue(JOIN_INDEX);
    // Every play resolves to the first candidate unless a test says otherwise —
    // the resolver itself is covered in `tracearr-join.test.ts`; here only
    // WHICH row a play landed on matters (see "answered" below).
    m.resolveMediaItemId.mockReturnValue({ mediaItemId: "item-1" });
    m.getHistoryForItem.mockResolvedValue([]);
    // A populated map is the only state in which this pass may write: the rows
    // it creates are old plays nothing re-delivers, so a missing/empty map has
    // to abort rather than fall back to Tracearr's identity labels.
    m.getServerAccountNames.mockResolvedValue(new Map([["srv-user-1", "weingart"]]));
    m.importTracearrRecords.mockResolvedValue({
      inserted: 0,
      updated: 0,
      skipped: 0,
    });
  });

  describe("candidate selection", () => {
    it("excludes only items already holding a Tracearr play from well BEFORE they were created", async () => {
      await recoverHistoryForNewItems(SERVER_ID);

      const { sql, params } = candidateQuery();
      // A re-added item's first NEW play (under its new rating key) is usually
      // in before this pass reaches it, so "has any TRACEARR row" must not end
      // candidacy — that dropped exactly the items this pass exists for. A play
      // from well before the row existed can only have come from the walk or
      // an earlier recovery, so that one does. "Well before" — a window before
      // `createdAt`, not `createdAt` itself: a re-added item played between
      // its return to the server and our sync holds a play dated just before
      // its row, and that one play must not end its candidacy. (The
      // real-database file proves the cases against actual rows.)
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain(`wh."source" = 'TRACEARR'`);
      expect(sql).toContain(
        `wh."watchedAt" < mi."createdAt" - ($6::integer * interval '1 second')`,
      );
      expect(params[5]).toBe(RECENT_ADDITION_WINDOW_MS / 1000);
      expect(sql).toContain('NOT (mi."id" = ANY($4::text[]))');
      expect(sql).toContain('l."mediaServerId" = $1');
      expect(params[0]).toBe(SERVER_ID);
    });

    it("restricts candidates to the recent-addition window", async () => {
      const before = Date.now();
      await recoverHistoryForNewItems(SERVER_ID);
      const after = Date.now();

      const { sql, params } = candidateQuery();
      expect(sql).toContain('mi."createdAt" > $2');

      // Without this bound the candidate set is "every item that has never been
      // played" — most of a real library — re-queried on every run, forever,
      // one request each.
      const addedAfter = params[1] as Date;
      expect(addedAfter).toBeInstanceOf(Date);
      expect(addedAfter.getTime()).toBeGreaterThanOrEqual(
        before - RECENT_ADDITION_WINDOW_MS,
      );
      expect(addedAfter.getTime()).toBeLessThanOrEqual(
        after - RECENT_ADDITION_WINDOW_MS,
      );
      expect(RECENT_ADDITION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("caps the candidate count, because the cap IS the request budget", async () => {
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().sql).toContain("LIMIT $3");
      expect(candidateQuery().params[2]).toBe(DEFAULT_CANDIDATE_LIMIT);

      vi.clearAllMocks();
      m.prisma.$queryRawUnsafe.mockImplementation(async () => candidates);
      await recoverHistoryForNewItems(SERVER_ID, { limit: 5 });
      expect(candidateQuery().params[2]).toBe(5);

      // A caller may ask for less of the budget, never more.
      vi.clearAllMocks();
      m.prisma.$queryRawUnsafe.mockImplementation(async () => candidates);
      await recoverHistoryForNewItems(SERVER_ID, { limit: 50_000 });
      expect(candidateQuery().params[2]).toBe(MAX_CANDIDATE_LIMIT);
    });

    it("takes never-asked items first, then the newest arrivals, when there are more candidates than the cap", async () => {
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().sql).toContain(
        'ORDER BY (mi."id" = ANY($5::text[])) ASC, mi."createdAt" DESC, mi."id" ASC',
      );
      expect(candidateQuery().params[4]).toEqual([]);
    });

    it("does no work at all when nothing has been added", async () => {
      candidates = [];

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(result).toEqual({ checked: 0, imported: 0 });
      // The steady state is zero candidates, so it must cost one indexed query
      // and nothing else — no instance lookup, no join index over the whole
      // server's library, no HTTP.
      expect(m.resolveInstanceForServer).not.toHaveBeenCalled();
      expect(m.buildTracearrJoinIndex).not.toHaveBeenCalled();
      expect(m.getHistoryForItem).not.toHaveBeenCalled();
    });

    it("skips a disabled or unmapped server before querying anything", async () => {
      m.prisma.mediaServer.findFirst.mockResolvedValue({
        id: SERVER_ID,
        name: "Test Plex",
        enabled: false,
        tracearrServerId: TRACEARR_SERVER_ID,
        userId: "user-1",
      });
      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({
        checked: 0,
        imported: 0,
      });

      m.prisma.mediaServer.findFirst.mockResolvedValue({
        id: SERVER_ID,
        name: "Test Plex",
        enabled: true,
        tracearrServerId: null,
        userId: "user-1",
      });
      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({
        checked: 0,
        imported: 0,
      });

      expect(m.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe("lookup and import", () => {
    it("issues exactly one request per candidate rating key", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];

      await recoverHistoryForNewItems(SERVER_ID);

      // `rating_key` is a single value, not a list — the cost model the cap and
      // the window exist to bound.
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(3);
      // The filter is now an identity object, so the rating key is asked for by
      // name rather than positionally.
      expect(m.getHistoryForItem.mock.calls.map((c) => c[1])).toEqual([
        { ratingKey: "1001" },
        { ratingKey: "1002" },
        { ratingKey: "1003" },
      ]);
      for (const call of m.getHistoryForItem.mock.calls) {
        // Scoped to the mapped Tracearr server: one instance aggregates many.
        expect(call[0]).toBe(TRACEARR_SERVER_ID);
      }
    });

    it("upserts found records through the shared importer and join index", async () => {
      const records = [play("chain-1"), play("chain-2")];
      m.getHistoryForItem.mockResolvedValue(records);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 2,
        updated: 0,
        skipped: 0,
      });

      const result = await recoverHistoryForNewItems(SERVER_ID);

      // Through the shared path, never a local copy: the row mapping and the
      // ON CONFLICT merge rules (monotonic progress columns, the `watched`
      // latch) are what stop a re-delivered chain overwriting a fully-watched
      // play with a window-truncated one.
      expect(m.importTracearrRecords).toHaveBeenCalledWith(
        SERVER_ID,
        records,
        JOIN_INDEX,
        // The account-name map: recovered plays must be attributed with the same
        // username vocabulary as every other row on the server, or a re-added
        // item's history lands under a different "person".
        expect.anything(),
        // The Tracearr server they came from, which every write re-checks.
        TRACEARR_SERVER_ID,
      );
      expect(result).toEqual({ checked: 1, imported: 2 });
    });

    it("builds the join index once for the whole pass", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 1,
        updated: 0,
        skipped: 0,
      });

      await recoverHistoryForNewItems(SERVER_ID);

      // It loads every candidate item on the server; per-item would make the
      // pass quadratic in the library size.
      expect(m.buildTracearrJoinIndex).toHaveBeenCalledTimes(1);
      expect(m.buildTracearrJoinIndex).toHaveBeenCalledWith(SERVER_ID);
    });

    it("counts only NEW rows as imported — a merge of a stored play changes nothing", async () => {
      // `imported` drives the caller's reconcile, cache drop and page refetch.
      // Counting merges made every pass that re-delivered an item's own recent
      // play (or a whole answer again after a restart) look like a change.
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 1,
        updated: 3,
        skipped: 2,
      });

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({
        checked: 1,
        imported: 1,
      });
    });

    it("neither reconciles nor drops caches when every row only merged", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({ inserted: 0, updated: 2, skipped: 0 });

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({ checked: 1, imported: 0 });
      expect(m.reconcileWatchStateFromHistory).not.toHaveBeenCalled();
      expect(m.invalidateMediaCaches).not.toHaveBeenCalled();
    });

    it("handles an item Tracearr has no plays for without writing anything", async () => {
      m.getHistoryForItem.mockResolvedValue([]);

      const result = await recoverHistoryForNewItems(SERVER_ID);

      // The common answer for a newly added item, and not a failure.
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect(m.reconcileWatchStateFromHistory).not.toHaveBeenCalled();
      expect(m.invalidateMediaCaches).not.toHaveBeenCalled();
      expect(m.logger.warn).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 1, imported: 0 });
    });

    it("drops records belonging to another media server on the same Tracearr", async () => {
      m.getHistoryForItem.mockResolvedValue([
        play("chain-1", "some-other-server"),
      ]);

      const result = await recoverHistoryForNewItems(SERVER_ID);

      // A rating key is only unique within one server — importing these would
      // attach a stranger's play to this server's item, and `playCount` is
      // monotonic, so it could never be walked back.
      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 1, imported: 0 });
    });

    it("reconciles play state and drops caches once something is imported", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 1,
        updated: 0,
        skipped: 0,
      });

      await recoverHistoryForNewItems(SERVER_ID);

      // Without the reconcile the recovered item still reports playCount 0 —
      // the column the lifecycle rules actually read — so the pass would have
      // achieved nothing the rules can see.
      expect(m.reconcileWatchStateFromHistory).toHaveBeenCalledWith(SERVER_ID);
      expect(m.invalidateMediaCaches).toHaveBeenCalledTimes(1);
    });

    it("keeps the imported rows when the reconcile fails", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 1,
        updated: 0,
        skipped: 0,
      });
      m.reconcileWatchStateFromHistory.mockRejectedValue(new Error("db down"));

      // The rows are committed; the next run's reconcile corrects the columns.
      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({
        checked: 1,
        imported: 1,
      });
      expect(m.logger.warn).toHaveBeenCalled();
    });
  });

  describe("stopping and failure", () => {
    it("stops between items when the signal aborts", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      const controller = new AbortController();
      m.getHistoryForItem.mockImplementation(async () => {
        controller.abort();
        return [];
      });

      const result = await recoverHistoryForNewItems(SERVER_ID, {
        signal: controller.signal,
      });

      // Stopping is a clean outcome, not a failure: candidacy is re-derived
      // from the rows, so the untouched items are simply candidates next run.
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ checked: 1, imported: 0 });
      // The signal is handed to the client too, so an in-flight request and its
      // rate-limit backoff are interrupted rather than waited out.
      expect(m.getHistoryForItem.mock.calls[0][2]).toEqual({
        signal: controller.signal,
      });
    });

    it("does not abort the pass when one item's lookup fails", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem
        .mockRejectedValueOnce(new Error("tracearr 429"))
        .mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 1,
        updated: 0,
        skipped: 0,
      });

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ checked: 3, imported: 2 });
      expect(m.logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Item 1"),
        expect.objectContaining({ error: expect.stringContaining("429") }),
      );
    });

    it.each([
      ["unreachable", null],
      ["a 5xx", 503],
      ["a 429 that outlasted its budget", 429],
    ])("stops the pass when Tracearr itself fails (%s)", async (_label, status) => {
      // Every remaining candidate would fail the same way, each paying the
      // client's whole retry budget on the serial MAIN_QUEUE.
      candidates = [candidate(1), candidate(2), candidate(3)];
      const hostError = new IntegrationError("Tracearr", {
        config: { url: "/api/v2/public/history", method: "get" },
        code: status === null ? "ECONNABORTED" : "ERR_BAD_RESPONSE",
        response: status === null ? undefined : { status, data: {} },
      } as never);
      m.getHistoryForItem.mockRejectedValue(hostError);

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ checked: 1, imported: 0 });
      expect(m.logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Stopping Tracearr play recovery"),
        expect.anything(),
      );
    });

    it("keeps going after an item-specific 500 — it says nothing about the host", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      const itemError = new IntegrationError("Tracearr", {
        config: { url: "/api/v2/public/history", method: "get" },
        code: "ERR_BAD_RESPONSE",
        response: { status: 500, data: {} },
      } as never);
      m.getHistoryForItem.mockRejectedValueOnce(itemError).mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({ inserted: 1, updated: 0, skipped: 0 });

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ checked: 3, imported: 2 });
      expect(m.logger.warn).not.toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Stopping Tracearr play recovery"),
        expect.anything(),
      );
    });

    it("names an episode it could not recover by its show and SxxExx", async () => {
      candidates = [{
        ...candidate(1), type: "SERIES", title: "Pilot", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 2,
      }];
      m.getHistoryForItem.mockRejectedValueOnce(new IntegrationError("Tracearr", {
        config: { url: "/api/v2/public/history", method: "get" },
        code: "ERR_BAD_RESPONSE",
        response: { status: 500, data: {} },
      } as never));

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
        throw new IntegrationError("Tracearr", {
          config: { url: "/api/v2/public/history", method: "get" },
          code: "ERR_CANCELED",
        } as never);
      });

      await recoverHistoryForNewItems(SERVER_ID, { signal: controller.signal });

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(m.logger.warn).not.toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("not answering"),
        expect.anything(),
      );
    });

    it("does not abort the pass when one item's write fails", async () => {
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      // The FK is required and cascades: an item deleted between the candidate
      // query and the write rejects its own batch, and only its own.
      m.importTracearrRecords
        .mockRejectedValueOnce(new Error("foreign key violation"))
        .mockResolvedValue({ inserted: 1, updated: 0, skipped: 0 });

      expect(await recoverHistoryForNewItems(SERVER_ID)).toEqual({
        checked: 2,
        imported: 1,
      });
    });

    it("logs a summary of what it checked, imported and skipped", async () => {
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({
        inserted: 1,
        updated: 0,
        skipped: 4,
      });

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        // Two candidates, each contributing one imported row and four records
        // the resolver refused to name.
        expect.stringMatching(/checked 2 .*imported 2 new play\(s\).*8 unjoinable/),
      );
    });
  });

  describe("recovering an item whose rating key changed", () => {
    it("falls back to the provider id when the rating key has no plays", async () => {
      // The re-add case: Plex mints a NEW rating key when an item is removed
      // and added back, so the old plays are unreachable by key. Without this
      // fallback the whole pass is a no-op for the situation it exists to fix.
      candidates = [
        { id: "item-1", ratingKey: "9999", title: "Re-added Film", tmdbId: "603", imdbId: null },
      ];
      m.getHistoryForItem
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([play("chain-1")]);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(2);
      expect(m.getHistoryForItem.mock.calls[0][1]).toEqual({ ratingKey: "9999" });
      expect(m.getHistoryForItem.mock.calls[1][1]).toEqual({
        tmdbId: "603",
        imdbId: null,
      });
      expect(m.importTracearrRecords).toHaveBeenCalled();
    });

    it("still asks by provider id when the rating key already found plays", async () => {
      // The re-add case again, one step later: the item has been played once
      // since it came back, so its NEW rating key answers with that one play.
      // The old plays are still filed under the key it had before, which only
      // the provider id reaches — stopping at the first answer recovered one
      // ten-minute play and left the item reading as barely watched.
      candidates = [
        { id: "item-1", ratingKey: "1001", title: "Film", tmdbId: "603", imdbId: null },
      ];
      m.getHistoryForItem
        .mockResolvedValueOnce([play("new-play")])
        .mockResolvedValueOnce([play("new-play"), play("old-1"), play("old-2")]);
      m.importTracearrRecords.mockResolvedValue({ inserted: 3, updated: 0, skipped: 0 });

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(2);
      expect(m.getHistoryForItem.mock.calls[1][1]).toEqual({ tmdbId: "603", imdbId: null });
      // Both answers in one import, the play both returned only once — one
      // INSERT may not touch the same row twice.
      expect(m.importTracearrRecords).toHaveBeenCalledTimes(1);
      const imported = m.importTracearrRecords.mock.calls[0][1] as TracearrHistoryRecord[];
      expect(imported.map((r) => r.id)).toEqual(["new-play", "old-1", "old-2"]);
      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("1 recovered by provider id"),
      );
    });

    it("does not count a provider answer that only repeats the rating key's as a recovery", async () => {
      candidates = [
        { id: "item-1", ratingKey: "1001", title: "Film", tmdbId: "603", imdbId: null },
      ];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({ inserted: 0, updated: 1, skipped: 0 });

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(2);
      expect((m.importTracearrRecords.mock.calls[0][1] as TracearrHistoryRecord[]).map((r) => r.id))
        .toEqual(["chain-1"]);
      expect(m.logger.info).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("0 recovered by provider id"),
      );
    });

    it("keeps the item a candidate when the provider lookup fails after the rating key answered", async () => {
      candidates = [
        { id: "item-1", ratingKey: "1001", title: "Film", tmdbId: "603", imdbId: null },
      ];
      m.getHistoryForItem
        .mockResolvedValueOnce([play("new-play")])
        .mockRejectedValueOnce(new Error("provider lookup failed"));

      await recoverHistoryForNewItems(SERVER_ID);
      // Nothing written from half an answer — the next run asks both again.
      expect(m.importTracearrRecords).not.toHaveBeenCalled();

      m.prisma.$queryRawUnsafe.mockClear();
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().params[3]).toEqual([]);
    });

    it("asks a shared provider identity only once across a run", async () => {
      // Two copies of one film (two libraries) carry the same TMDB id: one
      // request answers both.
      candidates = [
        { id: "item-1", ratingKey: "9001", title: "Film", tmdbId: "603", imdbId: null },
        { id: "item-2", ratingKey: "9002", title: "Film", tmdbId: "603", imdbId: null },
      ];
      m.getHistoryForItem.mockResolvedValue([]);

      await recoverHistoryForNewItems(SERVER_ID);

      const providerCalls = m.getHistoryForItem.mock.calls.filter(
        (c) => !(c[1] as { ratingKey?: string }).ratingKey,
      );
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0][1]).toEqual({ tmdbId: "603", imdbId: null });
    });

    it("never asks by provider id for an episode", async () => {
      // An episode row stores the SERIES-level ids while Tracearr files plays
      // under EPISODE-level ones, so a lookup by the show's id can only return
      // plays of whatever else happens to carry that number.
      candidates = [
        {
          id: "item-1",
          ratingKey: "9001",
          title: "Pilot",
          type: "SERIES",
          parentTitle: "Show",
          seasonNumber: 1,
          episodeNumber: 1,
          tmdbId: "1396",
          imdbId: "tt0903747",
        },
      ];
      m.getHistoryForItem.mockResolvedValue([]);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
      expect(m.getHistoryForItem.mock.calls[0][1]).toEqual({ ratingKey: "9001" });
    });

    it("does not attempt a provider lookup for an item carrying no ids", async () => {
      // An unfiltered history request would page the server's ENTIRE history
      // for one item.
      candidates = [
        { id: "item-1", ratingKey: "9999", title: "No ids", tmdbId: null, imdbId: null },
      ];
      m.getHistoryForItem.mockResolvedValue([]);

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
    });
  });


  describe("account-name map", () => {
    // The rows this pass writes are the ONE case where a degraded username is
    // permanent. An item is asked about once (`answeredItems`), the forward
    // pass reaches back only an hour, and
    // `tracearrBackfillComplete` is already true by the time recovery runs — so
    // nothing ever re-delivers these records to correct them. A row stored as
    // "Nick W" sits beside the rest of the server's history stored as
    // "weingart", and a `watchedByUser` rule sees one person as two: a
    // protective "watched by X" exception silently stops matching.
    it("imports nothing when the account map cannot be loaded", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.getServerAccountNames.mockRejectedValue(new Error("tracearr 503"));

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 0, imported: 0 });
      expect(m.logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("account-name map"),
        expect.anything(),
      );
    });

    it("treats an empty account map as a failure to load, not as a server with no users", async () => {
      // `getServerAccountNames` returns `new Map()` rather than throwing when
      // the response shape is unexpected or its own page cap cuts the user walk
      // short. Every history record carries a `server_user_id` belonging to
      // some account, so zero of them cannot be right for a server that has
      // plays — and an empty Map is truthy, so a bare falsy check would let the
      // whole recovery through under identity labels.
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.getServerAccountNames.mockResolvedValue(new Map());

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(m.importTracearrRecords).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 0, imported: 0 });
    });

    it("passes the loaded map through to the shared importer", async () => {
      const names = new Map([["srv-user-1", "weingart"]]);
      m.getServerAccountNames.mockResolvedValue(names);
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({ inserted: 1, updated: 0, skipped: 0 });

      await recoverHistoryForNewItems(SERVER_ID);

      expect(m.importTracearrRecords).toHaveBeenCalledWith(
        SERVER_ID,
        expect.anything(),
        JOIN_INDEX,
        names,
        TRACEARR_SERVER_ID,
      );
    });
  });

  describe("bounded by the slice", () => {
    it("asks about nothing — not even the instance — once the deadline has passed", async () => {
      candidates = [candidate(1), candidate(2)];

      const result = await recoverHistoryForNewItems(SERVER_ID, { deadlineMs: Date.now() - 1 });

      expect(result).toEqual({ checked: 0, imported: 0 });
      expect(m.resolveInstanceForServer).not.toHaveBeenCalled();
      expect(m.buildTracearrJoinIndex).not.toHaveBeenCalled();
      expect(m.getServerAccountNames).not.toHaveBeenCalled();
      expect(m.getHistoryForItem).not.toHaveBeenCalled();
    });

    it("stops between items when the deadline passes, leaving the rest candidates", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        candidates = [candidate(1), candidate(2), candidate(3)];
        m.getHistoryForItem.mockImplementation(async () => {
          // Each lookup takes a minute.
          vi.setSystemTime(Date.now() + 60_000);
          return [];
        });

        const result = await recoverHistoryForNewItems(SERVER_ID, { deadlineMs: start + 90_000 });

        expect(result.checked).toBe(2);
        expect(m.getHistoryForItem).toHaveBeenCalledTimes(2);

        // The third was never asked, so it is not recorded as answered.
        vi.setSystemTime(start);
        m.prisma.$queryRawUnsafe.mockClear();
        await recoverHistoryForNewItems(SERVER_ID, { deadlineMs: Date.now() - 1 });
        expect(candidateQuery().params[3]).toEqual(["item-1", "item-2"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("yields between items to a waiting sync", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      let waiting = false;
      m.getHistoryForItem.mockImplementation(async () => {
        waiting = true;
        return [];
      });

      const result = await recoverHistoryForNewItems(SERVER_ID, { yieldTo: () => waiting });

      expect(result.checked).toBe(1);
      expect(m.getHistoryForItem).toHaveBeenCalledTimes(1);
    });
  });

  describe("items Tracearr has already answered for", () => {
    it("are not asked about again, so the cap cannot starve the window", async () => {
      // The newest unplayed items used to stay candidates for their whole seven
      // days, and newest-first ordering handed the same ones to every pass.
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem.mockResolvedValue([]);
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().params[3]).toEqual([]);

      m.prisma.$queryRawUnsafe.mockClear();
      await recoverHistoryForNewItems(SERVER_ID);

      const { sql, params } = candidateQuery();
      expect(sql).toContain('NOT (mi."id" = ANY($4::text[]))');
      expect(params[3]).toEqual(["item-1", "item-2"]);
    });

    it("keeps an item whose lookup failed a candidate", async () => {
      candidates = [candidate(1), candidate(2)];
      m.getHistoryForItem
        .mockRejectedValueOnce(new Error("item-specific failure"))
        .mockResolvedValueOnce([]);
      await recoverHistoryForNewItems(SERVER_ID);

      m.prisma.$queryRawUnsafe.mockClear();
      await recoverHistoryForNewItems(SERVER_ID);

      expect(candidateQuery().params[3]).toEqual(["item-2"]);
    });

    it("records an item whose plays were imported", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockResolvedValue({ inserted: 1, updated: 0, skipped: 0 });
      await recoverHistoryForNewItems(SERVER_ID);

      m.prisma.$queryRawUnsafe.mockClear();
      await recoverHistoryForNewItems(SERVER_ID);

      expect(candidateQuery().params[3]).toEqual(["item-1"]);
    });

    it("defers an item whose every play resolved to a different row, then re-asks it a day later", async () => {
      // The old copy is still in the library, so its rating key claims the old
      // plays. They land on that row and cascade away when it is purged;
      // closing the new item here would never ask for them again. But it is
      // not asked on every pass either — see the starvation test below.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
      try {
        m.getHistoryForItem.mockResolvedValue([play("old-1"), play("old-2")]);
        m.resolveMediaItemId.mockReturnValue({ mediaItemId: "old-copy" });
        m.importTracearrRecords.mockResolvedValue({ inserted: 2, updated: 0, skipped: 0 });

        await recoverHistoryForNewItems(SERVER_ID);
        expect(m.resolveMediaItemId).toHaveBeenCalledWith(JOIN_INDEX, expect.objectContaining({ id: "old-1" }));
        expect(m.logger.info).toHaveBeenCalledWith(
          "WatchHistory",
          expect.stringContaining("1 deferred (no play resolved to the item itself)"),
        );

        // Straight after: left out.
        m.prisma.$queryRawUnsafe.mockClear();
        await recoverHistoryForNewItems(SERVER_ID);
        expect(candidateQuery().params[3]).toEqual(["item-1"]);
        expect(candidateQuery().params[4]).toEqual([]);

        // A day later: offered again, but behind every never-asked item.
        vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
        m.prisma.$queryRawUnsafe.mockClear();
        await recoverHistoryForNewItems(SERVER_ID);
        expect(candidateQuery().params[3]).toEqual([]);
        expect(candidateQuery().params[4]).toEqual(["item-1"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops re-asking a deferred item after MAX_RECOVERY_ASKS answers", async () => {
      // A legitimate second copy (a 4K beside the 1080p, a Jellyfin item in
      // two libraries) has plays that resolve to the other copy for ever.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T00:00:00.000Z") });
      try {
        m.getHistoryForItem.mockResolvedValue([play("other-copy-play")]);
        m.resolveMediaItemId.mockReturnValue({ mediaItemId: "other-copy" });
        m.importTracearrRecords.mockResolvedValue({ inserted: 0, updated: 1, skipped: 0 });

        for (let ask = 0; ask < MAX_RECOVERY_ASKS; ask++) {
          await recoverHistoryForNewItems(SERVER_ID);
          vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
        }
        expect(m.getHistoryForItem).toHaveBeenCalledTimes(MAX_RECOVERY_ASKS);

        m.prisma.$queryRawUnsafe.mockClear();
        await recoverHistoryForNewItems(SERVER_ID);
        // Settled: excluded, not offered as due.
        expect(candidateQuery().params[3]).toEqual(["item-1"]);
        expect(candidateQuery().params[4]).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("defers an item none of whose plays could be resolved at all", async () => {
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.resolveMediaItemId.mockReturnValue({ skipped: "ambiguous" });
      m.importTracearrRecords.mockResolvedValue({ inserted: 0, updated: 0, skipped: 1 });

      await recoverHistoryForNewItems(SERVER_ID);

      m.prisma.$queryRawUnsafe.mockClear();
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().params[3]).toEqual(["item-1"]);
    });

    it("records the item once ANY play resolved to it, whatever the others did", async () => {
      m.getHistoryForItem.mockResolvedValue([play("other"), play("mine")]);
      m.resolveMediaItemId.mockImplementation((_index: unknown, record: { id: string }) =>
        record.id === "mine" ? { mediaItemId: "item-1" } : { mediaItemId: "old-copy" },
      );
      m.importTracearrRecords.mockResolvedValue({ inserted: 2, updated: 0, skipped: 0 });

      await recoverHistoryForNewItems(SERVER_ID);

      m.prisma.$queryRawUnsafe.mockClear();
      await recoverHistoryForNewItems(SERVER_ID);
      expect(candidateQuery().params[3]).toEqual(["item-1"]);
    });
  });

  describe("a mapping changed mid-pass", () => {
    it("stops instead of failing every remaining item", async () => {
      candidates = [candidate(1), candidate(2), candidate(3)];
      m.getHistoryForItem.mockResolvedValue([play("chain-1")]);
      m.importTracearrRecords.mockRejectedValue(
        new TracearrMappingChangedError(SERVER_ID),
      );

      const result = await recoverHistoryForNewItems(SERVER_ID);

      expect(m.importTracearrRecords).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ checked: 1, imported: 0 });
    });
  });
});
