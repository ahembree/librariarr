import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Drives JellyfinCompatClient (through JellyfinClient/EmbyClient) against a
// local HTTP server so the real axios interceptor chain — breaker, auth
// headers, error logging — runs alongside the normalisation and paging logic.

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { JellyfinClient } from "@/lib/jellyfin/client";
import { EmbyClient } from "@/lib/emby/client";
import { logger } from "@/lib/logger";
import {
  _resetForTesting,
  markUnreachable,
  isUnreachable,
} from "@/lib/media-server/health-cache";

type Handler = (
  req: http.IncomingMessage,
  url: URL,
) => { status?: number; body?: unknown; raw?: string; contentType?: string } | undefined;

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server | null = null;
let requests: Recorded[] = [];

async function serve(handler: Handler): Promise<string> {
  requests = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const out = handler(req, url) ?? { status: 404, body: { message: "not found" } };
      res.writeHead(out.status ?? 200, { "Content-Type": out.contentType ?? "application/json" });
      res.end(out.raw ?? JSON.stringify(out.body ?? null));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  _resetForTesting();
  vi.clearAllMocks();
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** /Users/Me answers with an id so getUserId resolves immediately. */
function withMe(handler: Handler): Handler {
  return (req, url) => {
    if (url.pathname === "/Users/Me") return { body: { Id: "me-1" } };
    return handler(req, url);
  };
}

describe("testConnection", () => {
  it("returns the server name when both probes succeed", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/System/Info/Public") return { body: { ServerName: "Den" } };
      if (u.pathname === "/System/Info") return { body: { Id: "x" } };
      return undefined;
    });
    const result = await new JellyfinClient(url, "t").testConnection();
    expect(result).toEqual({ ok: true, serverName: "Den" });
  });

  it("asks the server even while it is marked unreachable (bypasses the breaker)", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/System/Info/Public") return { body: { ServerName: "Den" } };
      if (u.pathname === "/System/Info") return { body: {} };
      return undefined;
    });
    markUnreachable(url, new Error("earlier"));
    const result = await new JellyfinClient(url, "t").testConnection();
    expect(result).toEqual({ ok: true, serverName: "Den" });
    expect(requests.map((r) => r.path)).toEqual(["/System/Info/Public", "/System/Info"]);
    // A success clears the breaker.
    expect(isUnreachable(url)).toBe(false);
  });

  it("refuses a server that is not Jellyfin/Emby (no ServerName)", async () => {
    const url = await serve(() => ({ body: { Version: "1" } }));
    const result = await new EmbyClient(url, "t").testConnection();
    expect(result).toEqual({ ok: false, error: "This does not appear to be a Emby server" });
  });

  it.each([
    [401, "Authentication failed — invalid API key"],
    [403, "Authorization failed — API key does not have admin privileges"],
  ])("maps a %i on the authenticated probe", async (status, error) => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/System/Info/Public") return { body: { ServerName: "Den" } };
      return { status, body: { message: "no" } };
    });
    expect(await new JellyfinClient(url, "t").testConnection()).toEqual({ ok: false, error });
  });

  it("reports the axios message for any other authenticated-probe failure", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/System/Info/Public") return { body: { ServerName: "Den" } };
      return { status: 500, raw: "boom", contentType: "text/plain" };
    });
    const result = await new JellyfinClient(url, "t").testConnection();
    expect(result).toEqual({ ok: false, error: "Request failed with status code 500" });
    // The error interceptor logs the string body as detail.
    expect(logger.debug).toHaveBeenCalledWith(
      "Jellyfin",
      expect.stringContaining("ERROR 500"),
      expect.objectContaining({ detail: "boom" }),
    );
  });

  it("maps a 401 on the public probe", async () => {
    const url = await serve(() => ({ status: 401, body: { Message: "denied" } }));
    expect(await new JellyfinClient(url, "t").testConnection()).toEqual({
      ok: false,
      error: "Authentication failed - invalid API key",
    });
    expect(logger.debug).toHaveBeenCalledWith(
      "Jellyfin",
      expect.stringContaining("ERROR 401"),
      expect.objectContaining({ detail: "denied" }),
    );
  });

  it("maps a 404 on the public probe to a server-type hint", async () => {
    const url = await serve(() => ({ status: 404, body: {} }));
    const result = await new JellyfinClient(url, "t").testConnection();
    expect(result).toEqual({
      ok: false,
      error: "This does not appear to be a Jellyfin server — check your server type selection",
    });
  });

  it("maps a refused connection", async () => {
    const url = await serve(() => undefined);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const result = await new JellyfinClient(url, "t").testConnection();
    expect(result).toEqual({ ok: false, error: "Connection refused - server may be offline" });
  });
});

