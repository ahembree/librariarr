import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";
import type { WatchHistoryProgress } from "@/lib/sync/watch-history-progress";

const {
  mockPrisma,
  mockGetHistoryPage,
  mockFindOldestPlayAt,
  mockListServers,
  mockGetServerAccountNames,
  mockInvalidateWatchHistoryEvidence,
  mockEventBus,
  mockBuildIndex,
  mockResolve,
  mockReconcile,
  mockInvalidate,
} = vi.hoisted(() => ({
  mockPrisma: {
    // `updateMany`, not `update`: the backfill-state writes are guarded on the
    // server's CURRENT Tracearr mapping, which only a filtered write can express.
    mediaServer: { findFirst: vi.fn(), updateMany: vi.fn() },
    tracearrInstance: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  },
  mockGetHistoryPage: vi.fn(),
  mockFindOldestPlayAt: vi.fn(),
  mockListServers: vi.fn(),
  mockGetServerAccountNames: vi.fn(),
  mockInvalidateWatchHistoryEvidence: vi.fn(),
  mockEventBus: { emit: vi.fn() },
  mockBuildIndex: vi.fn(),
  mockResolve: vi.fn(),
  mockReconcile: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/events/event-bus", () => ({ eventBus: mockEventBus }));

vi.mock("@/lib/media/watch-evidence", () => ({
  invalidateWatchHistoryEvidence: mockInvalidateWatchHistoryEvidence,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>, url: string) {
    this.getHistoryPage = mockGetHistoryPage;
    // The bisection that measures how far back the history goes. Mocked at the
    // client boundary because its own convergence is asserted in
    // `tests/unit/tracearr/tracearr-client.test.ts`; what matters here is only
    // WHEN the importer asks and what it does with the answer.
    this.findOldestPlayAt = mockFindOldestPlayAt;
    // Only reached when more than one enabled instance exists, so the importer
    // has to work out which one actually monitors the mapped server.
    this.listServers = () => mockListServers(url);
    this.getServerAccountNames = mockGetServerAccountNames;
  },
}));

vi.mock("@/lib/sync/tracearr-join", () => ({
  buildTracearrJoinIndex: mockBuildIndex,
  resolveMediaItemId: mockResolve,
}));

vi.mock("@/lib/sync/watch-reconcile", () => ({
  reconcileWatchStateFromHistory: mockReconcile,
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateMediaCaches: mockInvalidate,
}));

import { logger } from "@/lib/logger";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";

const TRACEARR_SERVER_ID = "11111111-2222-3333-4444-555555555555";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A full `HistoryRecord`, so the mapping is exercised against the real shape. */
function historyRecord(
  overrides: Partial<TracearrHistoryRecord> = {},
): TracearrHistoryRecord {
  return {
    id: "chain-1",
    server_id: TRACEARR_SERVER_ID,
    server_name: "Plex",
    server_type: "plex",
    state: "stopped",
    media_type: "movie",
    media_title: "The Matrix",
    show_title: null,
    season_number: null,
    episode_number: null,
    year: 1999,
    artist_name: null,
    album_name: null,
    track_number: null,
    disc_number: null,
    thumb_path: null,
    poster_url: null,
    duration_ms: 8_100_000,
    progress_ms: 8_100_000,
    total_duration_ms: 8_160_000,
    percent_complete: 99.3,
    started_at: "2025-07-01T20:00:00.000Z",
    stopped_at: "2025-07-01T22:15:00.000Z",
    watched: true,
    segment_count: 1,
    device: "Living Room TV",
    player: "Plex for Apple TV",
    product: "Plex",
    platform: "tvOS",
    is_transcode: false,
    video_decision: "directplay",
    audio_decision: "directplay",
    bitrate: 12_000,
    source_video_codec: "hevc",
    source_audio_codec: "eac3",
    source_audio_channels: 6,
    source_video_width: 3840,
    source_video_height: 2160,
    source_video_details: null,
    source_audio_details: null,
    stream_video_codec: "hevc",
    stream_audio_codec: "eac3",
    stream_video_details: null,
    stream_audio_details: null,
    transcode_info: null,
    subtitle_info: null,
    resolution: "4K",
    source_video_codec_display: "HEVC",
    source_audio_codec_display: "E-AC3",
    audio_channels_display: "5.1",
    stream_video_codec_display: "HEVC",
    stream_audio_codec_display: "E-AC3",
    media_id: null,
    show_media_id: null,
    imdb_id: "tt0133093",
    tmdb_id: 603,
    tvdb_id: null,
    rating_key: "100",
    parent_rating_key: null,
    grandparent_rating_key: null,
    library_id: null,
    genres: null,
    reference_id: "chain-1",
    user: {
      id: "user-1",
      server_user_id: "1",
      username: "bob",
      thumb_url: null,
      avatar_url: null,
    },
    ...overrides,
  };
}

/** The two aggregates `resolveSince` is computed from. */
let watermark: {
  maxWatchedAt: Date | null;
  minWatchedAt: Date | null;
  oldestOpenChain: Date | null;
};
/** Chain ids the DB already holds, for the inserted-vs-updated split. */
let existingEventIds: string[];
/**
 * `MediaItem` ids that are GONE from the DB by the time the write happens —
 * i.e. deleted after the run built its join index. Empty in every test but the
 * concurrent-delete ones, which is the honest default: the join index resolved
 * these ids from rows that existed.
 */
let deletedItemIds: Set<string>;

function insertCalls() {
  return mockPrisma.$executeRawUnsafe.mock.calls.filter((args) =>
    (args[0] as string).includes('INSERT INTO "WatchHistory"'),
  );
}

/** The pre-write "do these items still exist?" probes, in order. */
function existenceCalls() {
  return mockPrisma.$queryRawUnsafe.mock.calls.filter((args) =>
    (args[0] as string).includes('FROM "MediaItem"'),
  );
}

/** The run's one summary line — the "N new, M updated over P page(s)" log. */
function summaryLog(): string | undefined {
  return vi
    .mocked(logger.info)
    .mock.calls.map((args) => args[1])
    .find((message) => message.includes("updated over"));
}

function sinceArg(call = 0): Date | undefined {
  return mockGetHistoryPage.mock.calls[call]?.[1]?.since;
}

/** The `{ since, until, cursor, ... }` options of every page request, in order. */
function historyOptions(): Array<{ since?: Date; until?: Date }> {
  return mockGetHistoryPage.mock.calls.map((args) => args[1]);
}

/**
 * Arms the server row and the watermark aggregate for a server that already
 * holds Tracearr rows — i.e. every case except a first import.
 *
 * `min` is what the BACKFILL boundary is derived from and `max` what the FORWARD
 * one is, so the two must be set together: a resume run is defined by holding
 * rows whose oldest is not the oldest play Tracearr has.
 */
function storedRows(options: {
  min: Date;
  max: Date;
  backfillComplete: boolean;
  oldestOpenChain?: Date | null;
  /** The stored span measurement; null (the default) means "never measured". */
  oldestPlayAt?: Date | null;
}) {
  watermark = {
    maxWatchedAt: options.max,
    minWatchedAt: options.min,
    oldestOpenChain: options.oldestOpenChain ?? null,
  };
  mockPrisma.mediaServer.findFirst.mockResolvedValue({
    id: "server-1",
    name: "Test Plex",
    enabled: true,
    tracearrServerId: TRACEARR_SERVER_ID,
    tracearrBackfillComplete: options.backfillComplete,
    tracearrOldestPlayAt: options.oldestPlayAt ?? null,
    userId: "user-1",
  });
}

/** A reporter that records every emission, for the progress assertions. */
function progressRecorder() {
  const updates: WatchHistoryProgress[] = [];
  return { updates, report: (update: WatchHistoryProgress) => updates.push(update) };
}

/** The emissions made after a page landed (i.e. excluding the pre-fetch one). */
function pageUpdates(updates: WatchHistoryProgress[]): WatchHistoryProgress[] {
  return updates.filter((update) => (update.pages ?? 0) > 0);
}

describe("syncTracearrHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    watermark = { maxWatchedAt: null, minWatchedAt: null, oldestOpenChain: null };
    existingEventIds = [];
    deletedItemIds = new Set();

    mockPrisma.mediaServer.findFirst.mockResolvedValue({
      id: "server-1",
      name: "Test Plex",
      enabled: true,
      tracearrServerId: TRACEARR_SERVER_ID,
      tracearrBackfillComplete: true,
      // Explicitly null, the shape Prisma actually returns for an unmeasured
      // server — `undefined` would skip the measurement branch for a reason
      // that never occurs in production.
      tracearrOldestPlayAt: null,
      userId: "user-1",
    });
    mockPrisma.tracearrInstance.findMany.mockResolvedValue([
      {
        id: "tracearr-1",
        name: "Tracearr",
        url: "http://tracearr:8080",
        apiKey: "key",
      },
    ]);

    mockPrisma.$queryRawUnsafe.mockImplementation(
      async (sql: string, ...params: unknown[]) => {
        if (sql.includes('MAX("watchedAt")')) return [watermark];
        if (sql.includes('SELECT "sourceEventId"')) {
          return existingEventIds.map((id) => ({ sourceEventId: id }));
        }
        // The pre-write existence probe. Answers from the ids it was actually
        // asked about, so a test that deletes nothing gets "all still there" —
        // and so the probe's own argument is under test rather than assumed.
        if (sql.includes('FROM "MediaItem"')) {
          const ids = (params[0] as string[] | undefined) ?? [];
          return ids
            .filter((id) => !deletedItemIds.has(id))
            .map((id) => ({ id }));
        }
        return [];
      },
    );
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    // The guarded state write applied — i.e. the mapping is still the one this
    // run walked. The mapping-changed case is its own test.
    mockPrisma.mediaServer.updateMany.mockResolvedValue({ count: 1 });
    // A reachable `/users`: the account map is a precondition of the archive
    // walk, so a bare `vi.fn()` returning undefined would silently make every
    // test below a "Tracearr is half-down" test.
    // A populated map by default: an EMPTY one now means "could not load" (the
    // client returns one on an unexpected response shape or a cut-short user
    // walk), which correctly refuses the archive walk.
    mockGetServerAccountNames.mockResolvedValue(new Map([["srv-user-1", "weingart"]]));

    mockBuildIndex.mockResolvedValue({
      serverId: "server-1",
      byRatingKey: new Map(),
      byExternalId: new Map(),
      itemCount: 0,
      externalIdCount: 0,
    });
    mockResolve.mockReturnValue({ mediaItemId: "item-1" });
    mockReconcile.mockResolvedValue(0);
    mockGetHistoryPage.mockResolvedValue({ records: [], nextCursor: null });
    // A server Tracearr holds no plays for: measurable, but nothing to store.
    // Tests that care override it.
    mockFindOldestPlayAt.mockResolvedValue(null);
  });

  describe("preconditions", () => {
    it("imports nothing when the server is not mapped to a Tracearr server", async () => {
      mockPrisma.mediaServer.findFirst.mockResolvedValueOnce({
        id: "server-1",
        name: "Test Plex",
        enabled: true,
        tracearrServerId: null,
        tracearrBackfillComplete: true,
        tracearrBackfillCursorAt: null,
        userId: "user-1",
      });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 0,
        // Nothing was importable, so nothing is owed either.
        backfillPending: false,
      });
      expect(mockGetHistoryPage).not.toHaveBeenCalled();
    });

    it("imports nothing when no enabled Tracearr instance is configured", async () => {
      mockPrisma.tracearrInstance.findMany.mockResolvedValueOnce([]);

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 0,
        // Nothing was importable, so nothing is owed either.
        backfillPending: false,
      });
      expect(mockGetHistoryPage).not.toHaveBeenCalled();
    });

    it("picks the enabled instance that actually monitors the mapped server", async () => {
      // The mapping stores a Tracearr-side server UUID, not an instance id, and
      // one install may run two instances. Choosing the oldest would point a
      // correctly-mapped server at the wrong Tracearr, which then returns an
      // empty page for a `server_id` it does not know — a silent no-op import.
      mockPrisma.tracearrInstance.findMany.mockResolvedValueOnce([
        { id: "old", name: "Old", url: "http://old:8080", apiKey: "k1" },
        { id: "new", name: "New", url: "http://new:8080", apiKey: "k2" },
      ]);
      mockListServers.mockImplementation(async (url: string) =>
        url === "http://new:8080"
          ? [{ id: TRACEARR_SERVER_ID, name: "Plex", type: "plex", online: true, activeStreams: 0 }]
          : [{ id: "99999999-9999-9999-9999-999999999999", name: "Other", type: "plex", online: true, activeStreams: 0 }],
      );

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalled();
      expect(mockListServers).toHaveBeenCalledWith("http://new:8080");
    });

    it("does not fall through to another instance when one cannot be reached", async () => {
      // A transient outage on the instance that owns the mapping must not hand
      // the import to a different Tracearr, which would silently import nothing
      // (or, worse, someone else's plays for a colliding id).
      mockPrisma.tracearrInstance.findMany.mockResolvedValueOnce([
        { id: "a", name: "A", url: "http://a:8080", apiKey: "k1" },
        { id: "b", name: "B", url: "http://b:8080", apiKey: "k2" },
      ]);
      mockListServers.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 0,
        // Nothing was importable, so nothing is owed either.
        backfillPending: false,
      });
      expect(mockGetHistoryPage).not.toHaveBeenCalled();
    });

    it("skips without a network call when a single instance is configured", async () => {
      await syncTracearrHistory("server-1");
      expect(mockListServers).not.toHaveBeenCalled();
    });

    it("scopes every page to the mapped Tracearr server at the API's max page size", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord()],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalledWith(
        TRACEARR_SERVER_ID,
        expect.objectContaining({ pageSize: 100 }),
      );
    });
  });

  describe("watermark", () => {
    it("never asks for a window that starts in the future", async () => {
      // `watchedAt` comes from Tracearr's `started_at`, so a clock skewed ahead
      // on the Tracearr host puts the watermark past now. A future `since`
      // matches nothing, stores nothing, and therefore never moves the
      // watermark — a permanent stall rather than a transient one.
      const future = new Date(Date.now() + 5 * DAY_MS);
      watermark = { maxWatchedAt: future, minWatchedAt: future, oldestOpenChain: null };

      await syncTracearrHistory("server-1");

      const since = sinceArg();
      expect(since).toBeDefined();
      expect(since!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("pulls the full history on a first run", async () => {
      await syncTracearrHistory("server-1");

      // No Tracearr rows yet — `since` must be absent so the whole history
      // lands once.
      expect(sinceArg()).toBeUndefined();
    });

    it("re-pulls from the watermark minus a one-hour overlap", async () => {
      const max = new Date("2025-07-10T12:00:00.000Z");
      watermark = { maxWatchedAt: max, minWatchedAt: max, oldestOpenChain: null };

      await syncTracearrHistory("server-1");

      // `since` also scopes the aggregation, so a chain starting just before
      // the watermark would otherwise report a truncated percent_complete.
      expect(sinceArg()?.getTime()).toBe(max.getTime() - HOUR_MS);
    });

    it("reaches back to the oldest unsettled chain", async () => {
      const max = new Date("2025-07-10T12:00:00.000Z");
      const open = new Date(max.getTime() - 3 * DAY_MS);
      watermark = { maxWatchedAt: max, minWatchedAt: max, oldestOpenChain: open };

      await syncTracearrHistory("server-1");

      // A chain still `playing` at 12% must be re-fetched once it finishes, or
      // it stays watched=false forever and never counts as a play.
      expect(sinceArg()?.getTime()).toBe(open.getTime());
    });

    it("clamps an abandoned chain to the seven-day lookback", async () => {
      const max = new Date("2025-07-10T12:00:00.000Z");
      watermark = {
        maxWatchedAt: max,
        minWatchedAt: new Date(max.getTime() - 30 * DAY_MS),
        oldestOpenChain: new Date(max.getTime() - 30 * DAY_MS),
      };

      await syncTracearrHistory("server-1");

      // Otherwise one permanently abandoned play pins the watermark and every
      // sync becomes a full re-pull.
      expect(sinceArg()?.getTime()).toBe(max.getTime() - 7 * DAY_MS);
    });
  });

  describe("paging", () => {
    it("follows nextCursor until it is null", async () => {
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-2" })],
          nextCursor: "cursor-3",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-3" })],
          nextCursor: null,
        });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 3,
        // The keyset ran out, so the archive has been walked to its end.
        backfillPending: false,
      });

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(3);
      expect(mockGetHistoryPage.mock.calls[1][1].cursor).toBe("cursor-2");
      expect(mockGetHistoryPage.mock.calls[2][1].cursor).toBe("cursor-3");
      // One statement per page: rows are written as the loop goes, not at the end.
      expect(insertCalls().length).toBe(3);
    });

    it("terminates when the cursor stops advancing", async () => {
      mockGetHistoryPage.mockResolvedValue({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: "stuck",
      });

      await syncTracearrHistory("server-1");

      // First page (no cursor) + the page at "stuck"; the third would be the
      // same keyset position, so the loop stops instead of paging forever.
      expect(mockGetHistoryPage).toHaveBeenCalledTimes(2);
    });

    it("keeps the first page's rows when a later page fails, and does not throw", async () => {
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockRejectedValueOnce(new Error("ECONNRESET"));

      // Append/upsert only — nothing is ever deleted, so a partial run is
      // durable and correct rather than something to roll back. And it must
      // never surface as a failed sync to the job runner.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        // A walk that stopped for any reason other than an exhausted keyset
        // has NOT seen the whole history, so a backfill is still owed — which
        // is what makes the caller re-queue the job.
        backfillPending: true,
      });
      expect(insertCalls().length).toBe(1);
    });
  });

  describe("writing", () => {
    it("upserts on the chain id rather than ignoring the conflict", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord()],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      const sql = insertCalls()[0][0] as string;
      // A HistoryRecord is a mutable resume-chain aggregate: DO NOTHING would
      // freeze a play at whatever partial state it was first imported with.
      expect(sql).toContain(
        'ON CONFLICT ("mediaServerId","sourceEventId") DO UPDATE SET',
      );
      expect(sql).not.toContain("DO NOTHING");
      // ...but the merge is non-regressive, not a blind overwrite. `since`
      // scopes the aggregation as well as the selection, so a chain that
      // started before the window is re-delivered with truncated
      // duration/segment/percent figures. Those columns may only move forward.
      expect(sql).toContain(
        '"percentComplete" = GREATEST("WatchHistory"."percentComplete", EXCLUDED."percentComplete")',
      );
      for (const column of ["progressMs", "durationMs", "segmentCount", "stoppedAt"]) {
        expect(sql).toContain(
          `"${column}" = GREATEST("WatchHistory"."${column}", EXCLUDED."${column}")`,
        );
      }
      // `watched` and `isTranscode` latch: a truncated re-delivery must never
      // un-watch a play that really completed (watch-reconcile.ts would then
      // stop counting it) or erase that the play transcoded.
      for (const column of ["watched", "isTranscode"]) {
        expect(sql).toContain(
          `"${column}" = ("WatchHistory"."${column}" IS TRUE OR EXCLUDED."${column}" IS TRUE)`,
        );
      }
      expect(sql).not.toContain('"watched" = EXCLUDED."watched"');
      expect(sql).not.toContain('"percentComplete" = EXCLUDED."percentComplete"');
      // Descriptive columns prefer the newer value but never let a null erase
      // a known one.
      expect(sql).toContain(
        '"resolution" = COALESCE(EXCLUDED."resolution", "WatchHistory"."resolution")',
      );
      // The chain's start instant and our own row identity must survive a
      // re-delivery.
      expect(sql).not.toContain('"watchedAt" = EXCLUDED."watchedAt"');
      expect(sql).not.toContain('"createdAt" = EXCLUDED."createdAt"');
      expect(sql).not.toContain('"id" = EXCLUDED."id"');
    });

    it("counts a re-delivered chain as updated, not as a new play", async () => {
      existingEventIds = ["chain-1"];
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: false,
      });
      expect(insertCalls().length).toBe(1);
    });

    it("stores the mapped columns, tagging provenance as TRACEARR", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord()],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      const params = insertCalls()[0].slice(1);
      expect(params).toContain("TRACEARR");
      expect(params).toContain("chain-1");
      expect(params).toContain("bob");
      expect(params).toContain("Living Room TV");
      // `started_at` → `watchedAt`, the chain's stable start.
      expect(params).toContainEqual(new Date("2025-07-01T20:00:00.000Z"));
      // The bundled stream-quality JSON is stored as text for the ::jsonb cast.
      const streamQuality = params.find(
        (value) => typeof value === "string" && value.startsWith("{"),
      ) as string;
      expect(JSON.parse(streamQuality)).toMatchObject({
        sourceVideoWidth: 3840,
        audioChannelsDisplay: "5.1",
      });
    });

    it("stores null rather than an empty object when there is no stream detail", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({
            source_audio_channels: null,
            source_video_width: null,
            source_video_height: null,
            source_video_codec_display: null,
            source_audio_codec_display: null,
            audio_channels_display: null,
            stream_video_codec_display: null,
            stream_audio_codec_display: null,
          }),
        ],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      const params = insertCalls()[0].slice(1) as unknown[];
      expect(
        params.some((value) => typeof value === "string" && value.startsWith("{")),
      ).toBe(false);
    });

    it("skips a record it cannot resolve without aborting the run", async () => {
      mockResolve
        .mockReturnValueOnce({ skipped: "unresolved" })
        .mockReturnValueOnce({ mediaItemId: "item-2" });
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({ id: "chain-1" }),
          historyRecord({ id: "chain-2" }),
        ],
        nextCursor: null,
      });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: false,
      });
      expect(insertCalls().length).toBe(1);
    });

    it("skips a record belonging to another Tracearr server", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ server_id: "some-other-server" })],
        nextCursor: null,
      });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 0,
        backfillPending: false,
      });
      expect(insertCalls().length).toBe(0);
    });

    it("skips a record whose started_at cannot be parsed", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ started_at: "not-a-date" })],
        nextCursor: null,
      });

      // `watchedAt` is what the watermark and the reconcile are computed from,
      // so an unparseable start makes the row worse than useless.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 0,
        backfillPending: false,
      });
      expect(insertCalls().length).toBe(0);
    });

    it("writes a chain repeated within one page only once", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({ id: "chain-1" }),
          historyRecord({ id: "chain-1" }),
        ],
        nextCursor: null,
      });

      // A page's rows go out as ONE statement, and "ON CONFLICT DO UPDATE
      // command cannot affect row a second time" aborts the whole statement —
      // so the guard is statement-scoped, which is all it needs to be.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: false,
      });
      expect(insertCalls().length).toBe(1);
    });

    it("merges a chain re-delivered on a later page instead of tracking it forever", async () => {
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: null,
        });

      await syncTracearrHistory("server-1");

      // A run-scoped seen-set would hold one uuid per imported play for the
      // whole walk — 160k of them on a first import. A later page lands in a
      // different statement, where ON CONFLICT DO UPDATE merges it correctly,
      // so the second write is the intended merge path rather than a duplicate.
      expect(insertCalls().length).toBe(2);
    });
  });

  describe("a media item deleted mid-run", () => {
    // The join index is built ONCE per run, so on a five-minute backfill slice
    // its ids are minutes stale by the time the last page is written.
    // `WatchHistory.mediaItem` is a REQUIRED FK, so a single row pointing at an
    // item something removed in the meantime — a full sync's stale purge, the
    // incremental sync's removal path, the manual purge route — aborts the
    // whole INSERT and, before this pre-check, the rest of the slice with it.
    // Reachable in practice because the History page's Refresh runs inside a
    // request, outside the serial MAIN_QUEUE that separates the heavy jobs.

    /** A record whose resolved `MediaItem` id is derivable from its chain id. */
    function chain(id: string): TracearrHistoryRecord {
      return historyRecord({ id, reference_id: id });
    }

    beforeEach(() => {
      mockResolve.mockImplementation(
        (_index: unknown, record: TracearrHistoryRecord) => ({
          mediaItemId: `item-${record.id}`,
        }),
      );
    });

    it("writes the batch unchanged when every item is still there", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [chain("chain-1"), chain("chain-2")],
        nextCursor: null,
      });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 2,
        backfillPending: false,
      });

      // No drift on the path every healthy run takes: still one statement, and
      // still both rows in it.
      expect(insertCalls().length).toBe(1);
      const params = insertCalls()[0].slice(1);
      expect(params).toContain("item-chain-1");
      expect(params).toContain("item-chain-2");
      expect(summaryLog()).toContain("0 deleted mid-run");
    });

    it("writes the surviving rows and counts the one whose item vanished", async () => {
      deletedItemIds = new Set(["item-chain-1"]);
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [chain("chain-1"), chain("chain-2")],
        nextCursor: null,
      });

      // The point of the pre-check: one deleted item costs its own row, not the
      // batch and not the rest of the slice.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: false,
      });

      expect(insertCalls().length).toBe(1);
      const params = insertCalls()[0].slice(1);
      expect(params).toContain("item-chain-2");
      expect(params).not.toContain("item-chain-1");
    });

    it("issues no INSERT at all when every item in the batch has gone", async () => {
      deletedItemIds = new Set(["item-chain-1", "item-chain-2"]);
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [chain("chain-1"), chain("chain-2")],
        nextCursor: null,
      });

      // An empty batch must be skipped rather than sent: `INSERT … VALUES` with
      // no tuples is a syntax error, so writing it anyway would turn a handled
      // drop back into the aborted statement this exists to avoid.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 0,
        backfillPending: false,
      });
      expect(insertCalls().length).toBe(0);
      // Nothing landed, so there is no play state to reconcile from it.
      expect(mockReconcile).not.toHaveBeenCalled();
    });

    it("surfaces the drop in the run's summary rather than swallowing it", async () => {
      deletedItemIds = new Set(["item-chain-1"]);
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [chain("chain-1"), chain("chain-2")],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      // A row silently missing from an import is indistinguishable from one
      // that was never played. This counter is the only place a delete racing
      // an in-flight run is observable — the next run rebuilds the index and
      // counts the same play as an ordinary `unresolved`.
      expect(summaryLog()).toContain("1 deleted mid-run");
    });

    it("probes only the batch's own distinct item ids", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [chain("chain-1"), chain("chain-2"), chain("chain-3")],
        nextCursor: null,
      });
      mockResolve.mockImplementation(
        (_index: unknown, record: TracearrHistoryRecord) => ({
          // chain-3 is a second play of the same item as chain-1 — a batch of
          // ~180 rows over a rewatched library holds plenty of these.
          mediaItemId:
            record.id === "chain-3" ? "item-chain-1" : `item-${record.id}`,
        }),
      );

      await syncTracearrHistory("server-1");

      // One keyed probe per batch, over this batch's distinct ids. A scan of
      // the whole library — or a query per row — would make the check cost more
      // than the failure it prevents.
      expect(existenceCalls().length).toBe(1);
      const [sql, ids] = existenceCalls()[0];
      expect(sql).toContain('WHERE "id" = ANY($1)');
      expect(ids).toEqual(["item-chain-1", "item-chain-2"]);
    });
  });

  describe("after the import", () => {
    it("reconciles play state and invalidates media caches once", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord()],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockReconcile).toHaveBeenCalledWith("server-1");
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });

    it("does not reconcile when nothing was imported", async () => {
      await syncTracearrHistory("server-1");

      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
    });

    it("does not fail the run when reconciliation throws", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord()],
        nextCursor: null,
      });
      mockReconcile.mockRejectedValueOnce(new Error("deadlock detected"));

      // The rows are already committed, so the count still reflects them.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: false,
      });
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });
  });

  describe("single-source invariant", () => {
    it("removes a leftover NATIVE stratum once Tracearr rows land", async () => {
      // Native rows describe the SAME plays as the imported ones, and
      // reconcileWatchStateFromHistory counts both — so a mixed stratum
      // permanently doubles MediaItem.playCount (it is monotonic, so it never
      // comes back down) and arms playCount-based DELETE rules.
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord()],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      const purges = mockPrisma.$executeRawUnsafe.mock.calls.filter((args) =>
        (args[0] as string).includes(`DELETE FROM "WatchHistory"`),
      );
      expect(purges).toHaveLength(1);
      expect(purges[0][0]).toContain(`"source"='NATIVE'`);
      expect(purges[0][1]).toBe("server-1");
    });

    it("does not purge when the import wrote nothing", async () => {
      // A failed or empty run must never leave the server with neither source.
      mockGetHistoryPage.mockResolvedValueOnce({ records: [], nextCursor: null });

      await syncTracearrHistory("server-1");

      expect(
        mockPrisma.$executeRawUnsafe.mock.calls.filter((args) =>
          (args[0] as string).includes(`DELETE FROM "WatchHistory"`),
        ),
      ).toHaveLength(0);
    });
  });

  describe("progress reporting", () => {
    it("reports a rising imported count for every page, and never a fraction", async () => {
      const { updates, report } = progressRecorder();
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-2" })],
          nextCursor: "cursor-3",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-3" })],
          nextCursor: null,
        });

      await expect(
        syncTracearrHistory("server-1", { onProgress: report }),
      ).resolves.toMatchObject({ count: 3, backfillPending: false });

      expect(
        pageUpdates(updates).map((u) => ({ imported: u.imported, pages: u.pages })),
      ).toEqual([
        { imported: 1, pages: 1 },
        { imported: 2, pages: 2 },
        { imported: 3, pages: 3 },
      ]);

      // The honesty guarantee. The history API is keyset-paginated and its
      // CursorMeta carries only nextCursor/pageSize — there is no total and no
      // count endpoint, so any percentage would be invented. Asserted on EVERY
      // emission, including the pre-fetch one, because a single synthesised
      // fraction would flip the UI to a determinate bar that lies.
      for (const update of updates) {
        expect(update.fraction).toBeUndefined();
      }
    });

    it("reports before the first fetch, while the join index is built", async () => {
      const { updates, report } = progressRecorder();
      let updatesWhenIndexBuilt: WatchHistoryProgress[] = [];
      mockBuildIndex.mockImplementationOnce(async () => {
        updatesWhenIndexBuilt = [...updates];
        return {
          serverId: "server-1",
          byRatingKey: new Map(),
          byExternalId: new Map(),
          itemCount: 0,
          externalIdCount: 0,
        };
      });

      await syncTracearrHistory("server-1", { onProgress: report });

      // Building the index loads every candidate item on the server, so on a
      // large library it is itself slow — the bar must not be blank through it.
      expect(updatesWhenIndexBuilt).toEqual([
        { imported: 0, pages: 0, detail: "Connecting to Tracearr…" },
      ]);
    });

    it("says it is walking older history while backfilling", async () => {
      const { updates, report } = progressRecorder();
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { onProgress: report });

      // No watermark ⇒ `since` is undefined ⇒ the entire history is coming
      // down. That is the run that takes minutes, and a counter that has been
      // climbing for two of them reads as stuck unless it says why.
      expect(pageUpdates(updates)[0].detail).toBe(
        "Imported 1 play · page 1 · importing older history",
      );
    });

    it("drops the backfill note once the history is fully walked", async () => {
      const { updates, report } = progressRecorder();
      watermark = {
        maxWatchedAt: new Date("2025-07-10T12:00:00.000Z"),
        minWatchedAt: new Date("2025-07-10T12:00:00.000Z"),
        oldestOpenChain: null,
      };
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({ id: "chain-1" }),
          historyRecord({ id: "chain-2" }),
        ],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { onProgress: report });

      expect(pageUpdates(updates)[0].detail).toBe("Imported 2 plays · page 1");
    });

    it("surfaces dropped records in the live detail", async () => {
      const { updates, report } = progressRecorder();
      mockResolve
        .mockReturnValueOnce({ skipped: "unresolved" })
        .mockReturnValueOnce({ mediaItemId: "item-2" });
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({ id: "chain-1" }),
          historyRecord({ id: "chain-2" }),
        ],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { onProgress: report });

      // A user watching an import quietly discard its plays should see it while
      // it happens, not find it afterwards in System Logs.
      expect(pageUpdates(updates)[0].detail).toBe(
        "Imported 1 play · page 1 · importing older history · 1 skipped",
      );
    });

    it("keeps the progress reported up to a mid-run failure, and does not throw", async () => {
      const { updates, report } = progressRecorder();
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockRejectedValueOnce(new Error("ECONNRESET"));

      // The import is append/upsert-only, so the first page's rows are durably
      // imported — and the progress the user watched accumulate describes them
      // accurately rather than being rolled back or re-reported as zero.
      await expect(
        syncTracearrHistory("server-1", { onProgress: report }),
        // The walk stopped on an error rather than an exhausted keyset, so
        // the archive is still owed.
      ).resolves.toMatchObject({ count: 1, backfillPending: true });
      expect(pageUpdates(updates)).toEqual([
        {
          imported: 1,
          pages: 1,
          detail: "Imported 1 play · page 1 · importing older history",
        },
      ]);
    });

    it("imports identically when no reporter is passed", async () => {
      // Every scheduled and realtime caller omits `onProgress`, so progress has
      // to be pure observation — never a step the import's behaviour depends on.
      const armTwoPages = () =>
        mockGetHistoryPage
          .mockResolvedValueOnce({
            records: [historyRecord({ id: "chain-1" })],
            nextCursor: "cursor-2",
          })
          .mockResolvedValueOnce({
            records: [historyRecord({ id: "chain-2" })],
            nextCursor: null,
          });

      armTwoPages();
      const reported = await syncTracearrHistory("server-1", {
        onProgress: vi.fn(),
      });
      const reportedSql = mockPrisma.$executeRawUnsafe.mock.calls.map(
        (args) => args[0],
      );
      const reportedReconciles = mockReconcile.mock.calls.length;

      // `clearAllMocks` drops the recorded calls but keeps the `beforeEach`
      // implementations, so the second run starts from the same state.
      vi.clearAllMocks();
      armTwoPages();
      const silent = await syncTracearrHistory("server-1");

      expect(silent).toEqual(reported);
      expect(mockPrisma.$executeRawUnsafe.mock.calls.map((args) => args[0])).toEqual(
        reportedSql,
      );
      expect(mockReconcile.mock.calls.length).toBe(reportedReconciles);
    });
  });

  describe("cancellation", () => {
    /**
     * Arms a page that aborts the signal the moment it is fetched, so the walk
     * is cancelled with exactly one page's rows in hand — the shape of a user
     * hitting Stop, or the client disconnecting, partway through an import.
     *
     * `nextCursor` is deliberately non-null: the run must stop because the
     * signal says so, not because it ran out of pages.
     */
    function abortOnFirstPage(controller: AbortController) {
      mockGetHistoryPage.mockImplementation(async () => {
        controller.abort();
        return {
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        };
      });
    }

    it("issues no history request at all for an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        syncTracearrHistory("server-1", { signal: controller.signal }),
      ).resolves.toMatchObject({ count: 0, backfillPending: true });

      // The check is at the TOP of the page loop, so a signal that is already
      // aborted when the import starts costs the Tracearr instance nothing.
      // The route hands this exact case down when the client disconnected
      // before its turn in a multi-server run.
      expect(mockGetHistoryPage).not.toHaveBeenCalled();
      expect(insertCalls()).toHaveLength(0);
    });

    it("stops the walk after the page in flight, keeping that page's rows", async () => {
      const controller = new AbortController();
      abortOnFirstPage(controller);

      // 160k plays is ~1,600 sequential pages, so "cancel lands within one
      // page" is the whole point: the loop must not run to the end of the
      // history after the user has stopped watching.
      await expect(
        syncTracearrHistory("server-1", { signal: controller.signal }),
      ).resolves.toMatchObject({ count: 1, backfillPending: true });

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(1);
      // The rows were written BEFORE the next page was requested, which is what
      // makes stopping safe — the import appends and upserts, so the page
      // already fetched is durably imported rather than discarded.
      expect(insertCalls()).toHaveLength(1);
    });

    it("resolves with the partial count instead of throwing", async () => {
      const controller = new AbortController();
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockImplementationOnce(async () => {
          controller.abort();
          return {
            records: [historyRecord({ id: "chain-2" })],
            nextCursor: "cursor-3",
          };
        });

      // Stopping early is a NORMAL outcome, not a failure: the watermark is
      // derived from the rows already written, so the next run resumes from
      // exactly here. Rejecting instead would surface a deliberate cancel to
      // the job runner as a failed sync and (on the route) as an error event.
      await expect(
        syncTracearrHistory("server-1", { signal: controller.signal }),
      ).resolves.toMatchObject({ count: 2, backfillPending: true });
      expect(mockGetHistoryPage).toHaveBeenCalledTimes(2);
    });

    it("still reconciles play state and invalidates caches for what it imported", async () => {
      const controller = new AbortController();
      abortOnFirstPage(controller);

      await syncTracearrHistory("server-1", { signal: controller.signal });

      // A cancel must leave the DB consistent, not half-reconciled. The rows
      // are committed either way, and `MediaItem.playCount`/`lastPlayedAt` are
      // what the rule and query engines actually read — skipping the reconcile
      // on a cancelled run would leave those columns reporting the connected
      // account's own views until some later run happened to finish.
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockReconcile).toHaveBeenCalledWith("server-1");
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });

    it("keeps the progress already reported for the cancelled run", async () => {
      const { updates, report } = progressRecorder();
      const controller = new AbortController();
      abortOnFirstPage(controller);

      await syncTracearrHistory("server-1", {
        onProgress: report,
        signal: controller.signal,
      });

      // The emissions the user watched accumulate describe rows that really
      // landed, so they stand rather than being retracted or re-reported as
      // zero — same contract as the mid-run-failure case above.
      expect(pageUpdates(updates)).toEqual([
        {
          imported: 1,
          pages: 1,
          detail: "Imported 1 play · page 1 · importing older history",
        },
      ]);
    });

    it("walks in bulk mode and hands the signal to the HTTP call", async () => {
      const controller = new AbortController();

      await syncTracearrHistory("server-1", { signal: controller.signal });

      // Two separate guarantees on one call:
      //  - `bulk: true` buys the larger 429 budget. The limiter is a rolling
      //    1-minute window and a first import is thousands of sequential
      //    requests, so the single interactive retry would abandon the walk on
      //    the first throttle.
      //  - the signal reaches axios, so a cancel interrupts the in-flight
      //    request and any rate-limit backoff rather than waiting either out.
      expect(mockGetHistoryPage).toHaveBeenCalledWith(
        TRACEARR_SERVER_ID,
        expect.objectContaining({ bulk: true, signal: controller.signal }),
      );
    });
  });

  /**
   * Tracearr serves history NEWEST FIRST, so a forward watermark cannot express
   * resume: the FIRST page of an interrupted import sets `MAX(watchedAt)` to the
   * newest play in the library, and resuming from `MAX - overlap` then asks for
   * the last hour, gets `nextCursor: null` immediately and declares success —
   * silently abandoning every older play. Measured on a live instance: the old
   * resume walked 3 records where the fix walks thousands.
   *
   * The fix is two passes over two independent boundaries (FORWARD `since`,
   * BACKFILL `until = MIN(watchedAt)`) plus one bit of state that the rows
   * genuinely cannot express — whether a walk ever reached the end.
   */
  describe("backfill and resume", () => {
    const MIN = new Date("2021-03-04T08:00:00.000Z");
    const MAX = new Date("2025-07-10T12:00:00.000Z");

    /** Arms a page that is not the last one, so a walk can be interrupted mid-flight. */
    const NOT_LAST_PAGE = {
      records: [historyRecord({ id: "chain-1" })],
      nextCursor: "cursor-2",
    };

    it("walks older history bounded by the oldest row it already holds", async () => {
      // THE REGRESSION. Rows present, backfill never finished — so a BACKFILL
      // request must go out carrying `until` = the oldest stored play. Under the
      // old single-watermark import no such request existed at all: the run
      // asked only for `since = MAX - 1h`, terminated on the first page, and
      // left every play older than the interruption permanently unimported.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalledWith(
        TRACEARR_SERVER_ID,
        expect.objectContaining({ until: MIN, bulk: true, pageSize: 100 }),
      );

      // ...and it is a pass of its own, not `until` bolted onto the forward
      // window — the two boundaries are independent, and ANDing them would ask
      // for the (empty) slice between them.
      const backfill = historyOptions().find((o) => o.until !== undefined);
      expect(backfill).toBeDefined();
      expect(backfill!.until).toEqual(MIN);
      expect(backfill!.since).toBeUndefined();
    });

    it("walks a first import unbounded, then records that the history is complete", async () => {
      // No rows at all: neither boundary exists. `since` absent means "no
      // catch-up to do" and `until` absent means "start at the newest play and
      // keep going until the keyset runs out".
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(1);
      expect(historyOptions()[0].since).toBeUndefined();
      expect(historyOptions()[0].until).toBeUndefined();

      // `nextCursor: null` is the ONLY evidence that the whole archive has been
      // seen, and it is the only thing the rows themselves cannot tell us later.
      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        // Guarded on the mapping this run walked — see `persistMappedState`.
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        // The cursor rides along in the SAME write: how far the walk reached is
        // recorded whether or not anything was storable, which is what stops a
        // stretch of unimportable history from being re-walked forever.
        data: expect.objectContaining({ tracearrBackfillComplete: true }),
      });
    });

    it("does not mark the backfill complete when a page fails mid-walk", async () => {
      // The heart of the fix. A walk that stopped for ANY reason other than an
      // exhausted keyset has not seen the whole history — and flagging it
      // complete is precisely the original bug, because the next run would then
      // skip the backfill pass entirely and the older plays would be stranded
      // for good rather than just until the next sync.
      mockGetHistoryPage
        .mockResolvedValueOnce(NOT_LAST_PAGE)
        .mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: true,
      });

      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("does not mark the backfill complete when the user cancels it", async () => {
      // A user hitting Stop on a multi-minute archive walk is the single most
      // likely way a backfill ends early, and it is indistinguishable from
      // success at the row level — the newest pages landed either way.
      const controller = new AbortController();
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage.mockImplementation(async () => {
        controller.abort();
        return NOT_LAST_PAGE;
      });

      await syncTracearrHistory("server-1", { signal: controller.signal });

      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("does not mark the backfill complete when the cursor stops advancing", async () => {
      // A keyset that keeps handing back the same cursor is a bug upstream, not
      // the end of the history — the walk stops to avoid paging forever, and
      // must leave the flag alone so a later run retries the same stretch.
      mockGetHistoryPage.mockResolvedValue({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: "stuck",
      });

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(2);
      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("does not mark the backfill complete when the page cap stops the walk", async () => {
      // The runaway-cursor backstop. It fires on a cursor that keeps changing
      // without terminating, which looks like an ordinary long walk right up
      // until it is cut off — so it is the quietest way to lose the rest of the
      // archive if the flag were set on any exit.
      let page = 0;
      mockGetHistoryPage.mockImplementation(async () => ({
        records: [],
        nextCursor: `cursor-${++page}`,
      }));

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(20_000);
      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("only fetches new plays once the backfill is complete", async () => {
      // The payoff for tracking the bit at all: the steady state must not
      // re-walk years of history on every scheduled sync. Every request carries
      // the forward boundary and none carries a backfill one.
      storedRows({ min: MIN, max: MAX, backfillComplete: true });
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-2" })],
          nextCursor: null,
        });

      await syncTracearrHistory("server-1");

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(2);
      for (const options of historyOptions()) {
        expect(options.since).toEqual(new Date(MAX.getTime() - HOUR_MS));
        expect(options.until).toBeUndefined();
      }
      // An exhausted FORWARD pass says nothing about the archive, so it must not
      // re-write the flag either (a no-op write here would be harmless, but a
      // forward pass being allowed to SET it would not be).
      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("runs the forward pass before the backfill pass on a resumed run", async () => {
      // Both boundaries are live on a resume, and the order is user-visible: a
      // backfill can legitimately run for many minutes, so plays from this
      // morning must land before the run disappears into 2021 rather than after.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });

      await syncTracearrHistory("server-1");

      const options = historyOptions();
      expect(options).toHaveLength(2);
      expect(options[0].since).toEqual(new Date(MAX.getTime() - HOUR_MS));
      expect(options[0].until).toBeUndefined();
      expect(options[1].since).toBeUndefined();
      expect(options[1].until).toEqual(MIN);
    });

    it("backfills from scratch when the flag says complete but no rows remain", async () => {
      // "Complete" with zero stored rows is a contradiction — the rows are what
      // the flag describes. Something removed them out from under it (a manual
      // delete, a partial restore), and trusting the flag would mean importing
      // nothing, forever, on a server whose history is entirely missing.
      watermark = { maxWatchedAt: null, minWatchedAt: null, oldestOpenChain: null };
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      // The server row still carries `tracearrBackfillComplete: true` from the
      // default fixture.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
        backfillPending: false,
      });

      expect(mockGetHistoryPage).toHaveBeenCalledTimes(1);
      expect(historyOptions()[0].until).toBeUndefined();
      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        // Guarded on the mapping this run walked — see `persistMappedState`.
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        // The cursor rides along in the SAME write: how far the walk reached is
        // recorded whether or not anything was storable, which is what stops a
        // stretch of unimportable history from being re-walked forever.
        data: expect.objectContaining({ tracearrBackfillComplete: true }),
      });
    });

    it("counts the rows from both passes as one import", async () => {
      // The counters live outside `walk`, so the caller (and the progress bar,
      // and the "did anything land" gate that drives the reconcile and the
      // NATIVE purge) sees one run rather than two — a resume that imported 2
      // new plays and 3 old ones imported 5 plays.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [
            historyRecord({ id: "chain-new-1" }),
            historyRecord({ id: "chain-new-2" }),
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          records: [
            historyRecord({ id: "chain-old-1" }),
            historyRecord({ id: "chain-old-2" }),
            historyRecord({ id: "chain-old-3" }),
          ],
          nextCursor: null,
        });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 5,
        backfillPending: false,
      });

      // One statement per page, across both passes — the rows are written as the
      // walk goes, not accumulated and flushed per pass.
      expect(insertCalls().length).toBe(2);
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });

    it("keeps the page counter running across both passes", async () => {
      // `pages` is shared, so the progress bar's page number keeps climbing
      // instead of resetting to 1 when the run switches to the archive — a reset
      // reads as the import having started over.
      const { updates, report } = progressRecorder();
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage.mockResolvedValue({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { onProgress: report });

      expect(pageUpdates(updates).map((u) => u.detail)).toEqual([
        "Imported 1 play · page 1",
        "Imported 2 plays · page 2 · importing older history",
      ]);
    });
  });

  /**
   * A 160k-play archive is ~1,600 sequential pages, so the walk cannot live in
   * the foreground: the History page's Refresh would hang for the length of the
   * import and die with the tab. `passes` splits the two boundaries so the
   * bounded catch-up stays in the request while the archive walk moves to the
   * durable queue, and `deadlineMs` slices that walk so no single job holds the
   * serial MAIN_QUEUE for longer than its turn.
   */
  describe("passes and slicing", () => {
    const MIN = new Date("2021-03-04T08:00:00.000Z");
    const MAX = new Date("2025-07-10T12:00:00.000Z");

    /** Undoes {@link controllableClock}, so a stub can never outlive its test. */
    let restoreClock: (() => void) | undefined;

    afterEach(() => {
      restoreClock?.();
      restoreClock = undefined;
    });

    /**
     * A clock the test moves by hand.
     *
     * The slice boundary is `Date.now() >= deadlineMs` evaluated between pages,
     * so the only deterministic way to exercise it is to make time jump while a
     * page is in flight. Restored after every test — a leaked `Date.now` stub
     * would silently reshape `resolveSince` in every later case.
     */
    function controllableClock() {
      let now = Date.now();
      const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
      restoreClock = () => spy.mockRestore();
      return {
        now: () => now,
        advance: (ms: number) => {
          now += ms;
        },
      };
    }

    it("walks only the forward window for a forward-pass run", async () => {
      // The shape of every `syncWatchHistory` caller: catch up on new plays in
      // seconds, and leave the archive to the queue.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });

      await syncTracearrHistory("server-1", { passes: "forward" });

      const options = historyOptions();
      expect(options).toHaveLength(1);
      for (const request of options) {
        expect(request.since).toEqual(new Date(MAX.getTime() - HOUR_MS));
        expect(request.until).toBeUndefined();
      }
      // The decisive one. A forward walk that runs out of pages has seen an hour
      // of history, not the archive — letting it set the flag would strand every
      // older play exactly the way the single-watermark import did.
      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("reports that a backfill is still owed after a forward-only run", async () => {
      // The hand-off itself: this flag is what `syncWatchHistory` reads to decide
      // whether to enqueue the backfill job. A forward pass never touches the
      // archive, so it must report the debt rather than inferring "nothing left
      // to do" from its own exhausted keyset.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-new" })],
        nextCursor: null,
      });

      await expect(
        syncTracearrHistory("server-1", { passes: "forward" }),
      ).resolves.toMatchObject({ count: 1, backfillPending: true });
    });

    it("walks only the backfill window for a backfill-pass run", async () => {
      // The queued job's shape. Re-walking the forward window on every slice
      // would repeat work the request that queued it has already done.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });

      await syncTracearrHistory("server-1", { passes: "backfill" });

      const options = historyOptions();
      expect(options).toHaveLength(1);
      expect(options[0].until).toEqual(MIN);
      expect(options[0].since).toBeUndefined();
    });

    it("marks the backfill complete when a backfill pass exhausts the keyset", async () => {
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-old" })],
        nextCursor: null,
      });

      // `nextCursor: null` on the BACKFILL walk is the one and only evidence
      // that the oldest play has been seen, and `backfillPending: false` is what
      // stops the job re-enqueueing itself forever.
      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({ count: 1, backfillPending: false });

      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        // Guarded on the mapping this run walked — see `persistMappedState`.
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        // The cursor rides along in the SAME write: how far the walk reached is
        // recorded whether or not anything was storable, which is what stops a
        // stretch of unimportable history from being re-walked forever.
        data: expect.objectContaining({ tracearrBackfillComplete: true }),
      });
    });

    it("still fetches one page when the slice is already spent, so a run always progresses", async () => {
      // A slice whose budget was already spent before the walk began — the job's
      // own setup (the join index, the one-time oldest-play measurement) is paid
      // out of the same budget, so this is reachable.
      //
      // The deadline is deliberately NOT honoured until this walk has fetched
      // something. Skipping every page would leave the run reporting
      // `backfillPending` having imported nothing, and the task re-enqueues on
      // that — a slice that does no work and immediately asks for another is a
      // spin, not a backoff. One page per walk makes progress guaranteed.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: "more-pages",
      });

      await expect(
        syncTracearrHistory("server-1", {
          passes: "backfill",
          deadlineMs: Date.now() - 1,
        }),
      ).resolves.toMatchObject({ count: 1, backfillPending: true });

      // Exactly one: it progresses, then honours the budget.
      expect(mockGetHistoryPage).toHaveBeenCalledTimes(1);
      // And it records how far it reached, so the next slice starts further back
      // rather than repeating this page.
      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        // Guarded on the mapping this run walked — see `persistMappedState`.
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        data: expect.objectContaining({
          tracearrBackfillCursorAt: expect.any(Date),
        }),
      });
    });

    it("stops on a page boundary when the slice expires mid-walk, keeping that page", async () => {
      const clock = controllableClock();
      const deadlineMs = clock.now() + 60_000;
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      // Time passes while the page is in flight. `nextCursor` is deliberately
      // non-null: the walk must stop because the slice ran out, not because the
      // history did.
      mockGetHistoryPage.mockImplementation(async () => {
        clock.advance(90_000);
        return {
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        };
      });

      const result = await syncTracearrHistory("server-1", {
        passes: "backfill",
        deadlineMs,
      });

      // A page in flight is never interrupted — the deadline gates STARTING the
      // next one — so a slice always ends on a committed page boundary, and that
      // page's rows are durably imported rather than re-fetched next slice.
      expect(mockGetHistoryPage).toHaveBeenCalledTimes(1);
      expect(insertCalls()).toHaveLength(1);
      // ...and, exactly like a cancel, the walk is "stopped" rather than
      // "exhausted": marking it complete here would strand the rest of the
      // archive for good.
      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
      // "stopped", not "errored": the slice ran out of time, which is progress,
      // so the job re-enqueues immediately rather than backing off.
      expect(result).toEqual({
        count: 1,
        backfillPending: true,
        backfillOutcome: "stopped",
      });
    });

    it("treats a spent slice as a normal outcome, not a failed run", async () => {
      const clock = controllableClock();
      const deadlineMs = clock.now() + 60_000;
      storedRows({ min: MIN, max: MAX, backfillComplete: false });
      mockGetHistoryPage.mockImplementation(async () => {
        clock.advance(90_000);
        return {
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        };
      });

      // Throwing would surface an ordinary slice boundary to the job runner as a
      // failed job — retried with backoff and eventually abandoned — on a walk
      // that is working exactly as designed. The rows are committed either way,
      // so the reconcile that makes them visible to the rule engines runs too.
      await expect(
        syncTracearrHistory("server-1", { passes: "backfill", deadlineMs }),
      ).resolves.toMatchObject({ count: 1, backfillPending: true });
      expect(mockReconcile).toHaveBeenCalledWith("server-1");
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });

    it("runs forward then backfill for an explicit both-passes run", async () => {
      // The default, and the only mode that touches both boundaries. The order
      // is user-visible: a backfill legitimately runs for many minutes, so this
      // morning's plays must land before the run disappears into 2021.
      storedRows({ min: MIN, max: MAX, backfillComplete: false });

      await syncTracearrHistory("server-1", { passes: "both" });

      const options = historyOptions();
      expect(options).toHaveLength(2);
      expect(options[0].since).toEqual(new Date(MAX.getTime() - HOUR_MS));
      expect(options[0].until).toBeUndefined();
      expect(options[1].since).toBeUndefined();
      expect(options[1].until).toEqual(MIN);
    });
  });

  describe("measuring the oldest play", () => {
    const MIN = new Date("2021-03-04T08:00:00.000Z");
    const MAX = new Date("2025-07-10T12:00:00.000Z");
    /** The far end of the user's real history, the one live-verified answer. */
    const OLDEST_PLAY = new Date("2019-07-21T03:17:00.000Z");

    it("measures the span once and stores it when a backfill has never measured it", async () => {
      storedRows({ min: MIN, max: MAX, backfillComplete: false, oldestPlayAt: null });
      mockFindOldestPlayAt.mockResolvedValue(OLDEST_PLAY);

      await syncTracearrHistory("server-1", { passes: "backfill" });

      expect(mockFindOldestPlayAt).toHaveBeenCalledTimes(1);
      // Scoped to the mapped Tracearr server, not our own id: one instance
      // aggregates several media servers and their histories start on different
      // days, so a span measured against the wrong one would draw a bar that is
      // simply about a different server.
      expect(mockFindOldestPlayAt.mock.calls[0][0]).toBe(TRACEARR_SERVER_ID);

      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        // Guarded on the mapping this run walked — see `persistMappedState`.
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        data: { tracearrOldestPlayAt: OLDEST_PLAY },
      });
    });

    it("measures before walking, not after", async () => {
      storedRows({ min: MIN, max: MAX, backfillComplete: false, oldestPlayAt: null });
      mockFindOldestPlayAt.mockResolvedValue(OLDEST_PLAY);

      await syncTracearrHistory("server-1", { passes: "backfill" });

      // The denominator has to exist before the pages it is meant to describe.
      // Measuring afterwards would leave the very first slice — the longest one,
      // the one a user actually sits and watches — with an indeterminate bar.
      expect(mockFindOldestPlayAt.mock.invocationCallOrder[0]).toBeLessThan(
        mockGetHistoryPage.mock.invocationCallOrder[0],
      );
    });

    it("does not re-measure a server whose span is already known", async () => {
      storedRows({
        min: MIN,
        max: MAX,
        backfillComplete: false,
        oldestPlayAt: OLDEST_PLAY,
      });

      await syncTracearrHistory("server-1", { passes: "backfill" });

      // The bisection is ~19 API calls. A long backfill runs as dozens of
      // five-minute slices, and the answer only moves if Tracearr prunes, so
      // repeating it per slice would be hundreds of rate-limited requests spent
      // re-deriving a constant.
      expect(mockFindOldestPlayAt).not.toHaveBeenCalled();
    });

    it("does not measure once the backfill is complete", async () => {
      storedRows({
        min: MIN,
        max: MAX,
        backfillComplete: true,
        oldestPlayAt: null,
      });

      await syncTracearrHistory("server-1");

      // A finished backfill reports a full bar from the flag alone, so there is
      // no span left to measure and nothing to spend the calls on.
      expect(mockFindOldestPlayAt).not.toHaveBeenCalled();
    });

    it("never measures on a forward-only run", async () => {
      storedRows({ min: MIN, max: MAX, backfillComplete: false, oldestPlayAt: null });

      await syncTracearrHistory("server-1", { passes: "forward" });

      // A forward pass covers an hour of new plays and returns in seconds; it is
      // run on every sync, by every caller. Bolting ~19 probes onto it would
      // charge the whole install for a number only the queued backfill reads.
      expect(mockFindOldestPlayAt).not.toHaveBeenCalled();
      // A stopped walk still records the cursor (how far it reached), which is
      // what stops the next slice re-walking the same pages. What it must never
      // do is claim the archive is fully imported.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrBackfillComplete: true }),
        }),
      );
    });

    it("stores nothing when the server turns out to have no plays", async () => {
      storedRows({ min: MIN, max: MAX, backfillComplete: false, oldestPlayAt: null });
      mockFindOldestPlayAt.mockResolvedValue(null);

      await syncTracearrHistory("server-1", { passes: "backfill" });

      // Null is "Tracearr holds nothing for this server", not a measurement.
      // Writing it back would be indistinguishable from never having measured,
      // and would re-run the bisection on every later slice anyway.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrOldestPlayAt: expect.anything() }),
        }),
      );
    });

    it("imports normally when the measurement fails", async () => {
      storedRows({ min: MIN, max: MAX, backfillComplete: false, oldestPlayAt: null });
      mockFindOldestPlayAt.mockRejectedValue(new Error("ECONNRESET"));
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-old" })],
        nextCursor: null,
      });

      // The measurement is decoration on top of the import, so a failure costs a
      // determinate bar and nothing else. Letting it escape would abort a walk
      // that was about to import thousands of rows — and it runs FIRST, so the
      // run would fail having imported nothing at all.
      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({ count: 1, backfillPending: false });

      expect(mockFindOldestPlayAt).toHaveBeenCalledTimes(1);
      expect(mockGetHistoryPage).toHaveBeenCalledWith(
        TRACEARR_SERVER_ID,
        expect.objectContaining({ until: MIN }),
      );
      // The pages still landed, and the walk still got to record that it reached
      // the end of the history.
      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        // Guarded on the mapping this run walked — see `persistMappedState`.
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        // The cursor rides along in the SAME write: how far the walk reached is
        // recorded whether or not anything was storable, which is what stops a
        // stretch of unimportable history from being re-walked forever.
        data: expect.objectContaining({ tracearrBackfillComplete: true }),
      });
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tracearrOldestPlayAt: expect.anything() }),
        }),
      );
    });
  });

  describe("user identity", () => {
    /** A user Tracearr knows by an identity label that is not the account name. */
    function withUser(id: string, serverUserId: string, username: string) {
      return historyRecord({
        id,
        user: {
          id: "identity-1",
          server_user_id: serverUserId,
          username,
          thumb_url: null,
          avatar_url: null,
        },
      });
    }

    /** The `serverUsername` clause of one INSERT statement's ON CONFLICT set. */
    function usernameMerge(call: number): string {
      const sql = insertCalls()[call][0] as string;
      return sql.slice(sql.indexOf('"serverUsername" ='), sql.indexOf('"deviceName" ='));
    }

    it("stores the media server's own account name, not Tracearr's identity name", async () => {
      // The whole point. A record's `user.username` is Tracearr's friendly
      // cross-server label; the native watch-history path stores the account
      // name the media server itself reports. On a real Plex server these
      // disagree for most users — "Nick W" the identity vs "weingart" the
      // account — so storing the identity name makes one human two different
      // people depending on which source a server uses. `watchedByUser` rules
      // match on this string, so a source switch would silently stop matching.
      mockGetServerAccountNames.mockResolvedValue(
        new Map([["srv-user-1", "weingart"]]),
      );
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({
            id: "chain-1",
            user: {
              id: "identity-1",
              server_user_id: "srv-user-1",
              username: "Nick W",
              thumb_url: null,
              avatar_url: null,
            },
          }),
        ],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      const params = insertCalls()[0].slice(1) as unknown[];
      expect(params).toContain("weingart");
      expect(params).not.toContain("Nick W");
    });

    it("falls back to the identity name for an account it cannot bridge", async () => {
      // A user removed from the server since the play: no account row remains,
      // so the identity name is the only name there is. Better than "Unknown".
      //
      // Expressed as a POPULATED map that simply lacks this user, not as an
      // empty one: an empty map means "could not load" and refuses the walk
      // outright, which is a different scenario and would make this test assert
      // nothing while silently leaking its queued page into the next test.
      mockGetServerAccountNames.mockResolvedValue(
        new Map([["srv-user-1", "weingart"]]),
      );
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          historyRecord({
            id: "chain-1",
            user: {
              id: "identity-1",
              server_user_id: "gone",
              username: "Departed User",
              thumb_url: null,
              avatar_url: null,
            },
          }),
        ],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      expect(insertCalls()[0].slice(1)).toContain("Departed User");
    });

    it("refuses to walk the archive when the account map cannot be loaded", async () => {
      // The map is a PRECONDITION of the backfill, not a nicety. Archive rows
      // are effectively permanent — the upsert only revisits a chain that is
      // re-delivered, and the walk never returns to a page it has passed — so a
      // single transient `/users` failure would file a whole slice of history
      // under Tracearr's identity labels while the rest of the server uses the
      // media server's account names, and `watchedByUser` rules would see one
      // person as two. Skipping costs a slice; the pass is resumable by design.
      storedRows({
        min: new Date("2021-03-04T08:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: false,
      });
      mockGetServerAccountNames.mockRejectedValue(new Error("boom"));

      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({
        count: 0,
        // Still owed, and reported as a reach-Tracearr failure so the queued
        // task backs off instead of re-enqueueing a run that would fail the
        // same way as fast as the queue can turn it over.
        backfillPending: true,
        backfillOutcome: "errored",
      });

      expect(mockGetHistoryPage).not.toHaveBeenCalled();
      // Nothing was walked, so there is no progress to record either.
      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalled();
    });

    it("still catches up on new plays when the account map cannot be loaded", async () => {
      // The opposite trade-off, deliberately. The forward pass covers an hour of
      // overlap, not an archive, so it writes a handful of rows — and the next
      // successful run re-delivers exactly those rows inside the same overlap
      // window, where a bridged name overwrites the fallback. Degraded
      // attribution here is self-healing; refusing to run would instead leave
      // the History page showing nothing new for as long as `/users` is unhappy.
      storedRows({
        min: new Date("2025-07-10T11:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: true,
      });
      mockGetServerAccountNames.mockRejectedValue(new Error("boom"));
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [withUser("chain-new", "srv-user-1", "Nick W")],
        nextCursor: null,
      });

      await expect(
        syncTracearrHistory("server-1", { passes: "forward" }),
      ).resolves.toMatchObject({ count: 1 });
      expect(insertCalls()[0].slice(1)).toContain("Nick W");
    });

    it("never lets a fallback name overwrite an account name already stored", async () => {
      // A map that loaded but does not cover this user — Tracearr's `/users`
      // drops an account once it is removed from the server. The row's identity
      // label is the best name available for a FIRST import of that chain, but
      // it is worth less than a name an earlier run already bridged: letting it
      // win would silently re-label correct history every time the overlap
      // window re-delivers the chain.
      mockGetServerAccountNames.mockResolvedValue(
        new Map([["srv-user-1", "weingart"]]),
      );
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [withUser("chain-departed", "gone", "Nick W")],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      expect(usernameMerge(0)).toContain(
        'COALESCE("WatchHistory"."serverUsername", EXCLUDED."serverUsername")',
      );
      // ...while still carrying the fallback, so a chain nobody has stored yet
      // is named rather than left null.
      expect(insertCalls()[0].slice(1)).toContain("Nick W");
    });

    it("lets a bridged name correct a fallback stored by an earlier run", async () => {
      // The other half of the rule, and what makes a degraded forward run
      // self-healing: the best name there is may overwrite anything.
      mockGetServerAccountNames.mockResolvedValue(
        new Map([["srv-user-1", "weingart"]]),
      );
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [withUser("chain-1", "srv-user-1", "Nick W")],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1");

      expect(usernameMerge(0)).toContain(
        'COALESCE(EXCLUDED."serverUsername", "WatchHistory"."serverUsername")',
      );
    });

    it("sends the two confidences as separate statements on a mixed page", async () => {
      // One statement carries one ON CONFLICT clause, so a page holding both a
      // bridged and a departed account has to be split — otherwise one of the
      // two gets the wrong merge rule.
      mockGetServerAccountNames.mockResolvedValue(
        new Map([["srv-user-1", "weingart"]]),
      );
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [
          withUser("chain-bridged", "srv-user-1", "Nick W"),
          withUser("chain-departed", "gone", "Departed User"),
        ],
        nextCursor: null,
      });

      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        // Both rows land — splitting the statement must not cost a play.
        count: 2,
      });

      expect(insertCalls()).toHaveLength(2);
      expect(usernameMerge(0)).toContain(
        'COALESCE(EXCLUDED."serverUsername", "WatchHistory"."serverUsername")',
      );
      expect(insertCalls()[0].slice(1)).toContain("weingart");
      expect(usernameMerge(1)).toContain(
        'COALESCE("WatchHistory"."serverUsername", EXCLUDED."serverUsername")',
      );
      expect(insertCalls()[1].slice(1)).toContain("Departed User");
    });

    it("loads the account map once per run, not once per page", async () => {
      mockGetHistoryPage
        .mockResolvedValueOnce({ records: [historyRecord({ id: "a" })], nextCursor: "c1" })
        .mockResolvedValueOnce({ records: [historyRecord({ id: "b" })], nextCursor: null });

      await syncTracearrHistory("server-1");

      expect(mockGetServerAccountNames).toHaveBeenCalledTimes(1);
    });
  });

  describe("a mapping changed mid-slice", () => {
    /** The one page a first import needs to walk the archive to its end. */
    function exhaustsTheArchive() {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });
    }

    it("writes backfill state only while the mapping is the one it walked", async () => {
      // A slice reads `tracearrServerId` at the top and finishes minutes later.
      // In between the admin can re-point the server at a different Tracearr —
      // which wipes the rows and resets these columns — so the write has to
      // carry the mapping it describes. An `update` keyed on the id alone lands
      // after that reset and tells the NEW mapping it is already backfilled,
      // and no later run corrects it: the flag is the one thing the rows cannot
      // re-derive, so the new source's whole archive is never imported.
      exhaustsTheArchive();

      await syncTracearrHistory("server-1");

      expect(mockPrisma.mediaServer.updateMany).toHaveBeenCalledWith({
        where: { id: "server-1", tracearrServerId: TRACEARR_SERVER_ID },
        data: expect.objectContaining({ tracearrBackfillComplete: true }),
      });
    });

    it("discards the state and says so when the mapping moved under it", async () => {
      // The guard firing: zero rows matched, so the progress this slice made
      // describes a Tracearr server this media server no longer uses. Logged
      // rather than silent — otherwise the only evidence is a backfill that
      // mysteriously starts over.
      exhaustsTheArchive();
      mockPrisma.mediaServer.updateMany.mockResolvedValue({ count: 0 });

      // The rows it imported are still committed and still correct: they were
      // written before the switch, and the server PUT wipes them itself.
      await expect(syncTracearrHistory("server-1")).resolves.toMatchObject({
        count: 1,
      });

      const logged = vi
        .mocked(logger.info)
        .mock.calls.map((args) => args[1] as string);
      expect(
        logged.some((message) => message.includes("source changed")),
      ).toBe(true);
    });
  });


  describe("an exhausted walk that found nothing", () => {
    // "Exhausted" means `nextCursor === null`, which a first page of
    // `{ records: [], nextCursor: null }` satisfies just as well as a real
    // archive walked to its end. That empty first page is what a MISMATCHED
    // mapping looks like — a `tracearrServerId` the resolved instance doesn't
    // monitor, or a freshly-installed Tracearr with no retained history.
    //
    // Declaring completion there is worse than never completing: the mapping
    // change already wiped the server's native history, so clearing
    // `watchHistorySyncedAt` hands the evaluability guard a clean bill of
    // health for an empty relation, and `watchedByUser` negatives go on to
    // match the entire library.
    it("does not mark the backfill complete when Tracearr returned no records at all", async () => {
      mockGetHistoryPage.mockResolvedValue({ records: [], nextCursor: null });

      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({ count: 0, backfillPending: true });

      expect(mockPrisma.mediaServer.updateMany).not.toHaveBeenCalled();
    });

    it("still completes when records came back but none of them were storable", async () => {
      // The opposite case, and the reason the gate asks about RECORDS rather
      // than about rows written: ~41% of old plays reference media that has
      // since left the library and are deliberately skipped, so a legitimate
      // walk can exhaust having stored nothing. Gating on rows would re-walk
      // such an archive forever.
      mockGetHistoryPage.mockResolvedValue({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({ backfillPending: false });

      const write = mockPrisma.mediaServer.updateMany.mock.calls.at(-1)?.[0];
      expect(write.data).toMatchObject({ tracearrBackfillComplete: true });
      // Established in the SAME guarded statement as the completion flag, so
      // one can never land without the other.
      expect(write.data.watchHistorySyncedAt).toBeInstanceOf(Date);
    });

    it("completes normally once the server already holds rows from earlier slices", async () => {
      // A resumed slice legitimately imports nothing new when the remaining
      // stretch is all unstorable — the rows from previous slices are what say
      // the mapping is real.
      storedRows({
        min: new Date("2021-03-04T08:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: false,
      });
      mockGetHistoryPage.mockResolvedValue({ records: [], nextCursor: null });

      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({ backfillPending: false });
    });
  });

  describe("the account map is a precondition, and empty counts as missing", () => {
    it("refuses the archive walk on an EMPTY account map, not just a thrown one", async () => {
      // `getServerAccountNames` returns `new Map()` rather than throwing when
      // the `/users` response shape is unexpected or its own page cap cuts the
      // user walk short. An empty Map is truthy, so a bare falsy check let the
      // whole archive land under Tracearr's identity labels — the exact outcome
      // the gate exists to block, reached through the gate rather than around
      // it. Every history record carries a `server_user_id` belonging to some
      // account, so zero of them cannot be right for a server that has plays.
      storedRows({
        min: new Date("2021-03-04T08:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: false,
      });
      mockGetServerAccountNames.mockResolvedValue(new Map());

      await expect(
        syncTracearrHistory("server-1", { passes: "backfill" }),
      ).resolves.toMatchObject({
        count: 0,
        backfillPending: true,
        backfillOutcome: "errored",
      });

      expect(mockGetHistoryPage).not.toHaveBeenCalled();
    });
  });


  describe("degraded attribution withdraws the evidence marker", () => {
    /** `withUser` lives in another describe; this block needs its own. */
    function play(id: string, serverUserId: string, username: string) {
      return historyRecord({
        id,
        user: {
          id: "identity-1",
          server_user_id: serverUserId,
          username,
          thumb_url: null,
          avatar_url: null,
        },
      });
    }

    // The forward pass runs without the account-name map on purpose, so its
    // rows land under Tracearr's identity label ("Nick W") instead of the
    // media server's account name ("weingart"). `watchedByUser` matches on that
    // exact string, and a MISSING name arms a negative rule rather than
    // disarming it: "delete unless watched by weingart" matches an item
    // weingart did watch, because the play is filed under a name the rule does
    // not recognise. Monotonic play state cannot save that one.
    it("pauses play-activity rules after storing rows without the account map", async () => {
      storedRows({
        min: new Date("2025-07-10T11:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: true,
      });
      mockGetServerAccountNames.mockRejectedValue(new Error("users endpoint down"));
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [play("chain-new", "srv-user-1", "Nick W")],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { passes: "forward" });

      expect(mockInvalidateWatchHistoryEvidence).toHaveBeenCalledWith(["server-1"]);
    });

    it("does not pause when the map loaded and merely lacks a removed user", async () => {
      // A user Tracearr has since removed is legitimately absent from a healthy
      // map. That fallback is permanent and correct, so pausing for it would
      // never lift — the condition is an UNUSABLE map, not any fallback name.
      storedRows({
        min: new Date("2025-07-10T11:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: true,
      });
      mockGetServerAccountNames.mockResolvedValue(new Map([["srv-user-1", "weingart"]]));
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [play("chain-departed", "gone", "Departed User")],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { passes: "forward" });

      expect(mockInvalidateWatchHistoryEvidence).not.toHaveBeenCalled();
    });

    it("pauses before the first page, not after the run", async () => {
      // Rows commit per page and the forward window has no upper bound, so an
      // end-of-run withdrawal leaves the guard vouching for the server for the
      // whole walk — and a match formed in that window survives the later pause,
      // because a transient refusal preserves existing matches and the executor
      // never re-checks. Asserted by the ORDER of the two calls.
      storedRows({
        min: new Date("2025-07-10T11:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: true,
      });
      mockGetServerAccountNames.mockResolvedValue(new Map());
      const order: string[] = [];
      mockInvalidateWatchHistoryEvidence.mockImplementation(async () => {
        order.push("paused");
      });
      mockGetHistoryPage.mockImplementation(async () => {
        order.push("fetched");
        return { records: [], nextCursor: null };
      });

      await syncTracearrHistory("server-1", { passes: "forward" });

      expect(order[0]).toBe("paused");
    });
  });


  describe("progress is pushed, not waited for", () => {
    // The settings page and the History page both render an import readout, and
    // both used to move only on a fixed-interval poll — so a sync in progress
    // showed a static number while the server rows beside it refreshed every
    // two seconds. The importer emits after each page COMMITS, so a listener
    // that refetches can never read a figure this run has not durably written.
    it("emits after a page commits, tagged with the server", async () => {
      storedRows({
        min: new Date("2025-07-10T11:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: true,
      });
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ id: "chain-1" })],
        nextCursor: null,
      });

      await syncTracearrHistory("server-1", { passes: "forward" });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tracearr:import-progress",
          userId: "user-1",
          meta: { serverId: "server-1" },
        }),
      );
    });

    it("emits per page as the walk proceeds, not only once at the end", async () => {
      // The distinction that matters: a single terminal emit would satisfy a
      // "did it emit" assertion while leaving the readout frozen for the whole
      // walk — which is the bug. Three pages, with the clock advanced past the
      // throttle between them, must produce more than the one closing emit.
      storedRows({
        min: new Date("2021-01-01T00:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: false,
      });
      let clock = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
      mockGetHistoryPage.mockImplementation(async () => {
        clock += 5_000; // past IMPORT_PROGRESS_THROTTLE_MS
        return { records: [historyRecord({ id: `chain-${clock}` })], nextCursor: null };
      });

      try {
        await syncTracearrHistory("server-1", { passes: "backfill" });
      } finally {
        nowSpy.mockRestore();
      }

      const progress = mockEventBus.emit.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "tracearr:import-progress",
      );
      expect(progress.length).toBeGreaterThan(1);
    });

    it("throttles, so a long walk cannot flood every listening client", async () => {
      // Each event costs a listener one status query. The archive walk commits a
      // page roughly every second across thousands of pages, so an unthrottled
      // emit turns a background import into a steady query load for as long as
      // it runs. With the clock held still, many committed pages must collapse
      // to the first emit plus the closing one.
      storedRows({
        min: new Date("2021-01-01T00:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: false,
      });
      const frozen = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => frozen);
      let page = 0;
      mockGetHistoryPage.mockImplementation(async () => ({
        records: [historyRecord({ id: `chain-${page++}` })],
        nextCursor: page < 8 ? `cursor-${page}` : null,
      }));

      try {
        await syncTracearrHistory("server-1", { passes: "backfill" });
      } finally {
        nowSpy.mockRestore();
      }

      const progress = mockEventBus.emit.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "tracearr:import-progress",
      );
      expect(mockGetHistoryPage.mock.calls.length).toBeGreaterThanOrEqual(8);
      expect(progress.length).toBeLessThanOrEqual(2);
    });

    it("always emits a final update, even when the throttle swallowed the last page", async () => {
      // The terminal emit is unthrottled on purpose: it carries the final count
      // and whether the backfill just finished. A readout stuck one page short
      // of done is the same complaint, arriving at the end instead of throughout.
      storedRows({
        min: new Date("2025-07-10T11:00:00.000Z"),
        max: new Date("2025-07-10T12:00:00.000Z"),
        backfillComplete: true,
      });
      mockGetHistoryPage.mockResolvedValueOnce({ records: [], nextCursor: null });

      await syncTracearrHistory("server-1", { passes: "forward" });

      const progress = mockEventBus.emit.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "tracearr:import-progress",
      );
      expect(progress.length).toBeGreaterThanOrEqual(1);
    });
  });

});
