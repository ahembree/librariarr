import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AxiosError, InternalAxiosRequestConfig } from "axios";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Hoisted because both are referenced inside the `axios` factory below, and
// `vi.mock` is hoisted above this module's top-level consts.
const { mockAxiosInstance, createSpy } = vi.hoisted(() => {
  const instance = {
    get: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  };
  return {
    mockAxiosInstance: instance,
    createSpy: vi.fn(function () {
      return instance;
    }),
  };
});

vi.mock("axios", () => {
  // The client uses the default export (`axios.create`) *and* the named
  // `isAxiosError`, so the mock has to provide both — a missing named export
  // would make the 429 branch throw a TypeError instead of retrying.
  const isAxiosError = (e: unknown) => e instanceof Error && "isAxiosError" in e;
  return { default: { create: createSpy, isAxiosError }, isAxiosError };
});

import {
  TracearrClient,
  MAX_PAGE_SIZE,
  type TracearrHistoryRecord,
  type TracearrUserIdentity,
} from "@/lib/tracearr/tracearr-client";
import { IntegrationError } from "@/lib/integration-error";
import { logger } from "@/lib/logger";

const HEALTH_URL = "/api/v1/public/health";
const HISTORY_URL = "/api/v2/public/history";
const USERS_URL = "/api/v2/public/users";

/**
 * Mirrors the client's private rate-limit constants. Deliberately re-declared
 * rather than exported: the tests assert the *observable* schedule (when the
 * retry GET is issued), so these are the expected values, not the source.
 */
const FALLBACK_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

const NOW = new Date("2026-09-03T12:00:00.000Z");

const HEALTH = {
  status: "ok",
  version: "2.0.0",
  timestamp: NOW.toISOString(),
  servers: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Basement Plex",
      type: "plex",
      online: true,
      activeStreams: 2,
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Attic Jellyfin",
      type: "jellyfin",
      online: false,
      activeStreams: 0,
    },
  ],
};

/**
 * A realistic, fully populated `HistoryRecord`.
 *
 * Typed as `TracearrHistoryRecord` on purpose — the annotation turns this
 * fixture into a compile-time contract, so dropping or renaming a field in the
 * client breaks the build here rather than silently producing an importer that
 * writes nulls into `WatchHistory`. Every field the import maps to a column is
 * present with a distinguishable value: `id`→sourceEventId,
 * `reference_id`→referenceId, `started_at`→watchedAt, `device`→deviceName,
 * `platform`→platform, `user.username`→serverUsername, and the source_/stream_
 * detail objects + `*_display` strings that bundle into `streamQuality`.
 */
const FULL_RECORD: TracearrHistoryRecord = {
  id: "chain-0001",
  server_id: "11111111-1111-1111-1111-111111111111",
  server_name: "Basement Plex",
  server_type: "plex",
  state: "stopped",
  media_type: "episode",
  media_title: "Ozymandias",
  show_title: "Breaking Bad",
  season_number: 5,
  episode_number: 14,
  year: 2013,
  artist_name: null,
  album_name: null,
  track_number: null,
  disc_number: null,
  thumb_path: "/library/metadata/1234/thumb/1700000000",
  poster_url: "https://tracearr.example/poster/1234.jpg",
  duration_ms: 2_760_000,
  progress_ms: 2_820_000,
  total_duration_ms: 2_880_000,
  percent_complete: 97.9,
  started_at: "2026-09-02T21:04:00.000Z",
  stopped_at: "2026-09-02T21:53:00.000Z",
  watched: true,
  // >1 — this is the only field that reveals the record aggregates a resume
  // chain, which is why the importer upserts instead of inserting.
  segment_count: 3,
  device: "Living Room Shield",
  player: "Plex for Android TV",
  product: "Plex for Android (TV)",
  platform: "Android",
  is_transcode: true,
  video_decision: "transcode",
  audio_decision: "copy",
  bitrate: 8_000,
  source_video_codec: "hevc",
  source_audio_codec: "eac3",
  source_audio_channels: 6,
  source_video_width: 3840,
  source_video_height: 2160,
  source_video_details: {
    bitrate: 42_000,
    framerate: "24p",
    dynamicRange: "Dolby Vision",
    aspectRatio: 1.78,
    profile: "main 10",
    level: "5.1",
    colorSpace: "bt2020nc",
    colorDepth: 10,
  },
  source_audio_details: {
    bitrate: 640,
    channelLayout: "5.1(side)",
    language: "English",
    sampleRate: 48_000,
  },
  stream_video_codec: "h264",
  stream_audio_codec: "eac3",
  stream_video_details: {
    bitrate: 8_000,
    width: 1920,
    height: 1080,
    framerate: "24p",
    dynamicRange: "SDR",
  },
  stream_audio_details: { bitrate: 640, channels: 6, language: "English" },
  transcode_info: {
    containerDecision: "transcode",
    sourceContainer: "mkv",
    streamContainer: "mpegts",
    hwRequested: true,
    hwDecoding: "nvdec",
    hwEncoding: "nvenc",
    speed: 4.2,
    throttled: false,
    reasons: ["Direct play not supported by client"],
  },
  subtitle_info: {
    decision: "burn",
    codec: "subrip",
    language: "English",
    forced: false,
  },
  resolution: "4K",
  source_video_codec_display: "HEVC",
  source_audio_codec_display: "Dolby Digital Plus",
  audio_channels_display: "5.1",
  stream_video_codec_display: "H.264",
  stream_audio_codec_display: "Dolby Digital Plus",
  media_id: "media-9001",
  show_media_id: "media-8001",
  imdb_id: "tt2301451",
  tmdb_id: 62_161,
  tvdb_id: 81_189,
  rating_key: "48291",
  parent_rating_key: "48200",
  grandparent_rating_key: "48000",
  library_id: "lib-2",
  genres: ["Drama", "Crime", "Thriller"],
  reference_id: "chain-0001",
  user: {
    id: "identity-77",
    server_user_id: "plex-1234567",
    username: "walter",
    thumb_url: "https://plex.tv/users/abc/avatar",
    avatar_url: "https://tracearr.example/avatar/77.png",
  },
};