describe("circuit breaker", () => {
  it("rejects a normal request without sending it while the server is marked unreachable", async () => {
    const url = await serve(() => ({ body: [] }));
    markUnreachable(url, new Error("socket hang up"));
    await expect(new JellyfinClient(url, "t").getLibraries()).rejects.toThrow(
      /is unreachable \(last error: socket hang up\)/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("getUserId (via getItemMetadata)", () => {
  it("uses /Users/Me and caches the id", async () => {
    const url = await serve(withMe((_req, u) => {
      if (u.pathname.startsWith("/Items/")) return { body: { Id: u.pathname.split("/")[2], Name: "X", Type: "Movie" } };
      return undefined;
    }));
    const client = new JellyfinClient(url, "tok");
    await client.getItemMetadata("a");
    await client.getItemMetadata("b");
    expect(requests.filter((r) => r.path === "/Users/Me")).toHaveLength(1);
    const itemReq = requests.find((r) => r.path === "/Items/b")!;
    expect(itemReq.query.get("UserId")).toBe("me-1");
    expect(itemReq.headers.authorization).toBe(
      'MediaBrowser Client="Librariarr", Device="Server", DeviceId="librariarr", Version="1.0.0", Token="tok"',
    );
  });

  it("falls back to the lowest-id administrator from /Users", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users/Me") return { status: 400, body: { title: "bad" } };
      if (u.pathname === "/Users")
        return {
          body: [
            { Id: "z", Name: "Zed", Policy: { IsAdministrator: true } },
            { Id: "b", Name: "Bee", Policy: { IsAdministrator: true } },
            { Id: "a", Name: "Ay", Policy: { IsAdministrator: false } },
          ],
        };
      if (u.pathname.startsWith("/Items/")) return { body: { Id: "i", Name: "I", Type: "Movie" } };
      return undefined;
    });
    await new JellyfinClient(url, "t").getItemMetadata("i");
    expect(requests.find((r) => r.path === "/Items/i")!.query.get("UserId")).toBe("b");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to the first user and warns when no one is an administrator", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users/Me") return { status: 400, body: {} };
      if (u.pathname === "/Users") return { body: [{ Id: "q", Name: "Q" }, { Id: "p", Name: "P" }] };
      if (u.pathname.startsWith("/Items/")) return { body: { Id: "i", Name: "I", Type: "Movie" } };
      return undefined;
    });
    await new JellyfinClient(url, "t").getItemMetadata("i");
    expect(requests.find((r) => r.path === "/Items/i")!.query.get("UserId")).toBe("p");
    expect(logger.warn).toHaveBeenCalledWith(
      "Jellyfin",
      'No administrator user found; using "P" — library/watch-history queries may be incomplete (restricted view)',
    );
  });

  it("throws when the server lists no users", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users/Me") return { status: 400, body: {} };
      if (u.pathname === "/Users") return { body: null };
      return undefined;
    });
    await expect(new JellyfinClient(url, "t").getItemMetadata("i")).rejects.toThrow(/No users found/);
  });
});

describe("getLibraries", () => {
  it("maps supported collection types and drops the rest", async () => {
    const url = await serve(() => ({
      body: [
        { ItemId: "1", Name: "Movies", CollectionType: "movies" },
        { ItemId: "2", Name: "TV", CollectionType: "tvshows" },
        { ItemId: "3", Name: "Music", CollectionType: "music" },
        { ItemId: "4", Name: "Photos", CollectionType: "homevideos" },
        { ItemId: "5", Name: "Mixed" },
      ],
    }));
    const libs = await new JellyfinClient(url, "t").getLibraries();
    expect(libs.map((l) => [l.key, l.type])).toEqual([
      ["1", "movie"],
      ["2", "show"],
      ["3", "artist"],
    ]);
    expect(libs[0]).toMatchObject({ title: "Movies", agent: "jellyfin", scanner: "jellyfin" });
  });

  it("returns an empty list for an empty body", async () => {
    const url = await serve(() => ({ body: null }));
    expect(await new JellyfinClient(url, "t").getLibraries()).toEqual([]);
  });
});

