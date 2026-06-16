import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/http-retry", () => ({
  configureRetry: vi.fn(),
}));

const mockAxiosInstance = {
  get: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

vi.mock("axios", () => {
  const actualAxios = {
    create: vi.fn(() => mockAxiosInstance),
    isAxiosError: function (e: unknown) {
      return e instanceof Error && "isAxiosError" in e;
    },
  };
  return { default: actualAxios };
});

import { TautulliClient } from "@/lib/tautulli/client";

function envelope<T>(data: T, result = "success", message: string | null = null) {
  return { data: { response: { result, message, data } } };
}

describe("TautulliClient", () => {
  let client: TautulliClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new TautulliClient("http://tautulli:8181/", "key123");
  });

  it("sends apikey, cmd and out_type as query params", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce(envelope({ pms_name: "Plex", pms_version: "1.40" }));
    await client.testConnection();
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2", {
      params: expect.objectContaining({ apikey: "key123", cmd: "get_server_info", out_type: "json" }),
    });
  });

  it("testConnection returns ok with server identity on success", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce(envelope({ pms_name: "Living Room", pms_version: "1.40.1" }));
    const res = await client.testConnection();
    expect(res).toEqual({ ok: true, appName: "Living Room", version: "1.40.1" });
  });

  it("testConnection returns not-ok when result is error", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce(envelope(null, "error", "Invalid apikey"));
    const res = await client.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid apikey");
  });

  it("getHistory normalizes rows (epoch→Date, ids→string) and requests grouping=1 asc", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce(
      envelope({
        recordsFiltered: 1,
        data: [
          {
            row_id: 1124,
            reference_id: 1123,
            rating_key: 4348,
            grandparent_rating_key: 351,
            guid: "com.plexapp.agents.thetvdb://121361/6/1?lang=en",
            user: "DanyKhaleesi69",
            media_type: "episode",
            date: 1462687607,
            started: 1462688107,
            stopped: 1462688370,
            play_duration: 263,
            paused_counter: 0,
            percent_complete: 84,
            ip_address: "1.2.3.4",
            location: "wan",
            platform: "Windows",
            player: "Castle-PC",
            product: "Plex for Windows",
            transcode_decision: "transcode",
            video_decision: "transcode",
            audio_decision: "copy",
          },
        ],
      })
    );

    const { rows, recordsFiltered } = await client.getHistory({ after: "2024-01-01" });

    expect(recordsFiltered).toBe(1);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2", {
      params: expect.objectContaining({
        cmd: "get_history",
        grouping: 1,
        order_column: "date",
        order_dir: "asc",
        after: "2024-01-01",
      }),
    });
    const row = rows[0];
    expect(row.rowId).toBe("1124");
    expect(row.referenceId).toBe("1123");
    expect(row.ratingKey).toBe("4348");
    expect(row.grandparentRatingKey).toBe("351");
    expect(row.user).toBe("DanyKhaleesi69");
    expect(row.stoppedAt).toEqual(new Date(1462688370 * 1000));
    expect(row.playDurationSec).toBe(263);
    expect(row.transcodeDecision).toBe("transcode");
  });

  it("getStreamData maps source vs delivered fields", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce(
      envelope({
        video_codec: "h264",
        audio_codec: "dts",
        container: "mkv",
        video_resolution: "1080",
        video_dynamic_range: "HDR10",
        stream_video_codec: "h264",
        stream_audio_codec: "aac",
        stream_container: "mp4",
        stream_video_resolution: "720",
        stream_video_bitrate: 527,
        stream_audio_bitrate: 203,
        stream_bitrate: 730,
        stream_video_dynamic_range: "SDR",
        video_decision: "transcode",
        audio_decision: "transcode",
        subtitle_decision: "",
        transcode_hw_decoding: "",
        transcode_hw_encoding: "nvenc",
      })
    );

    const s = await client.getStreamData("1124");
    expect(s.sourceVideoCodec).toBe("h264");
    expect(s.sourceVideoDynamicRange).toBe("HDR10");
    expect(s.streamVideoResolution).toBe("720");
    expect(s.streamBitrate).toBe(730);
    expect(s.streamVideoDynamicRange).toBe("SDR");
    expect(s.transcodeHwEncode).toBe("nvenc");
    // empty strings normalize to null
    expect(s.transcodeHwDecode).toBeNull();
    expect(s.subtitleDecision).toBeNull();
  });

  it("getStreamData passes row_id", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce(envelope({}));
    await client.getStreamData("999");
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2", {
      params: expect.objectContaining({ cmd: "get_stream_data", row_id: "999" }),
    });
  });
});