/** An axios failure shaped the way the real response interceptor sees one. */
function axiosFailure(
  status: number | null,
  headers: Record<string, string> = {},
  url = HISTORY_URL,
): AxiosError {
  const error = new Error(
    status === null ? "connect ECONNREFUSED" : `Request failed with status code ${status}`,
  ) as AxiosError;
  error.isAxiosError = true;
  error.code = status === null ? "ECONNREFUSED" : "ERR_BAD_REQUEST";
  error.config = { url, method: "get" } as InternalAxiosRequestConfig;
  error.response =
    status === null
      ? undefined
      : ({
          status,
          data: { message: "Too Many Requests" },
          headers,
        } as unknown as AxiosError["response"]);
  error.toJSON = () => ({});
  return error;
}

/**
 * What the retry loop actually receives in production: the client's own
 * response interceptor has already wrapped the axios error, so the 429 has to
 * be recognised off `IntegrationError.status` and `Retry-After` read off its
 * `cause`.
 */
function rateLimited(
  headers: Record<string, string> = {},
  url = HISTORY_URL,
): IntegrationError {
  return new IntegrationError("Tracearr", axiosFailure(429, headers, url));
}

function historyBody(records: unknown, nextCursor: string | null = null) {
  return { data: { data: records, meta: { nextCursor, pageSize: MAX_PAGE_SIZE } } };
}

function usersBody(identities: unknown, nextCursor: string | null = null) {
  return { data: { data: identities, meta: { nextCursor, pageSize: MAX_PAGE_SIZE } } };
}

/** The `params` of every request issued, in order. */
function issuedParams(): Array<Record<string, string | number | undefined>> {
  return mockAxiosInstance.get.mock.calls.map((call) => call[1].params);
}