describe("bulk item listings", () => {
  function pagedItems(total: number): Handler {
    return withMe((_req, u) => {
      if (u.pathname !== "/Items") return undefined;
      const start = Number(u.searchParams.get("StartIndex"));
      const limit = Number(u.searchParams.get("Limit"));
      const count = Math.max(0, Math.min(limit, total - start));
      return {
        body: {
          Items: Array.from({ length: count }, (_, i) => ({ Id: `i${start + i}`, Name: `N${start + i}`, Type: "Movie" })),
        },
      };
    });
  }

  it("pages through a library of more than one page (500)", async () => {
    const url = await serve(pagedItems(501));
    const items = await new JellyfinClient(url, "t").getLibraryItems("sec");
    expect(items).toHaveLength(501);
    const listing = requests.filter((r) => r.path === "/Items");
    expect(listing.map((r) => r.query.get("StartIndex"))).toEqual(["0", "500"]);
    expect(listing[0].query.get("IncludeItemTypes")).toBe("Movie");
    expect(listing[0].query.get("ParentId")).toBe("sec");
  });

  it.each([
    ["getLibraryShows", "Series"],
    ["getLibraryEpisodes", "Episode"],
    ["getLibraryTracks", "Audio"],
  ] as const)("%s asks for %s items", async (method, type) => {
    const url = await serve(pagedItems(2));
    const items = await new JellyfinClient(url, "t")[method]("sec");
    expect(items).toHaveLength(2);
    expect(requests.find((r) => r.path === "/Items")!.query.get("IncludeItemTypes")).toBe(type);
  });

  it("treats a page without Items as empty", async () => {
    const url = await serve(withMe(() => ({ body: {} })));
    expect(await new JellyfinClient(url, "t").getLibraryItems("sec")).toEqual([]);
  });

  it.each([
    ["movie", "Movie"],
    ["episode", "Episode"],
    ["track", "Audio"],
  ] as const)("getLibraryItemsPage(%s) asks for %s and returns the total", async (type, apiType) => {
    const url = await serve(withMe(() => ({ body: { Items: [{ Id: "1", Name: "A", Type: apiType }], TotalRecordCount: 7 } })));
    const page = await new JellyfinClient(url, "t").getLibraryItemsPage("sec", type, 10, 5);
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(1);
    const req = requests.find((r) => r.path === "/Items")!;
    expect(req.query.get("IncludeItemTypes")).toBe(apiType);
    expect(req.query.get("StartIndex")).toBe("10");
    expect(req.query.get("Limit")).toBe("5");
  });

  it("getLibraryItemsPage reports a null total when the server omits it", async () => {
    const url = await serve(withMe(() => ({ body: {} })));
    const page = await new JellyfinClient(url, "t").getLibraryItemsPage("sec", "movie", 0, 5);
    expect(page).toEqual({ items: [], total: null });
  });
});

