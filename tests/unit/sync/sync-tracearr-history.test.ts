import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

const {
  mockPrisma,
  mockGetHistoryPage,
  mockBuildIndex,
  mockResolve,
  mockReconcile,
  mockInvalidate,
} = vi.hoisted(() => ({
  mockPrisma: {
    mediaServer: { findFirst: vi.fn() },
    tracearrInstance: { findFirst: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  },
  mockGetHistoryPage: vi.fn(),
  mockBuildIndex: vi.fn(),
  mockResolve: vi.fn(),
  mockReconcile: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = mockGetHistoryPage;
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
let watermark: { maxWatchedAt: Date | null; oldestOpenChain: Date | null };
/** Chain ids the DB already holds, for the inserted-vs-updated split. */
let existingEventIds: string[];

function insertCalls() {
  return mockPrisma.$executeRawUnsafe.mock.calls.filter((args) =>
    (args[0] as string).includes('INSERT INTO "WatchHistory"'),
  );
}

function sinceArg(call = 0): Date | undefined {
  return mockGetHistoryPage.mock.calls[call]?.[1]?.since;
}

describe("syncTracearrHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    watermark = { maxWatchedAt: null, oldestOpenChain: null };
    existingEventIds = [];

    mockPrisma.mediaServer.findFirst.mockResolvedValue({
      id: "server-1",
      name: "Test Plex",
      enabled: true,
      tracearrServerId: TRACEARR_SERVER_ID,
      userId: "user-1",
    });
    mockPrisma.tracearrInstance.findFirst.mockResolvedValue({
      id: "tracearr-1",
      name: "Tracearr",
      url: "http://tracearr:8080",
      apiKey: "key",
    });

    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX("watchedAt")')) return [watermark];
      if (sql.includes('SELECT "sourceEventId"')) {
        return existingEventIds.map((id) => ({ sourceEventId: id }));
      }
      return [];
    });
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);

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
  });

  describe("preconditions", () => {
    it("imports nothing when the server is not mapped to a Tracearr server", async () => {
      mockPrisma.mediaServer.findFirst.mockResolvedValueOnce({
        id: "server-1",
        name: "Test Plex",
        enabled: true,
        tracearrServerId: null,
        userId: "user-1",
      });

      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 0 });
      expect(mockGetHistoryPage).not.toHaveBeenCalled();
    });

    it("imports nothing when no enabled Tracearr instance is configured", async () => {
      mockPrisma.tracearrInstance.findFirst.mockResolvedValueOnce(null);

      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 0 });
      expect(mockGetHistoryPage).not.toHaveBeenCalled();
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
    it("pulls the full history on a first run", async () => {
      await syncTracearrHistory("server-1");

      // No Tracearr rows yet — `since` must be absent so the whole history
      // lands once.
      expect(sinceArg()).toBeUndefined();
    });

    it("re-pulls from the watermark minus a one-hour overlap", async () => {
      const max = new Date("2025-07-10T12:00:00.000Z");
      watermark = { maxWatchedAt: max, oldestOpenChain: null };

      await syncTracearrHistory("server-1");

      // `since` also scopes the aggregation, so a chain starting just before
      // the watermark would otherwise report a truncated percent_complete.
      expect(sinceArg()?.getTime()).toBe(max.getTime() - HOUR_MS);
    });

    it("reaches back to the oldest unsettled chain", async () => {
      const max = new Date("2025-07-10T12:00:00.000Z");
      const open = new Date(max.getTime() - 3 * DAY_MS);
      watermark = { maxWatchedAt: max, oldestOpenChain: open };

      await syncTracearrHistory("server-1");

      // A chain still `playing` at 12% must be re-fetched once it finishes, or
      // it stays watched=false forever and never counts as a play.
      expect(sinceArg()?.getTime()).toBe(open.getTime());
    });

    it("clamps an abandoned chain to the seven-day lookback", async () => {
      const max = new Date("2025-07-10T12:00:00.000Z");
      watermark = {
        maxWatchedAt: max,
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

      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 3 });

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
      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 1 });
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
      // The chain's start instant and our own row identity must survive a
      // re-delivery.
      expect(sql).toContain('"watched" = EXCLUDED."watched"');
      expect(sql).toContain('"percentComplete" = EXCLUDED."percentComplete"');
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

      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 1 });
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

      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 1 });
      expect(insertCalls().length).toBe(1);
    });

    it("skips a record belonging to another Tracearr server", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ server_id: "some-other-server" })],
        nextCursor: null,
      });

      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 0 });
      expect(insertCalls().length).toBe(0);
    });

    it("skips a record whose started_at cannot be parsed", async () => {
      mockGetHistoryPage.mockResolvedValueOnce({
        records: [historyRecord({ started_at: "not-a-date" })],
        nextCursor: null,
      });

      // `watchedAt` is what the watermark and the reconcile are computed from,
      // so an unparseable start makes the row worse than useless.
      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 0 });
      expect(insertCalls().length).toBe(0);
    });

    it("writes the same chain once when the overlap window re-delivers it", async () => {
      mockGetHistoryPage
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          records: [historyRecord({ id: "chain-1" })],
          nextCursor: null,
        });

      // One INSERT statement may not touch the same conflicting row twice, and
      // re-writing it buys nothing.
      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 1 });
      expect(insertCalls().length).toBe(1);
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
      await expect(syncTracearrHistory("server-1")).resolves.toEqual({ count: 1 });
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });
  });
});
