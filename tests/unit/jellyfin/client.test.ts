import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AxiosRequestConfig } from "axios";

const { mockAxiosCreate, requestInterceptors } = vi.hoisted(() => {
  const requestInterceptors: Array<(config: AxiosRequestConfig) => unknown> = [];
  const fakeClient = {
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: {
        use: vi.fn((onFulfilled: (config: AxiosRequestConfig) => unknown) => {
          requestInterceptors.push(onFulfilled);
        }),
      },
      response: {
        use: vi.fn(),
      },
    },
  };
  return {
    mockAxiosCreate: vi.fn(() => fakeClient),
    requestInterceptors,
  };
});

vi.mock("axios", () => {
  return {
    default: {
      create: mockAxiosCreate,
      isAxiosError: vi.fn(() => false),
    },
  };
});

vi.mock("@/lib/http-retry", () => ({
  configureRetry: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/health-cache", () => ({
  isUnreachable: vi.fn(() => false),
  markUnreachable: vi.fn(),
  clearUnreachable: vi.fn(),
  getLastFailureMessage: vi.fn(() => undefined),
  ServerUnreachableError: class ServerUnreachableError extends Error {},
}));

import { JellyfinClient } from "@/lib/jellyfin/client";

describe("JellyfinClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestInterceptors.length = 0;
  });

  it("constructs and creates an axios client with the trimmed base URL", () => {
    const client = new JellyfinClient("http://jellyfin:8096/", "jf-token");
    expect(client).toBeInstanceOf(JellyfinClient);
    expect(mockAxiosCreate).toHaveBeenCalledTimes(1);
    const config = (mockAxiosCreate.mock.calls[0] as unknown[])[0] as { baseURL: string };
    // Trailing slashes are stripped by the base constructor.
    expect(config.baseURL).toBe("http://jellyfin:8096");
  });

  it("passes the MediaBrowser auth header via the request interceptor", () => {
    new JellyfinClient("http://jellyfin:8096", "jf-token");

    // The base constructor registers a request interceptor that calls getAuthHeaders().
    expect(requestInterceptors.length).toBe(1);
    const config = { headers: {} as Record<string, string> };
    requestInterceptors[0](config);

    expect(config.headers.Authorization).toContain('MediaBrowser');
    expect(config.headers.Authorization).toContain('Token="jf-token"');
    expect(config.headers.Authorization).toContain('Client="Librariarr"');
  });

  it("does not create a TLS-skipping agent by default", () => {
    new JellyfinClient("http://jellyfin:8096", "jf-token");
    const config = (mockAxiosCreate.mock.calls[0] as unknown[])[0] as { httpsAgent?: unknown };
    expect(config.httpsAgent).toBeUndefined();
  });

  it("configures a TLS-skipping agent when skipTlsVerify is set", () => {
    new JellyfinClient("https://jellyfin:8096", "jf-token", { skipTlsVerify: true });
    const config = (mockAxiosCreate.mock.calls[0] as unknown[])[0] as { httpsAgent?: unknown };
    expect(config.httpsAgent).toBeDefined();
  });

  it("uses 'Jellyfin' as the log prefix via the request debug log", async () => {
    const { logger } = await import("@/lib/logger");
    new JellyfinClient("http://jellyfin:8096", "jf-token");

    requestInterceptors[0]({ headers: {}, method: "get", url: "/Items" });
    expect(logger.debug).toHaveBeenCalledWith("Jellyfin", expect.stringContaining("GET /Items"));
  });

  describe("getSessions", () => {
    function makeClientWithSessions(sessions: unknown[]) {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockResolvedValue({ data: sessions });
      return client;
    }

    // The transcode manager's "4K Transcoding" criterion reads mediaWidth /
    // mediaHeight; without them every Jellyfin session looks sub-4K.
    it("reports the source video resolution of the playing item", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess1",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: {
            Id: "item1",
            Name: "Movie",
            Type: "Movie",
            MediaSources: [
              {
                Id: "src1",
                Name: "src",
                MediaStreams: [
                  { Type: "Audio", Codec: "truehd", Channels: 8 },
                  { Type: "Video", Codec: "hevc", Width: 3840, Height: 2160 },
                ],
              },
            ],
          },
          PlayState: { IsPaused: false, CanSeek: true },
          TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false },
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].mediaWidth).toBe(3840);
      expect(sessions[0].mediaHeight).toBe(2160);
      // Video direct-streams, audio is re-encoded.
      expect(sessions[0].transcoding?.videoDecision).toBe("copy");
      expect(sessions[0].transcoding?.audioDecision).toBe("transcode");
    });

    // Jellyfin has no `local` flag; RemoteEndPoint is populated for LAN
    // clients too, so its mere presence must not mean "remote" — that marked
    // every session WAN and made "Remote Transcoding" match all of them.
    it("classifies a LAN client as local", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess-lan",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "i", Name: "Movie", Type: "Movie" },
          PlayState: { IsPaused: false, CanSeek: true },
          RemoteEndPoint: "192.168.1.50:54321",
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].player.local).toBe(true);
      expect(sessions[0].player.address).toBe("192.168.1.50:54321");
      expect(sessions[0].session.location).toBe("lan");
    });

    it("classifies a public client as remote", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess-wan",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "i", Name: "Movie", Type: "Movie" },
          PlayState: { IsPaused: false, CanSeek: true },
          RemoteEndPoint: "203.0.113.9:44100",
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].player.local).toBe(false);
      expect(sessions[0].session.location).toBe("wan");
    });

    it("captures the hardware acceleration type", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess-hw",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "i", Name: "Movie", Type: "Movie" },
          PlayState: { IsPaused: false, CanSeek: true },
          TranscodingInfo: {
            IsVideoDirect: false,
            IsAudioDirect: true,
            HardwareAccelerationType: "qsv",
          },
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].transcoding?.hwAccel).toBe("qsv");
    });

    it("treats 'none' hardware acceleration as software", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess-sw",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "i", Name: "Movie", Type: "Movie" },
          PlayState: { IsPaused: false, CanSeek: true },
          TranscodingInfo: {
            IsVideoDirect: false,
            IsAudioDirect: true,
            HardwareAccelerationType: "none",
          },
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].transcoding?.hwAccel).toBeUndefined();
    });

    it("leaves the resolution undefined when the item carries no video stream", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess2",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "item2", Name: "Track", Type: "Audio" },
          PlayState: { IsPaused: false, CanSeek: true },
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].mediaWidth).toBeUndefined();
      expect(sessions[0].mediaHeight).toBeUndefined();
    });
  });

  describe("terminateSession", () => {
    function axiosClient() {
      new JellyfinClient("http://jellyfin:8096", "jf-token");
      return mockAxiosCreate.mock.results[0].value as { post: ReturnType<typeof vi.fn> };
    }

    // Stopping playback carries no reason on Jellyfin/Emby, so the configured
    // message has to be pushed separately or the user never sees it.
    it("shows the reason to the client before stopping playback", async () => {
      const post = axiosClient().post;
      post.mockResolvedValue({ data: {} });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      await client.terminateSession("sess1", "Server is in maintenance mode.");

      expect(post).toHaveBeenNthCalledWith(1, "/Sessions/sess1/Message", {
        Header: "Playback stopped",
        Text: "Server is in maintenance mode.",
        TimeoutMs: 15000,
      });
      expect(post).toHaveBeenNthCalledWith(2, "/Sessions/sess1/Playing/Stop");
    });

    it("still stops playback when the client cannot display a message", async () => {
      const post = axiosClient().post;
      post.mockRejectedValueOnce(new Error("client does not support messages"));
      post.mockResolvedValue({ data: {} });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      await client.terminateSession("sess1", "Bye");

      expect(post).toHaveBeenLastCalledWith("/Sessions/sess1/Playing/Stop");
    });

    it("skips the message when no reason is given", async () => {
      const post = axiosClient().post;
      post.mockResolvedValue({ data: {} });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      await client.terminateSession("sess1", "");

      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith("/Sessions/sess1/Playing/Stop");
    });
  });
});