describe("getWatchHistory (Jellyfin)", () => {
  it("emits one entry per play, dated first play newest, undated last; skips users it cannot read", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: [{ Id: "u1", Name: "Ann" }, { Id: "u2", Name: "Bob" }, { Id: "u3", Name: "Cy" }, { Id: "u4", Name: "Di" }] };
      if (u.pathname === "/Items/rk") {
        const uid = u.searchParams.get("UserId");
        if (uid === "u1") return { body: { UserData: { PlayCount: 2, LastPlayedDate: "2024-01-01T00:00:00Z" } } };
        if (uid === "u2") return { body: { UserData: { PlayCount: 1, LastPlayedDate: "2025-01-01T00:00:00Z" } } };
        if (uid === "u3") return { status: 403, body: {} };
        return { body: { UserData: { PlayCount: 0 } } };
      }
      return undefined;
    });
    const entries = await new JellyfinClient(url, "t").getWatchHistory("rk");
    expect(entries).toEqual([
      { username: "Bob", watchedAt: "2025-01-01T00:00:00.000Z" },
      { username: "Ann", watchedAt: "2024-01-01T00:00:00.000Z" },
      { username: "Ann", watchedAt: null },
    ]);
  });

  it("orders two undated plays stably", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: [{ Id: "u1", Name: "Ann" }] };
      return { body: { UserData: { PlayCount: 2 } } };
    });
    const entries = await new JellyfinClient(url, "t").getWatchHistory("rk");
    expect(entries).toEqual([
      { username: "Ann", watchedAt: null },
      { username: "Ann", watchedAt: null },
    ]);
  });

  it("returns [] when /Users fails", async () => {
    const url = await serve(() => ({ status: 401, body: {} }));
    expect(await new JellyfinClient(url, "t").getWatchHistory("rk")).toEqual([]);
  });

  it("treats an empty /Users body as no users", async () => {
    const url = await serve(() => ({ body: null }));
    expect(await new JellyfinClient(url, "t").getWatchHistory("rk")).toEqual([]);
  });
});

describe("getDetailedWatchHistory", () => {
  it("pages a user with more than 1000 played items and expands play counts", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: [{ Id: "u1", Name: "Ann" }] };
      if (u.pathname === "/Users/u1/Items") {
        const start = Number(u.searchParams.get("StartIndex"));
        if (start === 0) {
          return {
            body: {
              Items: Array.from({ length: 1000 }, (_, i) =>
                i === 0
                  ? { Id: "first", UserData: { PlayCount: 2, LastPlayedDate: "2024-05-05T00:00:00Z" } }
                  : { Id: `x${i}`, UserData: { PlayCount: 0 } },
              ),
            },
          };
        }
        return { body: { Items: [{ Id: "last", UserData: { PlayCount: 1 } }, { Id: "nodata" }] } };
      }
      return undefined;
    });
    const entries = await new JellyfinClient(url, "t").getDetailedWatchHistory();
    expect(entries).toEqual([
      { ratingKey: "first", username: "Ann", watchedAt: "2024-05-05T00:00:00.000Z", deviceName: null, platform: null },
      { ratingKey: "first", username: "Ann", watchedAt: null, deviceName: null, platform: null },
      { ratingKey: "last", username: "Ann", watchedAt: null, deviceName: null, platform: null },
    ]);
    expect(requests.filter((r) => r.path === "/Users/u1/Items").map((r) => r.query.get("StartIndex"))).toEqual(["0", "1000"]);
  });

  it("skips a user that no longer exists (404) and handles a page with no Items", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: [{ Id: "gone", Name: "Gone" }, { Id: "u2", Name: "Bo" }] };
      if (u.pathname === "/Users/gone/Items") return { status: 404, body: {} };
      if (u.pathname === "/Users/u2/Items") return { body: {} };
      return undefined;
    });
    expect(await new JellyfinClient(url, "t").getDetailedWatchHistory()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("Jellyfin", 'Skipping watch history for user "Gone" (HTTP 404)');
  });

  it("rejects once its signal fires instead of returning a partial history", async () => {
    const controller = new AbortController();
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") {
        controller.abort();
        return { body: [{ Id: "u1", Name: "Ann" }] };
      }
      return { body: { Items: [{ Id: "a", UserData: { PlayCount: 1 } }] } };
    });
    await expect(
      new JellyfinClient(url, "t").getDetailedWatchHistory({ signal: controller.signal }),
    ).rejects.toThrow();
    expect(requests.some((r) => r.path === "/Users/u1/Items")).toBe(false);
  });

  it("rethrows a failure to list users so the caller keeps stored history", async () => {
    const url = await serve(() => ({ status: 401, body: {} }));
    await expect(new JellyfinClient(url, "t").getDetailedWatchHistory()).rejects.toThrow(/401/);
  });

  it("treats an empty /Users body as no users", async () => {
    const url = await serve(() => ({ body: null }));
    expect(await new JellyfinClient(url, "t").getDetailedWatchHistory()).toEqual([]);
  });

  it("asks only for what it reads: no images, no total count", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: [{ Id: "u1", Name: "Ann" }] };
      return { body: { Items: [] } };
    });
    await new JellyfinClient(url, "t").getDetailedWatchHistory();
    const query = requests.find((r) => r.path === "/Users/u1/Items")!.query;
    expect(query.get("EnableImages")).toBe("false");
    expect(query.get("EnableTotalRecordCount")).toBe("false");
    expect(query.get("EnableUserData")).toBe("true");
    expect(query.get("IncludeItemTypes")).toBe("Movie,Episode,Audio");
  });

  it("walks a few users at once and returns their plays in the server's user order", async () => {
    const users = Array.from({ length: 6 }, (_, i) => ({ Id: `u${i}`, Name: `User ${i}` }));
    let inFlight = 0;
    let peak = 0;
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: users };
      return { body: { Items: [{ Id: `item-${u.pathname.split("/")[2]}`, UserData: { PlayCount: 1 } }] } };
    });
    // Count overlap at the server: the handler answers synchronously, so
    // measure the requests the client has outstanding instead.
    const client = new JellyfinClient(url, "t");
    const inner = (client as unknown as { client: { interceptors: { request: { use: (f: (c: unknown) => unknown) => void }; response: { use: (f: (r: unknown) => unknown) => void } } } }).client;
    inner.interceptors.request.use((config) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return config;
    });
    inner.interceptors.response.use(async (response) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return response;
    });

    const entries = await client.getDetailedWatchHistory();

    expect(entries.map((e) => e.username)).toEqual(users.map((u) => u.Name));
    expect(peak).toBeGreaterThan(1);
    // /Users itself plus at most three user walks at a time.
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("propagates a transient failure of one user even while others are being walked", async () => {
    const url = await serve((_req, u) => {
      if (u.pathname === "/Users") return { body: [{ Id: "a", Name: "A" }, { Id: "b", Name: "B" }, { Id: "c", Name: "C" }] };
      if (u.pathname === "/Users/b/Items") return { status: 500, body: { message: "boom" } };
      return { body: { Items: [{ Id: "x", UserData: { PlayCount: 1 } }] } };
    });
    // A partial history would be committed with a destructive full replace.
    await expect(new JellyfinClient(url, "t").getDetailedWatchHistory()).rejects.toThrow(/500/);
  });
});

