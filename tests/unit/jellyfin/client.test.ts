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

  describe("fetchImage", () => {
    function newClient() {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockResolvedValue({
        data: Buffer.from("image-data"),
        headers: { "content-type": "image/jpeg" },
      });
      return { client, axiosClient };
    }

    it("requests the bare image path when no width is given", async () => {
      const { client, axiosClient } = newClient();
      await client.fetchImage("/Items/abc/Images/Primary");
      expect(axiosClient.get.mock.calls[0][0]).toBe("/Items/abc/Images/Primary");
    });

    it("asks the server to resize when a width is given", async () => {
      // maxWidth only ever shrinks, so a source narrower than the hint comes
      // back untouched — exactly what the local withoutEnlargement resize wants.
      const { client, axiosClient } = newClient();
      await client.fetchImage("/Items/abc/Images/Primary", { width: 400 });
      expect(axiosClient.get.mock.calls[0][0]).toBe("/Items/abc/Images/Primary?maxWidth=400");
    });

    it("appends to a path that already carries a query string", async () => {
      const { client, axiosClient } = newClient();
      await client.fetchImage("/Items/abc/Images/Primary?tag=xyz", { width: 640 });
      expect(axiosClient.get.mock.calls[0][0]).toBe("/Items/abc/Images/Primary?tag=xyz&maxWidth=640");
    });

    it("still normalises a bare item id into an image path", async () => {
      const { client, axiosClient } = newClient();
      await client.fetchImage("abc", { width: 400 });
      expect(axiosClient.get.mock.calls[0][0]).toBe("/Items/abc/Images/Primary?maxWidth=400");
    });
  });

  describe("getSessions", () => {
    function makeClientWithSessions(sessions: unknown[]) {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockResolvedValue({ data: sessions });
      return client;
    }

    // The shape a real server returns: SessionManager strips MediaSources and
    // MediaStreams from NowPlayingItem, leaving Width/Height as the only
    // source dimensions available. Reading the stripped fields left every
    // session looking sub-4K, so the "4K Transcoding" criterion never fired.
    it("reports the source resolution from the item's own Width/Height", async () => {
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
            Width: 3840,
            Height: 2160,
            // No MediaSources — the server does not send them here.
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

    it("falls back to the media stream dimensions when a server does send them", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess1b",
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
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].mediaWidth).toBe(3840);
      expect(sessions[0].mediaHeight).toBe(2160);
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

    // HardwareAccelerationType is the server's CONFIGURED accel (reported even
    // when a job falls back to software), so it is not a per-job HW signal and
    // is intentionally not captured. HW detection is Plex-only.
    it("does not populate per-job HW fields from Jellyfin", async () => {
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

      expect(sessions[0].transcoding?.hwEncode).toBeUndefined();
      expect(sessions[0].transcoding?.hwDecode).toBeUndefined();
      // No fabricated speed either — Jellyfin reports none.
      expect(sessions[0].transcoding?.speed).toBeUndefined();
    });

    it("does not report an audio-only (music) transcode as a video transcode", async () => {
      // Jellyfin sets IsVideoDirect=false for a music transcode (there is no
      // video), which must NOT surface as videoDecision "transcode" or the
      // "Video Transcoding" criterion would kill music streams.
      const client = makeClientWithSessions([
        {
          Id: "sess-music",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "trk", Name: "Song", Type: "Audio" },
          PlayState: { IsPaused: false, CanSeek: true },
          TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: false },
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].type).toBe("track");
      expect(sessions[0].transcoding?.videoDecision).toBe("copy");
      expect(sessions[0].transcoding?.audioDecision).toBe("transcode");
    });

    it("still reports a real video transcode as a video transcode", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess-vid",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: { Id: "m", Name: "Movie", Type: "Movie" },
          PlayState: { IsPaused: false, CanSeek: true },
          TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true },
        },
      ]);

      const sessions = await client.getSessions();

      expect(sessions[0].transcoding?.videoDecision).toBe("transcode");
      expect(sessions[0].transcoding?.audioDecision).toBe("copy");
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

  describe("notifySession", () => {
    it("posts a client message WITHOUT stopping playback", async () => {
      new JellyfinClient("http://jellyfin:8096", "jf-token");
      const post = (mockAxiosCreate.mock.results[0].value as { post: ReturnType<typeof vi.fn> }).post;
      post.mockResolvedValue({ data: {} });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      await client.notifySession("sess1", "Your stream will end soon");

      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith("/Sessions/sess1/Message", {
        Header: "Notice",
        Text: "Your stream will end soon",
        TimeoutMs: 60000,
      });
      // No Playing/Stop — this only warns.
      expect(post).not.toHaveBeenCalledWith("/Sessions/sess1/Playing/Stop");
    });
  });

  describe("listUsernames", () => {
    it("returns non-empty names from /Users", async () => {
      new JellyfinClient("http://jellyfin:8096", "jf-token");
      const get = (mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> }).get;
      get.mockResolvedValue({ data: [{ Name: "alice" }, { Name: "" }, { Name: "bob" }, {}] });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      const names = await client.listUsernames();

      expect(get).toHaveBeenCalledWith("/Users");
      expect(names).toEqual(["alice", "bob"]);
    });
  });

  describe("resolveLibraryKey", () => {
    function newClient(ancestors: unknown) {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockImplementation(async (url: string) => {
        if (url === "/Users/Me") return { data: { Id: "u-admin" } };
        if (url.endsWith("/Ancestors")) return { data: ancestors };
        throw new Error(`unexpected ${url}`);
      });
      return { client, axiosClient };
    }

    it("returns the id of the CollectionFolder ancestor — the library's VirtualFolders ItemId", async () => {
      // Jellyfin items carry no library section, so the incremental sync had no
      // way to place a new item and escalated every add to a full sync.
      const { client, axiosClient } = newClient([
        { Id: "season-1", Type: "Season" },
        { Id: "series-1", Type: "Series" },
        { Id: "lib-tv", Type: "CollectionFolder" },
        { Id: "root", Type: "AggregateFolder" },
      ]);
      await expect(client.resolveLibraryKey("ep-1")).resolves.toBe("lib-tv");
      expect(axiosClient.get).toHaveBeenCalledWith("/Items/ep-1/Ancestors", { params: { UserId: "u-admin" } });
    });

    it("returns null when no ancestor is a library", async () => {
      const { client } = newClient([{ Id: "root", Type: "AggregateFolder" }]);
      await expect(client.resolveLibraryKey("x")).resolves.toBeNull();
    });

    it("returns null for an unexpected response shape", async () => {
      const { client } = newClient({ not: "an array" });
      await expect(client.resolveLibraryKey("x")).resolves.toBeNull();
    });
  });

  describe("getDetailedWatchHistory", () => {
    const USERS = [{ Id: "u1", Name: "Alice" }, { Id: "u2", Name: "Bob" }];
    const played = (id: string) => ({
      data: { Items: [{ Id: id, UserData: { PlayCount: 1, LastPlayedDate: "2024-01-02T00:00:00.000Z" } }] },
    });

    function newClient(perUser: Record<string, () => Promise<unknown>>) {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockImplementation(async (url: string) => {
        if (url === "/Users") return { data: USERS };
        const m = url.match(/^\/Users\/(.+)\/Items$/);
        if (m && perUser[m[1]]) return perUser[m[1]]();
        throw new Error(`unexpected ${url}`);
      });
      return { client, axiosClient };
    }

    it("asks only for the item types a library stores", async () => {
      const { client, axiosClient } = newClient({ u1: async () => played("m1"), u2: async () => played("m2") });
      await client.getDetailedWatchHistory();
      const params = axiosClient.get.mock.calls.find((c) => c[0] === "/Users/u1/Items")?.[1]?.params;
      expect(params?.IncludeItemTypes).toBe("Movie,Episode,Audio");
      expect(params?.IsPlayed).toBe(true);
    });

    it("rethrows a transient per-user failure so the caller keeps its stored history", async () => {
      // Swallowing it handed the caller a PARTIAL history that the native
      // watch-history sync then committed with a destructive full replace,
      // deleting every play this user's pages never delivered.
      const { client } = newClient({
        u1: async () => played("m1"),
        u2: async () => { throw new Error("socket hang up"); },
      });
      await expect(client.getDetailedWatchHistory()).rejects.toThrow("socket hang up");
    });

    it("skips a user the key cannot read (403) and keeps the others", async () => {
      // A permanent condition: failing the whole scan for it would block every
      // history sync on the server.
      const { default: axios } = await import("axios");
      vi.mocked(axios.isAxiosError).mockImplementation(
        (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
      );
      const { client } = newClient({
        u1: async () => played("m1"),
        u2: async () => { throw Object.assign(new Error("forbidden"), { isAxiosError: true, response: { status: 403 } }); },
      });
      const { logger } = await import("@/lib/logger");

      const entries = await client.getDetailedWatchHistory();

      expect(entries.map((e) => e.username)).toEqual(["Alice"]);
      expect(logger.warn).toHaveBeenCalledWith("Jellyfin", expect.stringContaining('user "Bob" (HTTP 403)'));
      vi.mocked(axios.isAxiosError).mockImplementation(() => false);
    });
  });
});
