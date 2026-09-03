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
} from "@/lib/tracearr/tracearr-client";
import { IntegrationError } from "@/lib/integration-error";

const HEALTH_URL = "/api/v1/public/health";
const HISTORY_URL = "/api/v2/public/history";

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
      mockAxiosInstance.get.mockResolvedValueOnce({ data: HEALTH });
      await expect(client.testConnection()).resolves.toEqual({
        ok: true,
        version: "2.0.0",
        serverCount: 2,
      });
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
});