describe("resolveLibraryKey", () => {
  it("ignores a CollectionFolder ancestor without an id", async () => {
    const url = await serve(withMe(() => ({ body: [{ Type: "CollectionFolder" }, { Type: "CollectionFolder", Id: "lib" }] })));
    expect(await new JellyfinClient(url, "t").resolveLibraryKey("ep")).toBe("lib");
    expect(requests.find((r) => r.path === "/Items/ep/Ancestors")!.query.get("UserId")).toBe("me-1");
  });
});

describe("sessions", () => {
  it("drops idle sessions and maps a paused LAN music transcode", async () => {
    const url = await serve(() => ({
      body: [
        { Id: "idle", UserId: "u", UserName: "Ann" },
        {
          Id: "s1",
          UserId: "u",
          UserName: "Ann",
          Client: "Finamp",
          DeviceName: "Phone",
          RemoteEndPoint: "192.168.1.5",
          PlayState: { IsPaused: true, PositionTicks: 50_000_000 },
          TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true },
          NowPlayingItem: {
            Id: "t1",
            Name: "Song",
            Type: "Audio",
            Album: "Album",
            AlbumArtist: "Artist",
            RunTimeTicks: 1_800_000_000,
            ImageTags: { Primary: "tag" },
          },
        },
      ],
    }));
    const sessions = await new JellyfinClient(url, "t").getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "s1",
      type: "track",
      parentTitle: "Album",
      grandparentTitle: "Artist",
      thumb: "/Items/t1/Images/Primary",
      grandparentThumb: undefined,
      duration: 180_000,
      viewOffset: 5_000,
      player: { product: "Finamp", platform: "Phone", state: "paused", local: true },
      session: { location: "lan" },
      transcoding: { videoDecision: "copy", audioDecision: "copy" },
    });
    expect(sessions[0].seasonNumber).toBeUndefined();
  });

  it("maps a remote episode with a series thumbnail and an audio transcode", async () => {
    const url = await serve(() => ({
      body: [
        {
          Id: "s2",
          UserId: "u",
          UserName: "Bo",
          TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: false },
          NowPlayingItem: {
            Id: "e1",
            Name: "Pilot",
            Type: "Episode",
            SeriesName: "Show",
            SeasonName: "Season 1",
            ParentIndexNumber: 1,
            IndexNumber: 1,
            SeriesId: "ser",
            SeriesPrimaryImageTag: "x",
          },
        },
      ],
    }));
    const [s] = await new JellyfinClient(url, "t").getSessions();
    expect(s).toMatchObject({
      type: "episode",
      title: "Pilot",
      // The show, not the season — an episode's parent is "Season 1".
      grandparentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
      grandparentThumb: "/Items/ser/Images/Primary",
      thumb: undefined,
      player: { state: "playing", address: "", local: false },
      session: { location: "wan" },
      transcoding: { videoDecision: "copy", audioDecision: "transcode" },
    });
  });

  it("returns [] for an empty sessions body", async () => {
    const url = await serve(() => ({ body: null }));
    expect(await new JellyfinClient(url, "t").getSessions()).toEqual([]);
  });

  it("propagates a failure so callers keep per-server state", async () => {
    const url = await serve(() => ({ status: 401, body: {} }));
    await expect(new JellyfinClient(url, "t").getSessions()).rejects.toThrow("Request failed with status code 401");
    expect(logger.debug).toHaveBeenCalledWith("Jellyfin", "Failed to fetch sessions", {
      error: "AxiosError: Request failed with status code 401",
    });
  });

  it.each(["", ".", ".."])("refuses the dot-segment session id %j before sending anything", async (id) => {
    const url = await serve(() => ({ status: 204 }));
    await expect(new JellyfinClient(url, "t").terminateSession(id)).rejects.toThrow(/Invalid session id/);
    await expect(new JellyfinClient(url, "t").notifySession(id, "hi")).rejects.toThrow(/Invalid session id/);
    expect(requests).toHaveLength(0);
  });

  it("sends the termination message then stops playback", async () => {
    const url = await serve(() => ({ status: 204, raw: "" }));
    await new EmbyClient(url, "emby-tok").terminateSession("abc", "Bye");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /Sessions/abc/Message",
      "POST /Sessions/abc/Playing/Stop",
    ]);
    expect(JSON.parse(requests[0].body)).toEqual({ Header: "Playback stopped", Text: "Bye", TimeoutMs: 15000 });
    expect(requests[0].headers["x-emby-token"]).toBe("emby-tok");
  });
});

