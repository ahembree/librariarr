import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type { DetailedWatchHistoryReport } from "@/lib/media-server/types";

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

    it("carries an episode's season and episode numbers, so it can be named by show and SxxExx", async () => {
      const client = makeClientWithSessions([
        {
          Id: "sess-ep",
          UserId: "u1",
          UserName: "bob",
          Client: "Jellyfin Web",
          DeviceName: "Chrome",
          NowPlayingItem: {
            Id: "ep1",
            Name: "Pilot",
            Type: "Episode",
            SeriesName: "Breaking Bad",
            SeasonName: "Season 1",
            ParentIndexNumber: 1,
            IndexNumber: 1,
          },
          PlayState: { IsPaused: false, CanSeek: true },
        },
      ]);

      const [session] = await client.getSessions();

      expect(session).toMatchObject({
        type: "episode",
        title: "Pilot",
        grandparentTitle: "Breaking Bad",
        seasonNumber: 1,
        episodeNumber: 1,
      });
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

    // These requests carry the admin token. A raw `../System/Shutdown?x=` would
    // resolve to POST /System/Shutdown once the URL parser removes the `..`.
    it("keeps a hostile session id inside one path segment", async () => {
      const post = axiosClient().post;
      post.mockResolvedValue({ data: {} });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      await client.terminateSession("../System/Shutdown?x=", "Bye");

      const paths = post.mock.calls.map(([path]) => path as string);
      expect(paths).toEqual([
        "/Sessions/..%2FSystem%2FShutdown%3Fx%3D/Message",
        "/Sessions/..%2FSystem%2FShutdown%3Fx%3D/Playing/Stop",
      ]);
      for (const path of paths) {
        const resolved = new URL(path, "http://jellyfin:8096");
        expect(resolved.pathname.startsWith("/Sessions/")).toBe(true);
        expect(resolved.search).toBe("");
      }
    });

    it.each(["..", ".", ""])("refuses the dot segment or empty id %j without calling the server", async (id) => {
      const post = axiosClient().post;
      post.mockResolvedValue({ data: {} });
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");

      await expect(client.terminateSession(id, "")).rejects.toThrow("Invalid session id");
      expect(post).not.toHaveBeenCalled();
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

  describe("music MusicBrainz ids", () => {
    it("maps a track's own and its album artist's MusicBrainz ids", async () => {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockImplementation(async (url: string) => {
        if (url === "/Users/Me") return { data: { Id: "u-admin" } };
        return {
          data: {
            Id: "track-1", Name: "Song", Type: "Audio", AlbumArtist: "Artist",
            ProviderIds: {
              MusicBrainzTrack: "1a2b3c4d-1111-2222-3333-444455556666",
              MusicBrainzAlbumArtist: "0383dadf-2a4e-4d10-a46a-e9e041da8eb3",
              MusicBrainzArtist: "99999999-9999-9999-9999-999999999999",
            },
          },
        };
      });
      const item = await client.getItemMetadata("track-1");
      expect(item.Guid).toEqual(expect.arrayContaining([
        { id: "mbid://1a2b3c4d-1111-2222-3333-444455556666" },
        { id: "musicbrainz://0383dadf-2a4e-4d10-a46a-e9e041da8eb3" },
      ]));
      expect(item.Guid).not.toContainEqual({ id: "musicbrainz://99999999-9999-9999-9999-999999999999" });
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

    it("throws on a /Users body that is not a list, while an empty list reads as no plays", async () => {
      // An HTML page from a proxy read as "no users, no plays", and the full replace deleted every play.
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockImplementation(async () => ({ data: "<html>Sign in</html>" }));
      await expect(client.getDetailedWatchHistory()).rejects.toThrow(/malformed \/Users/);
      axiosClient.get.mockImplementation(async () => ({ data: [] }));
      await expect(client.getDetailedWatchHistory()).resolves.toEqual([]);
    });

    /** A user's played items served `cap` at a time out of `total`, whatever Limit asked. */
    function cappedPages(total: number, cap: number, reportTotal: boolean) {
      return (params: { StartIndex: number }) => {
        const items = Array.from(
          { length: Math.max(0, Math.min(cap, total - params.StartIndex)) },
          (_, i) => ({ Id: `m${params.StartIndex + i}`, UserData: { PlayCount: 1 } }),
        );
        return { data: { Items: items, ...(reportTotal ? { TotalRecordCount: total } : {}) } };
      };
    }

    function pagedClient(page: (params: { StartIndex: number }) => unknown) {
      const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
      const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
      axiosClient.get.mockImplementation(async (url: string, config?: { params: { StartIndex: number } }) => {
        if (url === "/Users") return { data: [{ Id: "u1", Name: "Alice" }] };
        return page(config!.params);
      });
      const itemCalls = () => axiosClient.get.mock.calls.filter((c) => c[0] === "/Users/u1/Items");
      return { client, itemCalls };
    }

    it("keeps paging past a short page while TotalRecordCount says more remain", async () => {
      // A server or proxy capping the page below the 1,000 asked for must not truncate the history.
      const { client, itemCalls } = pagedClient(cappedPages(250, 100, true));
      await expect(client.getDetailedWatchHistory()).resolves.toHaveLength(250);
      // Advanced by what was actually returned, not by the size asked for.
      expect(itemCalls().map((c) => c[1].params.StartIndex)).toEqual([0, 100, 200]);
    });

    it("stops on a short page when the server reports no total", async () => {
      const { client, itemCalls } = pagedClient(cappedPages(250, 100, false));
      await expect(client.getDetailedWatchHistory()).resolves.toHaveLength(100);
      expect(itemCalls()).toHaveLength(1);
    });

    // Servers over-report the total a little, but a proxy answering `Items: []` looks the same: an
    // empty page short of it ends the walk (with a WARN) only after some items and within max(50, 2%).
    it.each([
      [230, 250, true],
      [9_800, 10_000, true],
      [9_799, 10_000, false],
      [100, 250, false],
      [0, 3, false],
      [0, 5_000, false],
    ])("an empty page after %i of a reported %i items ends the walk: %s", async (delivered, total, ends) => {
      const { client, itemCalls } = pagedClient((params) =>
        params.StartIndex >= delivered
          ? { data: { Items: [], TotalRecordCount: total } }
          : { data: { ...cappedPages(delivered, 100, false)(params).data, TotalRecordCount: total } },
      );
      const { logger } = await import("@/lib/logger");
      const message = `ended at ${delivered} of a reported ${total}`;
      if (ends) {
        await expect(client.getDetailedWatchHistory()).resolves.toHaveLength(delivered);
        expect(itemCalls()).toHaveLength(Math.ceil(delivered / 100) + 1);
        expect(logger.warn).toHaveBeenCalledWith("Jellyfin", expect.stringContaining(message));
      } else {
        await expect(client.getDetailedWatchHistory()).rejects.toThrow(message);
        expect(logger.warn).not.toHaveBeenCalledWith("Jellyfin", expect.stringContaining("over-reported"));
      }
    });

    describe("a later page that omits the total an earlier one reported", () => {
      // It is read against the earlier total, not as "no total" (which ends the walk unchecked).
      it("judges an empty page by the earlier total, so a truncated listing still throws", async () => {
        const { client } = pagedClient((params) =>
          params.StartIndex === 0 ? cappedPages(1000, 100, true)(params) : { data: { Items: [] } },
        );
        await expect(client.getDetailedWatchHistory()).rejects.toThrow(/ended at 100 of a reported 1000/);
      });

      it("keeps paging past a short page that omits the total until the earlier total is reached", async () => {
        const { client, itemCalls } = pagedClient((params) => cappedPages(250, 100, params.StartIndex === 0)(params));
        await expect(client.getDetailedWatchHistory()).resolves.toHaveLength(250);
        expect(itemCalls()).toHaveLength(3);
      });
    });

    it.each([
      ["a zero total", { Items: [], TotalRecordCount: 0 }],
      ["no total", { Items: [] }],
    ])("still reads an empty first page with %s as a user with no plays", async (_label, body) => {
      const { client } = pagedClient(() => ({ data: body }));
      await expect(client.getDetailedWatchHistory()).resolves.toEqual([]);
    });

    it.each([true, false])("throws instead of looping when the server ignores StartIndex (total reported: %s)", async (reportTotal) => {
      const { client, itemCalls } = pagedClient(() => cappedPages(5000, 1000, reportTotal)({ StartIndex: 0 }));
      await expect(client.getDetailedWatchHistory()).rejects.toThrow(/ignored StartIndex/);
      expect(itemCalls()).toHaveLength(2);
    });

    it("hands on an item once when a change mid-walk shifts it onto the next page", async () => {
      // Delivered twice, its undated play entries were stored twice (`playCount` is monotonic).
      const item = (id: string, plays: number) => ({
        Id: id,
        UserData: { PlayCount: plays, LastPlayedDate: "2024-01-02T00:00:00.000Z" },
      });
      const { client } = pagedClient((params) =>
        params.StartIndex === 0
          ? { data: { Items: [item("a", 1), item("b", 3)], TotalRecordCount: 4 } }
          : { data: { Items: [item("b", 3), item("c", 1)], TotalRecordCount: 4 } },
      );

      const entries = await client.getDetailedWatchHistory();

      expect(entries.map((e) => e.ratingKey).sort()).toEqual(["a", "b", "b", "b", "c"]);
    });

    it("passes over a short last page that only repeats an item pushed down", async () => {
      const item = (id: string) => ({ Id: id, UserData: { PlayCount: 1 } });
      const { client, itemCalls } = pagedClient((params) => ({
        data: { Items: params.StartIndex === 0 ? [item("a"), item("b")] : [item("b")], TotalRecordCount: 3 },
      }));
      expect((await client.getDetailedWatchHistory()).map((e) => e.ratingKey)).toEqual(["a", "b"]);
      expect(itemCalls()).toHaveLength(2);
    });

    it("asks for a stable order so the pages do not reshuffle between requests", async () => {
      const { client, itemCalls } = pagedClient(cappedPages(3, 100, true));
      await client.getDetailedWatchHistory();
      expect(itemCalls()[0][1].params).toMatchObject({ SortBy: "DateCreated,SortName", SortOrder: "Ascending" });
    });

    describe("users whose listing cannot be read completely", () => {
      // With a report such a user is set aside, with why, and the caller keeps their stored rows;
      // without one a refused user is skipped and an unreliable listing fails the fetch.
      const refused = (status: number) => () => {
        throw Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });
      };
      const newReport = (): DetailedWatchHistoryReport => ({ incompleteUsers: new Map(), devicesUnavailable: false });
      const item = (id: string) => ({
        Id: id,
        UserData: { PlayCount: 1, LastPlayedDate: "2024-01-02T00:00:00.000Z" },
      });
      const firstHundred = Array.from({ length: 100 }, (_, i) => item(`b${i}`));
      beforeEach(async () => {
        const { default: axios } = await import("axios");
        vi.mocked(axios.isAxiosError).mockImplementation(
          (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
        );
      });
      afterEach(async () => {
        const { default: axios } = await import("axios");
        vi.mocked(axios.isAxiosError).mockImplementation(() => false);
      });

      /** Alice reads cleanly; Bob answers with `bob`. */
      function aliceAndBob(bob: (params: { StartIndex: number }) => unknown) {
        const client = new JellyfinClient("http://jellyfin:8096", "jf-token");
        const axiosClient = mockAxiosCreate.mock.results[0].value as { get: ReturnType<typeof vi.fn> };
        axiosClient.get.mockImplementation(async (url: string, config?: { params: { StartIndex: number } }) => {
          if (url === "/Users") return { data: USERS };
          if (url === "/Users/u1/Items") return { data: { Items: [item("a1"), item("a2")], TotalRecordCount: 2 } };
          if (url === "/Users/u2/Items") return bob(config!.params);
          throw new Error(`unexpected ${url}`);
        });
        return client;
      }

      it.each<[string, (params: { StartIndex: number }) => unknown]>([
        ["an empty first page under a non-zero total", () => ({ data: { Items: [], TotalRecordCount: 5 } })],
        [
          "an empty page far short of the total mid-list",
          (params) => ({ data: { Items: params.StartIndex === 0 ? firstHundred : [], TotalRecordCount: 1000 } }),
        ],
      ])("sets aside a user whose listing is %s given a report, and fails the fetch without one", async (_label, bob) => {
        const { logger } = await import("@/lib/logger");
        const report = newReport();

        const entries = await aliceAndBob(bob).getDetailedWatchHistory({ report });

        // None of the pages Bob did deliver: the caller would store them on top of the rows it keeps.
        expect(entries.map((e) => [e.username, e.ratingKey])).toEqual([
          ["Alice", "a1"],
          ["Alice", "a2"],
        ]);
        // Unreliable: by the server's own count Bob has plays this run did not see.
        expect([...report.incompleteUsers]).toEqual([["Bob", "unreliable"]]);
        expect(report.devicesUnavailable).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith("Jellyfin", expect.stringContaining('complete watch history of user "Bob"'));
        // Without a report nothing would keep his stored rows from the full replace.
        await expect(aliceAndBob(bob).getDetailedWatchHistory()).rejects.toThrow(/played-items listing ended at/);
      });

      it("fails the fetch on pages that ignore StartIndex, report or not", async () => {
        // A server or proxy fault, not one user's: setting aside every user with more than one page
        // handed the caller the history of the single-page users only.
        const ignoresStartIndex = () => ({ data: { Items: firstHundred, TotalRecordCount: 5000 } });
        const report = newReport();
        await expect(aliceAndBob(ignoresStartIndex).getDetailedWatchHistory({ report })).rejects.toThrow(
          /ignored StartIndex/,
        );
        expect(report.incompleteUsers.size).toBe(0);
        await expect(aliceAndBob(ignoresStartIndex).getDetailedWatchHistory()).rejects.toThrow(/ignored StartIndex/);
      });

      it.each([401, 403, 404])("sets aside a user refused with HTTP %i given a report, and skips them without one", async (status) => {
        const report = newReport();
        const entries = await aliceAndBob(refused(status)).getDetailedWatchHistory({ report });
        expect(entries.map((e) => e.username)).toEqual(["Alice", "Alice"]);
        // Refused, which unlike unreliable never holds the history back.
        expect([...report.incompleteUsers]).toEqual([["Bob", "refused"]]);

        const withoutReport = await aliceAndBob(refused(status)).getDetailedWatchHistory();
        expect(withoutReport.map((e) => e.username)).toEqual(["Alice", "Alice"]);
      });

      it.each<[string, (params: { StartIndex: number }) => unknown, string | RegExp]>([
        ["a transient failure (a 5xx)", refused(503), "HTTP 503"],
        ["a dropped connection", () => { throw new Error("socket hang up"); }, "socket hang up"],
        ["a malformed page", () => ({ data: { TotalRecordCount: 5 } }), /no Items list/],
        // A fresh item on every page under a total never reached: only the page cap ends it.
        [
          "the runaway-page backstop",
          (params) => ({ data: { Items: [item(`x${params.StartIndex}`)], TotalRecordCount: 1e9 } }),
          /did not end after 10000 pages/,
        ],
      ])("still propagates %s even with a report", async (_label, bob, error) => {
        await expect(aliceAndBob(bob).getDetailedWatchHistory({ report: newReport() })).rejects.toThrow(error);
      });

      const unreliable = async () => ({ data: { Items: [], TotalRecordCount: 9 } });
      it.each([
        { label: "refused, with no report", report: undefined, u1: refused(403), u2: refused(404) },
        { label: "unreliable, with a report", report: newReport(), u1: unreliable, u2: unreliable },
      ])("fails the fetch when every user is $label, rather than reporting no plays", async ({ report, u1, u2 }) => {
        // An empty answer let the full replace delete every play and mark the history established.
        const { client } = newClient({ u1, u2 });
        await expect(client.getDetailedWatchHistory({ report })).rejects.toThrow(/all 2 user/);
      });

      it("counts a user with no plays as read", async () => {
        const { client } = newClient({
          u1: refused(403),
          u2: async () => ({ data: { Items: [], TotalRecordCount: 0 } }),
        });
        await expect(client.getDetailedWatchHistory()).resolves.toEqual([]);
      });
    });
  });
});