describe("TracearrClient", () => {
  let client: TracearrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new TracearrClient("https://tracearr.example", "test-api-key");
  });

  describe("construction", () => {
    it("sends the API key as a bearer token", () => {
      new TracearrClient("https://tracearr.example", "my-key");
      expect(createSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer my-key",
            Accept: "application/json",
          }),
        }),
      );
    });

    it("strips trailing slashes from the base URL", () => {
      new TracearrClient("https://tracearr.example///", "k");
      expect(createSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseURL: "https://tracearr.example" }),
      );
    });

    it("preserves a base path so an instance behind a subdirectory still resolves", () => {
      // Only trailing slashes go — axios joins the prefix with the relative
      // request paths, so a reverse-proxied `/tracearr` mount must survive.
      new TracearrClient("https://host.example/tracearr/", "k");
      expect(createSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseURL: "https://host.example/tracearr" }),
      );
    });

    it("applies the 20s request timeout", () => {
      new TracearrClient("https://tracearr.example", "k");
      expect(createSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: 20_000 }),
      );
    });
  });

  describe("getHealth", () => {
    it("hits the v1 health route (v2 has none)", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: HEALTH });
      const health = await client.getHealth();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(HEALTH_URL);
      expect(health).toEqual(HEALTH);
    });
  });

  describe("listServers", () => {
    it("returns the monitored media servers from the health payload", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: HEALTH });
      const servers = await client.listServers();
      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual({
        id: "11111111-1111-1111-1111-111111111111",
        name: "Basement Plex",
        type: "plex",
        online: true,
        activeStreams: 2,
      });
    });

    it("returns an empty list when the payload carries no servers array", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { status: "ok", version: "2.0.0", timestamp: NOW.toISOString() },
      });
      await expect(client.listServers()).resolves.toEqual([]);
    });

    it("returns an empty list when servers is not an array", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { ...HEALTH, servers: "nope" },
      });
      await expect(client.listServers()).resolves.toEqual([]);
    });
  });

  describe("testConnection", () => {
    it("reports the version and server count on success", async () => {
      // Two probes: v1 health, then a v2 capability check. See the client.
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: HEALTH })
        .mockResolvedValueOnce({ data: { data: [], meta: { nextCursor: null } } });
      await expect(client.testConnection()).resolves.toEqual({
        ok: true,
        version: "2.0.0",
        serverCount: 2,
      });
    });

    it("probes the v2 history route, not just v1 health", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: HEALTH })
        .mockResolvedValueOnce({ data: { data: [], meta: { nextCursor: null } } });
      await client.testConnection();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.get.mock.calls[0][0]).toBe("/api/v1/public/health");
      expect(mockAxiosInstance.get.mock.calls[1][0]).toBe("/api/v2/public/history");
    });

    it.each([404, 400])(
      "fails with a version hint when the v2 API answers %i",
      async (status) => {
        // A pre-2.0.0 Tracearr serves v1 health happily and has no v2 history
        // route. Passing the test would map a server and wipe its history for
        // an import that could never return anything.
        mockAxiosInstance.get
          .mockResolvedValueOnce({ data: HEALTH })
          .mockRejectedValueOnce(
            new IntegrationError("Tracearr", axiosFailure(status, {}, "/api/v2/public/history")),
          );
        const result = await client.testConnection();
        expect(result.ok).toBe(false);
        expect(result.error).toContain("2.0.0 or later");
      },
    );

    it("surfaces a v2 auth failure as-is", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: HEALTH })
        .mockRejectedValueOnce(
          new IntegrationError("Tracearr", axiosFailure(403, {}, "/api/v2/public/history")),
        );
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Tracearr HTTP 403");
    });

    it("returns the failure reason instead of throwing", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        new IntegrationError("Tracearr", axiosFailure(401, {}, HEALTH_URL)),
      );
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Tracearr HTTP 401");
    });

    it("falls back to a generic message for a non-Error rejection", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce("string error");
      await expect(client.testConnection()).resolves.toEqual({
        ok: false,
        error: "Connection failed",
      });
    });
  });

  describe("getHistoryPage", () => {
    it("always scopes the request to one server_id and asks for the max page size", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));
      await client.getHistoryPage("srv-1");
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(HISTORY_URL, {
        params: { server_id: "srv-1", pageSize: MAX_PAGE_SIZE },
      });
    });

    it("clamps an oversized pageSize to 100", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));
      await client.getHistoryPage("srv-1", { pageSize: 250 });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(HISTORY_URL, {
        params: { server_id: "srv-1", pageSize: 100 },
      });
    });

    it("clamps a zero pageSize to 1", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));
      await client.getHistoryPage("srv-1", { pageSize: 0 });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(HISTORY_URL, {
        params: { server_id: "srv-1", pageSize: 1 },
      });
    });

    it("omits cursor, since and until when they are not supplied", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));
      await client.getHistoryPage("srv-1");
      const params = mockAxiosInstance.get.mock.calls[0][1].params;
      expect(Object.keys(params).sort()).toEqual(["pageSize", "server_id"]);
    });

    it("sends cursor, since and until as ISO strings when supplied", async () => {
      const since = new Date("2026-08-01T00:00:00.000Z");
      const until = new Date("2026-09-01T12:30:45.123Z");
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));

      await client.getHistoryPage("srv-1", {
        cursor: "opaque-cursor",
        since,
        until,
        pageSize: 50,
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(HISTORY_URL, {
        params: {
          server_id: "srv-1",
          pageSize: 50,
          cursor: "opaque-cursor",
          since: "2026-08-01T00:00:00.000Z",
          until: "2026-09-01T12:30:45.123Z",
        },
      });
    });

    it("maps data and meta.nextCursor onto records and nextCursor", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(
        historyBody([FULL_RECORD], "next-page-cursor"),
      );
      const page = await client.getHistoryPage("srv-1");
      expect(page.records).toEqual([FULL_RECORD]);
      expect(page.nextCursor).toBe("next-page-cursor");
    });

    it("returns a null cursor when meta is missing entirely", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { data: [FULL_RECORD] } });
      const page = await client.getHistoryPage("srv-1");
      expect(page.records).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });

    it("returns no records when data is absent", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { meta: { nextCursor: null, pageSize: 25 } },
      });
      await expect(client.getHistoryPage("srv-1")).resolves.toEqual({
        records: [],
        nextCursor: null,
      });
    });

    it("returns no records when data is not an array", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody({ oops: true }, "c1"));
      const page = await client.getHistoryPage("srv-1");
      expect(page.records).toEqual([]);
      expect(page.nextCursor).toBe("c1");
    });

    it("survives an empty body", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: null });
      await expect(client.getHistoryPage("srv-1")).resolves.toEqual({
        records: [],
        nextCursor: null,
      });
    });

    it("round-trips a full HistoryRecord with every field readable", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([FULL_RECORD]));
      const [record] = (await client.getHistoryPage("srv-1")).records;

      // The whole record survives untouched — the client is a transport, it
      // does no field mapping of its own.
      expect(record).toEqual(FULL_RECORD);

      // The columns the importer writes, asserted individually so a change to
      // the mapping contract fails on a named field rather than a deep diff.
      expect(record.id).toBe("chain-0001");
      expect(record.reference_id).toBe("chain-0001");
      expect(record.started_at).toBe("2026-09-02T21:04:00.000Z");
      expect(record.stopped_at).toBe("2026-09-02T21:53:00.000Z");
      expect(record.device).toBe("Living Room Shield");
      expect(record.platform).toBe("Android");
      expect(record.player).toBe("Plex for Android TV");
      expect(record.product).toBe("Plex for Android (TV)");
      expect(record.user.username).toBe("walter");
      expect(record.watched).toBe(true);
      expect(record.percent_complete).toBe(97.9);
      expect(record.progress_ms).toBe(2_820_000);
      expect(record.duration_ms).toBe(2_760_000);
      expect(record.total_duration_ms).toBe(2_880_000);
      expect(record.segment_count).toBe(3);
      expect(record.is_transcode).toBe(true);
      expect(record.video_decision).toBe("transcode");
      expect(record.audio_decision).toBe("copy");
      expect(record.bitrate).toBe(8_000);
      expect(record.resolution).toBe("4K");
      expect(record.rating_key).toBe("48291");
      expect(record.tvdb_id).toBe(81_189);
      expect(record.tmdb_id).toBe(62_161);
      expect(record.imdb_id).toBe("tt2301451");

      // The Json bundles: transcodeInfo, subtitleInfo, and the streamQuality
      // blob (source_/stream_ detail objects + channels/dimensions + displays).
      expect(record.transcode_info?.hwEncoding).toBe("nvenc");
      expect(record.subtitle_info?.decision).toBe("burn");
      expect(record.source_video_details?.dynamicRange).toBe("Dolby Vision");
      expect(record.source_audio_details?.channelLayout).toBe("5.1(side)");
      expect(record.stream_video_details?.height).toBe(1080);
      expect(record.stream_audio_details?.channels).toBe(6);
      expect(record.source_audio_channels).toBe(6);
      expect(record.source_video_width).toBe(3840);
      expect(record.source_video_height).toBe(2160);
      expect(record.source_video_codec_display).toBe("HEVC");
      expect(record.source_audio_codec_display).toBe("Dolby Digital Plus");
      expect(record.audio_channels_display).toBe("5.1");
      expect(record.stream_video_codec_display).toBe("H.264");
      expect(record.stream_audio_codec_display).toBe("Dolby Digital Plus");
    });
  });

  describe("429 handling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Assert the retry was scheduled *exactly* `expectedDelayMs` out: one
     * millisecond short of it the second GET must not have been issued, one
     * millisecond later it must have. `resolveRetryDelay` is private, so the
     * observable schedule is both the only thing reachable and the only thing
     * that matters.
     */
    async function expectRetryAfter(expectedDelayMs: number) {
      // Flush the first rejection so the retry timer exists.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    }

    it("retries once and resolves, re-sending the identical query", async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited())
        .mockResolvedValueOnce(historyBody([FULL_RECORD], "c2"));

      const promise = client.getHistoryPage("srv-1", { cursor: "c1" });
      await expectRetryAfter(FALLBACK_DELAY_MS);
      const page = await promise;

      expect(page.records).toHaveLength(1);
      expect(page.nextCursor).toBe("c2");
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      // The retry must not lose the cursor, or a paging loop would restart.
      expect(mockAxiosInstance.get.mock.calls[1]).toEqual(
        mockAxiosInstance.get.mock.calls[0],
      );
    });

    it("throws on a second consecutive 429 without a third attempt", async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited())
        .mockRejectedValueOnce(rateLimited());

      const settled = client.getHistoryPage("srv-1").catch((e: unknown) => e);
      await expectRetryAfter(FALLBACK_DELAY_MS);
      const error = await settled;

      expect(error).toBeInstanceOf(IntegrationError);
      expect((error as IntegrationError).status).toBe(429);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it("honours Retry-After given in delta-seconds", async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited({ "retry-after": "12" }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(12_000);
      await promise;
    });

    it("honours a Retry-After HTTP date", async () => {
      // `toUTCString` truncates to whole seconds; NOW sits on a second
      // boundary, so the computed wait is exactly 8s.
      const header = new Date(NOW.getTime() + 8_000).toUTCString();
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited({ "retry-after": header }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(8_000);
      await promise;
    });

    it("clamps an absurd Retry-After to the 60s ceiling", async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited({ "retry-after": "999999" }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(MAX_DELAY_MS);
      await promise;
    });

    it("clamps a far-future Retry-After date to the 60s ceiling", async () => {
      const header = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toUTCString();
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited({ "retry-after": header }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(MAX_DELAY_MS);
      await promise;
    });

    it("falls back to a 5s wait when Retry-After is missing", async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited())
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(FALLBACK_DELAY_MS);
      await promise;
    });

    it("falls back to a 5s wait for an unparseable Retry-After", async () => {
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited({ "retry-after": "soon" }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(FALLBACK_DELAY_MS);
      await promise;
    });

    it("falls back to a 5s wait for a Retry-After date in the past", async () => {
      const header = new Date(NOW.getTime() - 30_000).toUTCString();
      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimited({ "retry-after": header }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(FALLBACK_DELAY_MS);
      await promise;
    });

    it("recognises a raw axios 429 that reached the loop unwrapped", async () => {
      // Defence in depth: the response interceptor normally wraps every
      // failure in an IntegrationError, but the loop also reads the status off
      // a bare AxiosError — and `Retry-After` off its own response.
      mockAxiosInstance.get
        .mockRejectedValueOnce(axiosFailure(429, { "retry-after": "3" }))
        .mockResolvedValueOnce(historyBody([]));

      const promise = client.getHistoryPage("srv-1");
      await expectRetryAfter(3_000);
      await promise;
    });

    it("does not retry a 429 on the health route — only history paging retries", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(rateLimited({}, HEALTH_URL));
      await expect(client.getHealth()).rejects.toBeInstanceOf(IntegrationError);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("non-429 failures", () => {
    it("throws a 500 immediately, with no retry", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        new IntegrationError("Tracearr", axiosFailure(500)),
      );
      await expect(client.getHistoryPage("srv-1")).rejects.toBeInstanceOf(
        IntegrationError,
      );
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it("throws a network error immediately, with no retry", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(
        new IntegrationError("Tracearr", axiosFailure(null)),
      );
      const error = await client.getHistoryPage("srv-1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntegrationError);
      expect((error as IntegrationError).status).toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it("rethrows a non-axios rejection unchanged", async () => {
      const boom = new Error("boom");
      mockAxiosInstance.get.mockRejectedValueOnce(boom);
      await expect(client.getHistoryPage("srv-1")).rejects.toBe(boom);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The two halves of "a bulk history walk must be both survivable and
   * stoppable". A first import of 160k plays is ~1,600 sequential pages, so it
   * WILL be throttled repeatedly (hence the larger budget) and it has to be
   * abandonable the moment the user says so (hence the signal) — including
   * while it is sitting in a rate-limit backoff, which is precisely where a
   * long walk spends its idle time.
   */
  describe("cancellation", () => {
    beforeEach(() => {
      // `mockReset`, not `mockClear`: a test that aborts mid-backoff
      // deliberately consumes FEWER queued responses than it armed (the abort
      // check after the sleep drops the retry), and a leftover `…Once` rejection
      // would surface in the next test as a mystery 15s timeout — it would take
      // the default 5s backoff under fake timers that nothing advances.
      mockAxiosInstance.get.mockReset();
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Queue exactly `n` 429s, so nothing is left over to leak into the next test. */
    function armRateLimits(n: number, headers: Record<string, string> = {}) {
      for (let i = 0; i < n; i++) {
        mockAxiosInstance.get.mockRejectedValueOnce(rateLimited(headers));
      }
    }

    /** Drain every backoff a run can schedule (5 retries × the 60s ceiling). */
    function drainBackoffs() {
      return vi.advanceTimersByTimeAsync(5 * MAX_DELAY_MS);
    }

    it("retries a bulk walk further than the single interactive retry", async () => {
      // Interactive: 1 attempt + 1 retry.
      armRateLimits(2);
      const interactive = client.getHistoryPage("srv-1").catch((e: unknown) => e);
      await drainBackoffs();
      await interactive;
      const interactiveCalls = mockAxiosInstance.get.mock.calls.length;

      mockAxiosInstance.get.mockClear();

      // Bulk: 1 attempt + 5 retries.
      armRateLimits(6);
      const bulk = client
        .getHistoryPage("srv-1", { bulk: true })
        .catch((e: unknown) => e);
      await drainBackoffs();
      await bulk;
      const bulkCalls = mockAxiosInstance.get.mock.calls.length;

      // The limiter is per key on a rolling 1-minute window, so a 429 during a
      // thousand-page walk is expected, not exceptional — one retry would
      // abandon the import on the first throttle and leave the user re-running
      // Refresh over and over to get through a first import. Waiting the window
      // out is the whole point of a rolling limit.
      expect(interactiveCalls).toBe(2);
      expect(bulkCalls).toBe(6);
      expect(bulkCalls).toBeGreaterThan(interactiveCalls);
    });

    it("does not wait out a rate-limit backoff after an abort", async () => {
      const controller = new AbortController();
      // Exactly one: the abort lands during the backoff, and the retry it would
      // have driven is dropped rather than issued, so a second is never used.
      // A full-ceiling backoff, so "settled early" cannot be a rounding artefact.
      armRateLimits(1, { "retry-after": "60" });

      const startedAt = Date.now();
      const settled = client
        .getHistoryPage("srv-1", { signal: controller.signal })
        .catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(1_000);
      // Still asleep a second in: the retry is genuinely pending on a 60s timer.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);

      controller.abort();
      // No further clock movement — the sleep resolves off the abort event, not
      // off its timer. Without that, hitting Stop during a throttled import
      // would leave the run alive for up to another minute per page.
      await vi.advanceTimersByTimeAsync(0);

      expect(await settled).toBeInstanceOf(IntegrationError);
      expect(Date.now() - startedAt).toBe(1_000);
      // The pending backoff timer was cleared rather than left to fire.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("forwards the signal to the underlying axios request", async () => {
      const controller = new AbortController();
      mockAxiosInstance.get.mockResolvedValueOnce(historyBody([]));

      await client.getHistoryPage("srv-1", { signal: controller.signal });

      // Cancelling has to reach the in-flight HTTP request, not just the loop
      // around it: a page can be blocked on a 20s timeout, and the importer
      // only re-checks its own signal between pages.
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(HISTORY_URL, {
        params: { server_id: "srv-1", pageSize: MAX_PAGE_SIZE },
        signal: controller.signal,
      });
    });
  });

  describe("findOldestPlayAt", () => {
    /**
     * Mirrors the client's private search constants. Re-declared rather than
     * exported for the same reason as the rate-limit ones above: these tests
     * assert the *observable* search, so these are the expected values, not the
     * source of them.
     */
    const SEARCH_FLOOR = new Date("2008-01-01T00:00:00.000Z");
    const PRECISION_MS = 60 * 60 * 1000;

    /** The user's real history: seven years of plays, newest last night. */
    const OLDEST = new Date("2019-07-21T03:17:00.000Z");
    const NEWEST = new Date("2026-09-02T21:04:00.000Z");

    /**
     * What answering the same question by WALKING would have cost. Their
     * instance holds ~160k plays; at the API's 100-record maximum that is
     * ~1,600 sequential GETs, every one of them against the same per-key
     * one-minute rate limit. Bisection exists to replace exactly this number,
     * so it is the thing worth measuring against.
     */
    const PLAYS_IN_HISTORY = 160_000;
    const WALK_CALLS = Math.ceil(PLAYS_IN_HISTORY / MAX_PAGE_SIZE);

    /** Probes at hour precision over the searchable range, plus the newest one. */
    const EXPECTED_CALLS =
      1 + Math.ceil(Math.log2((NEWEST.getTime() - SEARCH_FLOOR.getTime()) / PRECISION_MS));

    beforeEach(() => {
      // `mockReset`, not `mockClear`: these tests install an *implementation*
      // rather than queueing `…Once` responses, and a survivor would silently
      // answer the next test's probes.
      mockAxiosInstance.get.mockReset();
    });

    afterEach(() => {
      mockAxiosInstance.get.mockReset();
    });

    /**
     * A synthetic history holding exactly two plays, answered the way the API
     * answers: the NEWEST record at-or-before `until`, and an empty page when
     * `until` predates the history entirely.
     *
     * Two plays rather than one on purpose — with a single record every probe
     * would return the same instant the caller asked about, so a search could
     * "converge" by echoing its own bisection midpoint back. Here the only
     * values that can come out are a real record's `started_at`.
     */
    function serveHistory(
      oldest: Date,
      newest: Date,
      onProbe: (calls: number) => void = () => {},
    ) {
      let calls = 0;
      mockAxiosInstance.get.mockImplementation(
        async (_url: string, config: { params: Record<string, string | number> }) => {
          calls += 1;
          onProbe(calls);
          const raw = config.params.until;
          const until =
            typeof raw === "string" ? Date.parse(raw) : Number.POSITIVE_INFINITY;
          if (until < oldest.getTime()) return historyBody([]);
          const at = until >= newest.getTime() ? newest : oldest;
          return historyBody([{ ...FULL_RECORD, started_at: at.toISOString() }]);
        },
      );
    }

    /** The `params` of every probe issued, in order. */
    function probes(): Array<Record<string, string | number | undefined>> {
      return mockAxiosInstance.get.mock.calls.map((call) => call[1].params);
    }

    it("converges on the oldest play's started_at", async () => {
      serveHistory(OLDEST, NEWEST);

      const found = await client.findOldestPlayAt("srv-1");

      // Exact, not merely within the hour the search stops at: the record the
      // final successful probe returned IS the oldest play, so the answer is
      // read off the data rather than off the collapsed range.
      expect(found?.toISOString()).toBe(OLDEST.toISOString());
    });

    it("finds it in logarithmically few calls, not the ~1,600 a walk would take", async () => {
      serveHistory(OLDEST, NEWEST);

      await client.findOldestPlayAt("srv-1");
      const calls = mockAxiosInstance.get.mock.calls.length;

      // THE ENTIRE JUSTIFICATION for bisecting `until` instead of paging. The
      // history API is keyset-paginated with no total and no count endpoint, so
      // the only other way to learn where the history starts is to walk to the
      // end of it — ~1,600 rate-limited requests, minutes of wall clock, purely
      // to draw a progress bar. Halving an 18-year range to the hour is ~18
      // probes plus the newest one (19 against the user's live instance).
      // If this bound ever slips, the feature has stopped paying for itself.
      expect(calls).toBeLessThan(30);
      expect(calls).toBeLessThan(WALK_CALLS / 50);
      expect(calls).toBe(EXPECTED_CALLS);
      // Not vacuous: it genuinely searched rather than giving up after probe one.
      expect(calls).toBeGreaterThan(10);
    });

    it("returns null after a single probe for a server with no plays", async () => {
      mockAxiosInstance.get.mockResolvedValue(historyBody([]));

      await expect(client.findOldestPlayAt("srv-1")).resolves.toBeNull();

      // There is nothing to bisect between. Searching a range known to hold no
      // records would be ~18 guaranteed-empty requests per server, on exactly
      // the run — a first import — where the API budget is tightest.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it("still returns a date when the history starts before the search floor", async () => {
      // A play older than the floor is outside the searchable range, so no
      // probe in it can ever come back empty and `lo` never rises off the floor.
      // The loop still has to collapse on the precision bound and hand back the
      // record it found, not spin looking for a boundary that is not in range.
      const beforeFloor = new Date("2005-06-01T00:00:00.000Z");
      serveHistory(beforeFloor, NEWEST);

      const found = await client.findOldestPlayAt("srv-1");

      expect(found).toBeInstanceOf(Date);
      expect(found?.toISOString()).toBe(beforeFloor.toISOString());
      expect(mockAxiosInstance.get.mock.calls.length).toBeLessThan(30);
    });

    it("does not search at all when the floor sits above the whole history", async () => {
      serveHistory(OLDEST, NEWEST);

      const found = await client.findOldestPlayAt("srv-1", {
        floor: new Date("2030-01-01T00:00:00.000Z"),
      });

      // The range is inverted, so there is nothing to halve: the newest probe's
      // own answer stands rather than driving a search whose every result is
      // already known.
      expect(found?.toISOString()).toBe(NEWEST.toISOString());
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it("stops early on an aborted signal instead of running to convergence", async () => {
      const controller = new AbortController();
      // Abort while the search is genuinely mid-flight — three probes in, with
      // a dozen still owed before the range collapses.
      serveHistory(OLDEST, NEWEST, (calls) => {
        if (calls === 3) controller.abort();
      });

      const found = await client.findOldestPlayAt("srv-1", {
        signal: controller.signal,
      });

      // Three, not the ~19 a converged search takes: cancelling a sync must not
      // leave a bisection quietly finishing its probes against the API.
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
      expect(EXPECTED_CALLS).toBeGreaterThan(10);
      // Resolves with the best answer it holds rather than throwing. The caller
      // treats an unmeasured span as "progress unknown", never as a failed run,
      // so an abort here must not become an error the importer has to swallow.
      expect(found).toBeInstanceOf(Date);
    });

    it("probes one record at a time, with `until` as an ISO string", async () => {
      serveHistory(OLDEST, NEWEST);

      await client.findOldestPlayAt("srv-1");
      const all = probes();

      // A 100-record probe would make each step of the measurement as expensive
      // as a page of the walk it exists to replace — and every byte past the
      // first record is discarded, because the probe only asks "is there
      // anything at all before this instant?".
      for (const params of all) {
        expect(params.pageSize).toBe(1);
        expect(params.server_id).toBe("srv-1");
      }

      // The first probe is the unbounded "what is the newest play" question…
      expect(all[0].until).toBeUndefined();
      // …and every later one carries the bisection's upper bound serialised the
      // way the API's `until` filter expects, not as a Date or an epoch number.
      for (const params of all.slice(1)) {
        expect(typeof params.until).toBe("string");
        expect(new Date(params.until as string).toISOString()).toBe(params.until);
      }
    });
  });

  describe("getHistoryForItem", () => {
    /**
     * What this walk actually has to hold, and why the page cap is not a
     * single-item number.
     *
     * The provider-id fallback asks by `tvdb_id`, and the ids stored on an
     * episode are SERIES-level, so one query returns every play of every
     * episode of the show — that is the point of it, since `rating_key` takes
     * one value and a re-added season would otherwise cost a request per
     * episode. So the bound has to cover a long-running show in a household:
     * ~700 episodes, six viewers, watched a few times over the years.
     */
    const LONG_RUNNING_EPISODES = 700;
    const HOUSEHOLD_VIEWERS = 6;
    const REWATCHES = 3;
    const SERIES_SIZED_PLAYS = LONG_RUNNING_EPISODES * HOUSEHOLD_VIEWERS * REWATCHES;

    /** The pre-fix cap, kept as a literal — the regression is "back down to this". */
    const SINGLE_ITEM_CAP_PAGES = 20;

    beforeEach(() => {
      // `mockReset`, not `mockClear`: these tests install an *implementation*
      // (an endless keyset), which would otherwise answer the next test.
      mockAxiosInstance.get.mockReset();
    });

    afterEach(() => {
      mockAxiosInstance.get.mockReset();
    });

    /** A history that never runs out: every page hands back a fresh cursor. */
    function serveEndlessHistory() {
      let page = 0;
      mockAxiosInstance.get.mockImplementation(async () => {
        page += 1;
        return historyBody([{ ...FULL_RECORD, id: `chain-${page}` }], `cursor-${page}`);
      });
    }

    /** Truncation warnings only — the 429 path warns too. */
    function truncationWarnings() {
      return vi
        .mocked(logger.warn)
        .mock.calls.filter((call) => String(call[1]).includes("page cap"));
    }

    it("walks far enough to hold a long-running series' whole play history", async () => {
      serveEndlessHistory();

      const records = await client.getHistoryForItem("srv-1", { tvdbId: 81_189 });
      const pages = mockAxiosInstance.get.mock.calls.length;

      // The walk is newest-first, so a cap that trips does not lose "some"
      // plays — it loses the OLDEST ones, which are exactly what the archive
      // import exists to recover. And nothing asks again: the recovery pass
      // only looks at recently-added items.
      expect(pages * MAX_PAGE_SIZE).toBeGreaterThanOrEqual(SERIES_SIZED_PLAYS);
      expect(pages).toBeGreaterThan(SINGLE_ITEM_CAP_PAGES);
      // Still bounded — this is a runaway guard, not "walk forever".
      expect(pages).toBeLessThanOrEqual(500);
      expect(records).toHaveLength(pages);
    });

    it("logs when the page cap actually truncates a walk", async () => {
      serveEndlessHistory();

      await client.getHistoryForItem("srv-1", { tvdbId: 81_189 });

      // Silent truncation is indistinguishable from "that show had no more
      // plays", so the log has to name the identity that was asked by —
      // otherwise the missing plays are undiagnosable from the outside.
      const warnings = truncationWarnings();
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][1])).toContain("tvdb_id=81189");
      expect(warnings[0][2]).toEqual(
        expect.objectContaining({ serverId: "srv-1", tvdb_id: "81189" }),
      );
    });

    it("does not cry truncation when the history simply ends", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(historyBody([FULL_RECORD], "cursor-2"))
        .mockResolvedValueOnce(historyBody([FULL_RECORD], null));

      const records = await client.getHistoryForItem("srv-1", { ratingKey: "48291" });

      expect(records).toHaveLength(2);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      // A warning on every completed walk would train the reader to ignore the
      // one that matters.
      expect(truncationWarnings()).toHaveLength(0);
    });

    it("issues no request at all when nothing identifies the item", async () => {
      const records = await client.getHistoryForItem("srv-1", {
        tvdbId: null,
        tmdbId: "",
        imdbId: null,
      });

      // An unfiltered history request would page the server's ENTIRE history
      // for one item — the opposite of the bounded lookup this is.
      expect(records).toEqual([]);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe("getServerAccountNames", () => {
    /**
     * The person this bridge exists for, in both states: `walter` still has an
     * account on the server, `jesse` left two years ago and Tracearr has
     * stamped `removed_at` on his — but his plays are still in the archive.
     */
    const ACTIVE: TracearrUserIdentity = {
      id: "identity-77",
      // Tracearr's friendly identity label, deliberately unlike the account
      // name below: storing THIS is the bug the bridge prevents.
      username: "Walter W",
      email: "walter@example.com",
      plex_account_id: "1234567",
      accounts: [
        {
          server_id: "srv-1",
          server_type: "plex",
          server_user_id: "acct-walter",
          external_user_id: "1234567",
          username: "walter",
          removed_at: null,
        },
      ],
    };

    const DEPARTED: TracearrUserIdentity = {
      id: "identity-88",
      username: "Jesse P",
      email: null,
      plex_account_id: "7654321",
      accounts: [
        {
          server_id: "srv-1",
          server_type: "plex",
          server_user_id: "acct-jesse",
          external_user_id: "7654321",
          username: "jesse",
          removed_at: "2024-02-01T00:00:00.000Z",
        },
      ],
    };

    beforeEach(() => {
      mockAxiosInstance.get.mockReset();
    });

    afterEach(() => {
      mockAxiosInstance.get.mockReset();
    });

    /**
     * The users endpoint as the spec describes it, filter included: an identity
     * whose EVERY account has been removed is withheld unless the caller asks
     * for it. Faking the filter rather than the payload is the point — a fixture
     * that always hands back the departed user would pass whether or not the
     * request asked for them.
     */
    function serveUsers(identities: TracearrUserIdentity[]) {
      mockAxiosInstance.get.mockImplementation(
        async (_url: string, config: { params: Record<string, string | number> }) => {
          const includeRemoved = String(config.params.include_removed) === "true";
          const visible = identities.filter(
            (identity) =>
              includeRemoved ||
              identity.accounts.some((account) => account.removed_at === null),
          );
          return usersBody(visible);
        },
      );
    }

    it("asks the users endpoint to include removed accounts, on every page", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(usersBody([ACTIVE], "cursor-2"))
        .mockResolvedValueOnce(usersBody([DEPARTED], null));

      await client.getServerAccountNames("srv-1");

      // The endpoint defaults to EXCLUDING identities whose accounts have all
      // been removed (published spec, `include_removed`, default false). An
      // archive is disproportionately made of departed users — someone who left
      // two years ago still owns two years of plays — so the default would omit
      // precisely the accounts the oldest imported rows need.
      const all = issuedParams();
      expect(all).toHaveLength(2);
      for (const params of all) {
        expect(params.include_removed).toBe("true");
      }
      expect(mockAxiosInstance.get.mock.calls[0][0]).toBe(USERS_URL);
    });

    it("maps a departed user to the server's own account name, not Tracearr's label", async () => {
      serveUsers([ACTIVE, DEPARTED]);

      const names = await client.getServerAccountNames("srv-1");

      // Both vocabularies resolve the same way. If the removed account were
      // missing, his rows would fall back to "Jesse P" while his pre-departure
      // rows (imported by the native path, or by an earlier run) say "jesse" —
      // one human split into two people, silently breaking `watchedByUser`
      // rules and leaderboards on exactly the archive rows.
      expect(names.get("acct-walter")).toBe("walter");
      expect(names.get("acct-jesse")).toBe("jesse");
    });

    it("still ignores an account that belongs to a different server", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(
        usersBody([
          {
            ...DEPARTED,
            accounts: [
              { ...DEPARTED.accounts[0], server_id: "srv-2" },
              {
                ...DEPARTED.accounts[0],
                server_user_id: "acct-jesse-here",
                username: "jesse_pinkman",
              },
            ],
          },
        ]),
      );

      const names = await client.getServerAccountNames("srv-1");

      // One Tracearr instance aggregates many media servers, and asking for
      // removed accounts widens the pool — a stranger's id must still not be
      // mapped onto this server.
      expect(names.get("acct-jesse")).toBeUndefined();
      expect(names.get("acct-jesse-here")).toBe("jesse_pinkman");
    });
  });
});