describe("listUsernames", () => {
  it("returns [] for an empty body", async () => {
    const url = await serve(() => ({ body: null }));
    expect(await new JellyfinClient(url, "t").listUsernames()).toEqual([]);
  });
});

describe("getImageUrl", () => {
  it("appends the api key to a path, with ? or &", () => {
    const c = new JellyfinClient("http://jf:8096/", "k");
    expect(c.getImageUrl("/Items/1/Images/Primary")).toBe("http://jf:8096/Items/1/Images/Primary?api_key=k");
    expect(c.getImageUrl("/Items/1/Images/Primary?tag=x")).toBe("http://jf:8096/Items/1/Images/Primary?tag=x&api_key=k");
  });

  it("expands a bare item id to its primary image", () => {
    expect(new JellyfinClient("http://jf:8096", "k").getImageUrl("abc")).toBe(
      "http://jf:8096/Items/abc/Images/Primary?api_key=k",
    );
  });
});

describe("fetchImage", () => {
  it("defaults the content type when the server sends none usable", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const img = await new JellyfinClient(`http://127.0.0.1:${port}`, "t").fetchImage("/Items/1/Images/Primary", { width: 0 });
    expect(img.contentType).toBe("image/jpeg");
    expect([...img.data]).toEqual([1, 2, 3]);
  });
});

describe("item normalisation (getItemMetadata)", () => {
  async function metadata(item: unknown) {
    const url = await serve(withMe(() => ({ body: item })));
    return new JellyfinClient(url, "t").getItemMetadata("x");
  }

  it("maps a fully populated movie, its people, sources and Dolby Vision stream", async () => {
    const m = await metadata({
      Id: "m1",
      Name: "Film",
      Type: "Movie",
      ProductionYear: 2020,
      Overview: "Plot",
      Tagline: "Tag",
      Studios: [{ Name: "Studio" }],
      OfficialRating: "PG",
      CommunityRating: 7.5,
      CriticRating: 85,
      RunTimeTicks: 72_000_000_000,
      PremiereDate: "2020-03-04T00:00:00Z",
      DateCreated: "2021-01-01T00:00:00Z",
      SortName: "film",
      // Mixed key casing on purpose: the lookup is case-insensitive.
      ProviderIds: { Tmdb: "550", TVDB: "290", imdb: "tt0137523" },
      Genres: ["Drama"],
      ImageTags: { Primary: "p" },
      UserData: { PlayCount: 3, LastPlayedDate: "not a date", IsFavorite: true },
      People: [
        { Name: "Actor", Type: "Actor", Role: "Lead", Id: "pa", PrimaryImageTag: "t" },
        { Name: "Extra", Type: "Actor" },
        { Name: "Dir", Type: "Director" },
        { Name: "Wri", Type: "Writer" },
        { Name: "Prod", Type: "Producer" },
      ],
      MediaSources: [
        {
          Path: "/m/film.mkv",
          Size: 58_412_633_211,
          Container: "mkv",
          RunTimeTicks: 72_000_000_000,
          Bitrate: 20_000_000,
          MediaStreams: [
            {
              Index: 0,
              Type: "Video",
              Codec: "hevc",
              Profile: "Main 10",
              Width: 3840,
              Height: 2160,
              BitRate: 18_000_000,
              AverageFrameRate: 23.976,
              DvProfile: 8,
              DvLevel: 6,
              DvVersionMajor: 1,
              RpuPresentFlag: 1,
              BlPresentFlag: 1,
              ElPresentFlag: 0,
              IsAnamorphic: true,
              IsInterlaced: false,
              Hdr10PlusPresentFlag: true,
            },
            { Index: 1, Type: "Audio", Codec: "truehd", Channels: 8, AudioSpatialFormat: "DolbyAtmos" },
            { Index: 2, Type: "Audio", Codec: "aac", AudioSpatialFormat: "None", IsInterlaced: false },
            { Index: 3, Type: "Subtitle", Codec: "srt", IsForced: true },
            { Index: 4, Type: "EmbeddedImage" },
          ],
        },
      ],
    });

    expect(m).toMatchObject({
      ratingKey: "m1",
      key: "/Items/m1",
      type: "movie",
      year: 2020,
      studio: "Studio",
      audienceRating: 8.5,
      duration: 7_200_000,
      originallyAvailableAt: "2020-03-04",
      addedAt: Math.floor(Date.parse("2021-01-01T00:00:00Z") / 1000),
      viewCount: 3,
      lastViewedAt: undefined,
      isWatchlisted: true,
      thumb: "/Items/m1/Images/Primary",
      art: "/Items/m1/Images/Backdrop",
      titleSort: "film",
      Genre: [{ tag: "Drama" }],
      Director: [{ tag: "Dir" }],
      Writer: [{ tag: "Wri" }],
      Guid: [{ id: "tmdb://550" }, { id: "tvdb://290" }, { id: "imdb://tt0137523" }],
    });
    expect(m.Role).toEqual([
      { tag: "Actor", role: "Lead", thumb: "/Items/pa/Images/Primary" },
      { tag: "Extra", role: "", thumb: undefined },
    ]);

    const media = m.Media![0];
    expect(media).toMatchObject({
      bitrate: 20_000,
      width: 3840,
      height: 2160,
      videoCodec: "hevc",
      videoProfile: "Main 10",
      audioCodec: "truehd",
      audioChannels: 8,
      container: "mkv",
    });
    expect(media.Part![0]).toMatchObject({ file: "/m/film.mkv", size: 58_412_633_211, container: "mkv", duration: 7_200_000 });
    const [video, atmos, aac, sub, other] = media.Part![0].Stream!;
    expect(video).toMatchObject({
      streamType: 1,
      bitrate: 18_000,
      frameRate: 23.976,
      anamorphic: "1",
      scanType: "progressive",
      DOVIPresent: true,
      DOVIProfile: 8,
      DOVIRPUPresent: true,
      DOVIBLPresent: true,
      DOVIELPresent: undefined,
      DOVIVersion: "1.0",
      HDR10PlusPresent: true,
    });
    expect(atmos).toMatchObject({ streamType: 2, channels: 8, audioSpatialFormat: "DolbyAtmos", DOVIPresent: undefined });
    expect(aac).toMatchObject({ audioSpatialFormat: undefined, scanType: "progressive" });
    expect(sub).toMatchObject({ streamType: 3, forced: true, scanType: undefined });
    expect(other.streamType).toBe(0);
  });

  it("prefers VideoDoViTitle and GenreItems, and maps an episode's parents", async () => {
    const m = await metadata({
      Id: "e1",
      Name: "Pilot",
      Type: "Episode",
      SeriesName: "Show",
      SeriesId: "ser",
      SeriesPrimaryImageTag: "s",
      SeasonName: "Season 1",
      SeasonId: "sea",
      ParentIndexNumber: 1,
      IndexNumber: 2,
      ParentBackdropImageTags: ["b"],
      GenreItems: [{ Name: "Comedy", Id: "g" }],
      Genres: ["Ignored"],
      MediaSources: [
        {
          MediaStreams: [
            {
              Index: 0,
              Type: "Video",
              Codec: "hevc",
              IsInterlaced: true,
              VideoRangeType: "DOVI",
              DvProfile: 5,
              DvLevel: 6,
              DvVersionMajor: 1,
              DvVersionMinor: 0,
              RpuPresentFlag: 1,
              BlPresentFlag: 1,
              ElPresentFlag: 0,
              VideoDoViTitle: "Dolby Vision Profile 5",
            },
          ],
        },
      ],
    });
    expect(m).toMatchObject({
      type: "episode",
      parentTitle: "Season 1",
      parentRatingKey: "sea",
      parentIndex: 1,
      index: 2,
      grandparentTitle: "Show",
      grandparentRatingKey: "ser",
      parentThumb: "/Items/sea/Images/Primary",
      grandparentThumb: "/Items/ser/Images/Primary",
      art: "/Items/ser/Images/Backdrop",
      thumb: undefined,
      Genre: [{ tag: "Comedy" }],
      Guid: undefined,
      Role: undefined,
      Director: undefined,
      Writer: undefined,
      isWatchlisted: false,
    });
    const stream = m.Media![0].Part![0].Stream![0];
    // The server's own title wins over the "1.0" built from the version fields.
    expect(stream.DOVIVersion).toBe("Dolby Vision Profile 5");
    expect(stream).toMatchObject({ DOVIPresent: true, DOVIProfile: 5, scanType: "interlaced", videoRangeType: "DOVI" });
    expect(m.Media![0].bitrate).toBeUndefined();
  });

  it("maps a track's album and album artist parents", async () => {
    const m = await metadata({
      Id: "t1",
      Name: "Song",
      Type: "Audio",
      Album: "Album",
      AlbumId: "alb",
      AlbumArtist: "Artist",
      AlbumArtists: [{ Id: "art", Name: "Artist" }],
      MediaSources: [{}],
    });
    expect(m).toMatchObject({
      type: "track",
      parentTitle: "Album",
      parentRatingKey: "alb",
      grandparentTitle: "Artist",
      grandparentRatingKey: "art",
      parentThumb: "/Items/alb/Images/Primary",
      grandparentThumb: "/Items/art/Images/Primary",
      art: undefined,
    });
    expect(m.Media![0].Part![0].Stream).toEqual([]);
  });

  it.each([
    ["Series", "show"],
    ["Season", "season"],
    ["MusicArtist", "artist"],
    ["MusicAlbum", "album"],
    ["BoxSet", "boxset"],
  ])("maps item type %s to %s", async (type, mapped) => {
    const m = await metadata({ Id: "1", Name: "x", Type: type });
    expect(m.type).toBe(mapped);
    expect(m.Media).toBeUndefined();
  });
});
