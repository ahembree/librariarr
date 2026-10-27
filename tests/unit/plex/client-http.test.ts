import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";

// Drives PlexClient against a local HTTP server, so the real axios interceptor
// chain (breaker, logging) runs together with each method's response shaping.

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PlexClient } from "@/lib/plex/client";
import { logger } from "@/lib/logger";
import { _resetForTesting, markUnreachable } from "@/lib/media-server/health-cache";

type Reply = { status?: number; body?: unknown; raw?: Buffer | string; contentType?: string | null; location?: string };
type Handler = (url: URL, method: string) => Reply | undefined;

interface Recorded {
  method: string;
  path: string;
  rawUrl: string;
  query: URLSearchParams;
}

let server: http.Server | null = null;
let requests: Recorded[] = [];

async function serve(handler: Handler): Promise<string> {
  requests = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    req.resume();
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: url.pathname, rawUrl: req.url ?? "", query: url.searchParams });
      const out = handler(url, req.method ?? "GET") ?? { status: 404, body: {} };
      const headers: Record<string, string> = {};
      if (out.contentType !== null) headers["Content-Type"] = out.contentType ?? "application/json";
      if (out.location) headers.Location = out.location;
      res.writeHead(out.status ?? 200, headers);
      res.end(out.raw ?? JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  _resetForTesting();
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const mc = (body: Record<string, unknown>) => ({ body: { MediaContainer: body } });

describe("interceptors", () => {
  it("refuses a request while the server is marked unreachable, without sending it", async () => {
    const url = await serve(() => mc({}));
    markUnreachable(url, new Error("ETIMEDOUT"));
    await expect(new PlexClient(url, "t").getLibraries()).rejects.toThrow(/is unreachable/);
    expect(requests).toHaveLength(0);
  });

  it("logs list requests but not per-item metadata fetches", async () => {
    const url = await serve((u) => (u.pathname.startsWith("/library/metadata/") ? mc({ Metadata: [{ ratingKey: "1" }] }) : mc({})));
    const c = new PlexClient(url, "t", { skipTlsVerify: true });
    await c.getItemMetadata("1");
    expect(logger.debug).not.toHaveBeenCalled();
    await c.getLibraries();
    expect(logger.debug).toHaveBeenCalledWith("Plex", "GET /library/sections");
    expect(logger.debug).toHaveBeenCalledWith("Plex", expect.stringMatching(/^200 \/library\/sections \(\d+ms\)$/));
  });

  it("logs a failed request with its status", async () => {
    const url = await serve(() => ({ status: 403, body: {} }));
    await expect(new PlexClient(url, "t").getCollections("1")).rejects.toThrow("Request failed with status code 403");
    expect(logger.debug).toHaveBeenCalledWith("Plex", "ERROR 403 /library/sections/1/collections", {
      message: "Request failed with status code 403",
    });
  });
});

describe("library listings", () => {
  it.each([
    ["getLibraryShows", "2"],
    ["getLibraryArtists", "8"],
    ["getLibraryEpisodes", "4"],
    ["getLibraryTracks", "10"],
  ] as const)("%s asks for type %s and returns [] for an empty section", async (method, type) => {
    const url = await serve(() => mc({}));
    expect(await new PlexClient(url, "t")[method]("7")).toEqual([]);
    expect(requests[0].path).toBe("/library/sections/7/all");
    expect(requests[0].query.get("type")).toBe(type);
    expect(requests[0].query.get("includeGuids")).toBe("1");
  });

  it.each([
    ["episode", "4"],
    ["track", "10"],
  ] as const)("getLibraryItemsPage(%s) sends type %s; a missing totalSize is null", async (type, typeParam) => {
    const url = await serve(() => mc({ size: 1, Metadata: [{ ratingKey: "1" }] }));
    const page = await new PlexClient(url, "t").getLibraryItemsPage("3", type, 0, 50);
    expect(page.total).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(requests[0].query.get("type")).toBe(typeParam);
  });

  it("getLibraryItemsPage returns [] for a page with no Metadata", async () => {
    const url = await serve(() => mc({ totalSize: 0 }));
    expect(await new PlexClient(url, "t").getLibraryItemsPage("3", "movie", 0, 50)).toEqual({ items: [], total: 0 });
  });
});

describe("getItemMediaResolutions", () => {
  it("maps each version by id, preferring dimensions over the label and skipping unknowns", async () => {
    const url = await serve(() =>
      mc({
        Metadata: [
          {
            ratingKey: "9",
            Media: [
              { id: 1, width: 3840, height: 2160, videoResolution: "1080" },
              { id: 2, videoResolution: "720" },
              { id: 3 },
              { width: 1920, height: 1080 },
            ],
          },
        ],
      }),
    );
    const map = await new PlexClient(url, "t").getItemMediaResolutions("9");
    // Version 1's file is 2160p whatever its label says; version 3 reports
    // nothing usable and the id-less version cannot be keyed.
    expect(map).toEqual(
      new Map([
        ["1", "4k"],
        ["2", "720"],
      ]),
    );
  });

  it("returns an empty map for an item with no Media", async () => {
    const url = await serve(() => mc({ Metadata: [{ ratingKey: "9" }] }));
    expect((await new PlexClient(url, "t").getItemMediaResolutions("9")).size).toBe(0);
  });
});

describe("getWatchHistory", () => {
  it("keeps full plays only and names each by account, then User.title, then Unknown", async () => {
    const url = await serve((u) => {
      if (u.pathname === "/accounts") return mc({ Account: [{ id: 1, name: "Alice" }] });
      return mc({
        Metadata: [
          { accountID: 1, viewedAt: 1_700_000_000 },
          { accountID: 99, User: { title: "Bob" }, viewOffset: 95, duration: 100 },
          { viewOffset: 10, duration: 100 }, // partial → dropped
          { viewOffset: 50 }, // falls back to the item duration (60) → 83% → dropped
          { viewOffset: 58 }, // 96% of 60 → kept, Unknown
        ],
      });
    });
    const plays = await new PlexClient(url, "t").getWatchHistory("5", 60);
    expect(plays).toEqual([
      { username: "Alice", watchedAt: new Date(1_700_000_000 * 1000).toISOString() },
      { username: "Bob", watchedAt: null },
      { username: "Unknown", watchedAt: null },
    ]);
    const hist = requests.find((r) => r.path === "/status/sessions/history/all")!;
    expect(hist.query.get("metadataItemID")).toBe("5");
  });

  it("keeps a play with an offset when no duration is known, and survives a failed /accounts", async () => {
    const url = await serve((u) => {
      if (u.pathname === "/accounts") return { status: 401, body: {} };
      return mc({ Metadata: [{ accountID: 1, viewOffset: 10 }] });
    });
    expect(await new PlexClient(url, "t").getWatchHistory("5")).toEqual([{ username: "Unknown", watchedAt: null }]);
  });

  it("returns [] when the item has no history", async () => {
    const url = await serve(() => mc({}));
    expect(await new PlexClient(url, "t").getWatchHistory("5")).toEqual([]);
  });
});

describe("history paging", () => {
  it("getDetailedWatchHistory walks every history page until totalSize", async () => {
    const url = await serve((u) => {
      if (u.pathname !== "/status/sessions/history/all") return mc({});
      const start = Number(u.searchParams.get("X-Plex-Container-Start"));
      if (start === 0) {
        // A server capping the page below the 5,000 asked for: a short page that
        // is NOT the end, because totalSize says more follow.
        return mc({ totalSize: 4, Metadata: [{ ratingKey: "a" }, { ratingKey: "b" }] });
      }
      return mc({ totalSize: 4, Metadata: [{ ratingKey: "c" }, { ratingKey: "d" }] });
    });
    const rows = await new PlexClient(url, "t").getDetailedWatchHistory();
    expect(rows.map((r) => r.ratingKey)).toEqual(["a", "b", "c", "d"]);
    const history = requests.filter((r) => r.path === "/status/sessions/history/all");
    expect(history.map((r) => r.query.get("X-Plex-Container-Start"))).toEqual(["0", "2"]);
  });

  it("getDetailedWatchHistory stops on an empty first page", async () => {
    const url = await serve(() => mc({}));
    expect(await new PlexClient(url, "t").getDetailedWatchHistory()).toEqual([]);
    expect(requests.filter((r) => r.path === "/status/sessions/history/all")).toHaveLength(1);
  });

  it("getDetailedWatchHistory sends viewedAt>= verbatim and labels plays by account and device", async () => {
    const url = await serve((u) => {
      if (u.pathname === "/accounts") return mc({ Account: [{ id: 1, name: "Alice" }] });
      if (u.pathname === "/devices") return mc({ Device: [{ id: 5, name: "TV", platform: "tvOS" }, { id: 6 }] });
      return mc({
        Metadata: [
          { ratingKey: "a", accountID: 1, deviceID: 5, viewedAt: 1_700_000_000 },
          { ratingKey: "b", deviceID: 6 },
          { ratingKey: "c", accountID: 2, deviceID: 404 },
          { ratingKey: "d", viewOffset: 1, duration: 100 },
          { accountID: 1 },
        ],
      });
    });
    const since = new Date(1_600_000_000_500);
    const rows = await new PlexClient(url, "t").getDetailedWatchHistory({ since });
    expect(rows).toEqual([
      { ratingKey: "a", username: "Alice", watchedAt: new Date(1_700_000_000_000).toISOString(), deviceName: "TV", platform: "tvOS" },
      { ratingKey: "b", username: "Unknown", watchedAt: null, deviceName: "Unknown", platform: "" },
      { ratingKey: "c", username: "Unknown", watchedAt: null, deviceName: null, platform: null },
    ]);
    const hist = requests.find((r) => r.path === "/status/sessions/history/all")!;
    // The `=` must reach Plex as a separator, never as `%3D` (which Plex ignores);
    // Node's URL encoder escapes only the `>`, which decodes back to the filter.
    expect(hist.query.get("viewedAt>")).toBe("1600000000");
    expect(hist.rawUrl).not.toContain("%3D");
  });

  it("getDetailedWatchHistory throws when /accounts is unrecognisable, but tolerates a failed /devices", async () => {
    const url = await serve((u) => {
      if (u.pathname === "/accounts") return { body: { nope: true } };
      if (u.pathname === "/devices") return { status: 401, body: {} };
      return mc({});
    });
    await expect(new PlexClient(url, "t").getDetailedWatchHistory()).rejects.toThrow(/Unrecognized Plex \/accounts/);
  });

  it("getDetailedWatchHistory labels rows with no device map when /devices fails", async () => {
    const url = await serve((u) => {
      if (u.pathname === "/accounts") return mc({});
      if (u.pathname === "/devices") return { status: 401, body: {} };
      return mc({ Metadata: [{ ratingKey: "a", deviceID: 5 }] });
    });
    expect(await new PlexClient(url, "t").getDetailedWatchHistory()).toEqual([
      { ratingKey: "a", username: "Unknown", watchedAt: null, deviceName: null, platform: null },
    ]);
  });
});

describe("collections", () => {
  it("getCollectionItems returns [] for an empty collection", async () => {
    const url = await serve(() => mc({}));
    expect(await new PlexClient(url, "t").getCollectionItems("48211")).toEqual([]);
    expect(requests[0].path).toBe("/library/collections/48211/items");
  });

  it("moveCollectionItem sends after only when given", async () => {
    const url = await serve(() => mc({}));
    const c = new PlexClient(url, "t");
    await c.moveCollectionItem("48211", "5311", "5310");
    await c.moveCollectionItem("48211", "5312");
    expect(requests.map((r) => [r.method, r.path, r.query.get("after")])).toEqual([
      ["PUT", "/library/collections/48211/items/5311/move", "5310"],
      ["PUT", "/library/collections/48211/items/5312/move", null],
    ]);
  });

  it("edits a collection's sort title and its sort order", async () => {
    const url = await serve(() => mc({}));
    const c = new PlexClient(url, "t");
    await c.editCollectionSortTitle("2", "48211", "!Leaving");
    await c.editCollectionSort("48211", 1);
    expect(requests[0].path).toBe("/library/sections/2/all");
    expect(Object.fromEntries(requests[0].query)).toEqual({
      type: "18",
      id: "48211",
      "titleSort.value": "!Leaving",
      "titleSort.locked": "1",
    });
    expect(requests[1].path).toBe("/library/metadata/48211/prefs");
    expect(requests[1].query.get("collectionSort")).toBe("1");
  });

  describe("visibility", () => {
    function hubServer(hubs: unknown[] | undefined, opts: { deleteStatus?: number } = {}) {
      return serve((u, method) => {
        if (method === "GET") return mc(hubs ? { Hub: hubs } : {});
        if (method === "DELETE") return { status: opts.deleteStatus ?? 200, body: {} };
        return mc({});
      });
    }

    it("reads the exact hub identifier first", async () => {
      const url = await hubServer([
        { identifier: "other.48211", promotedToOwnHome: true },
        { identifier: "custom.collection.2.48211", promotedToSharedHome: 1, promotedToRecommended: 0 },
      ]);
      expect(await new PlexClient(url, "t").getCollectionVisibility("2", "48211")).toEqual({
        identifier: "custom.collection.2.48211",
        home: false,
        shared: true,
        recommended: false,
      });
      expect(requests[0].query.get("metadataItemId")).toBe("48211");
    });

    it("falls back to a hub whose identifier ends in the rating key", async () => {
      const url = await hubServer([{ identifier: "custom.collection.9.48211", promotedToOwnHome: true }]);
      expect((await new PlexClient(url, "t").getCollectionVisibility("2", "48211")).identifier).toBe(
        "custom.collection.9.48211",
      );
    });

    it("reports no hub when none matches or the container has no Hub", async () => {
      const url = await hubServer(undefined);
      expect(await new PlexClient(url, "t").getCollectionVisibility("2", "48211")).toEqual({
        identifier: null,
        home: false,
        shared: false,
        recommended: false,
      });
    });

    it("deletes an existing hub when every promotion is turned off", async () => {
      const url = await hubServer([{ identifier: "custom.collection.2.48211" }]);
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", false, false, false);
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /hubs/sections/2/manage",
        "DELETE /hubs/sections/2/manage/custom.collection.2.48211",
      ]);
    });

    it("zeroes every promotion when the server refuses the DELETE", async () => {
      const url = await hubServer([{ identifier: "custom.collection.2.48211" }], { deleteStatus: 405 });
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", false, false, false);
      const put = requests.find((r) => r.method === "PUT")!;
      expect(put.path).toBe("/hubs/sections/2/manage/custom.collection.2.48211");
      expect(Object.fromEntries(put.query)).toEqual({
        promotedToOwnHome: "0",
        promotedToSharedHome: "0",
        promotedToRecommended: "0",
      });
    });

    it("updates an existing hub with the wanted promotions", async () => {
      const url = await hubServer([{ identifier: "custom.collection.2.48211" }]);
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", true, false, true);
      const put = requests.find((r) => r.method === "PUT")!;
      expect(Object.fromEntries(put.query)).toEqual({
        promotedToOwnHome: "1",
        promotedToSharedHome: "0",
        promotedToRecommended: "1",
      });
    });

    it("creates a hub when none exists and a promotion is wanted", async () => {
      const url = await hubServer([]);
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", false, true, false);
      const post = requests.find((r) => r.method === "POST")!;
      expect(post.path).toBe("/hubs/sections/2/manage");
      expect(post.query.get("metadataItemId")).toBe("48211");
      expect(post.query.get("promotedToSharedHome")).toBe("1");
    });

    // The collection sync reads the hub to see whether anything changed and
    // hands that state over, so the update makes no second read.
    it("applies the state the caller already read without reading it again", async () => {
      const url = await hubServer([{ identifier: "custom.collection.2.48211" }]);
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", true, true, false, {
        identifier: "custom.collection.2.48211",
        home: false,
        shared: false,
        recommended: false,
      });
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "PUT /hubs/sections/2/manage/custom.collection.2.48211",
      ]);
    });

    it("creates a hub from a known state that has none, without reading it", async () => {
      const url = await hubServer([]);
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", true, true, false, {
        identifier: null,
        home: false,
        shared: false,
        recommended: false,
      });
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /hubs/sections/2/manage"]);
    });

    it("does nothing when there is no hub and no promotion is wanted", async () => {
      const url = await hubServer([]);
      await new PlexClient(url, "t").updateCollectionVisibility("2", "48211", false, false, false);
      expect(requests.map((r) => r.method)).toEqual(["GET"]);
    });
  });
});

describe("getSessions", () => {
  it("maps the selected version and every optional field", async () => {
    const url = await serve(() =>
      mc({
        Metadata: [
          {
            sessionKey: "17",
            ratingKey: 42,
            type: "episode",
            title: "Pilot",
            parentTitle: "Season 1",
            grandparentTitle: "Show",
            parentIndex: 1,
            index: 3,
            year: 2008,
            thumb: "/t",
            art: "/a",
            parentThumb: "/pt",
            grandparentThumb: "/gt",
            summary: "S",
            contentRating: "TV-MA",
            studio: "AMC",
            rating: 9,
            audienceRating: 9.5,
            tagline: "TL",
            Genre: [{ tag: "Drama" }],
            duration: 1000,
            viewOffset: 10,
            User: { id: 3, title: "Ann", thumb: "/u" },
            Player: { product: "Plex Web", platform: "Chrome", state: "playing", address: "10.0.0.2", local: true },
            Session: { bandwidth: 5000, location: "lan" },
            TranscodeSession: {
              videoDecision: "transcode",
              audioDecision: "copy",
              throttled: 1,
              sourceVideoCodec: "hevc",
              sourceAudioCodec: "eac3",
              speed: 2.1,
              transcodeHwRequested: 0,
              transcodeHwDecoding: "vaapi",
              transcodeHwEncoding: "vaapi",
              transcodeHwFullPipeline: 1,
            },
            Media: [
              { id: 1, videoResolution: "1080" },
              {
                id: 2,
                selected: true,
                width: 3840,
                height: 2160,
                videoCodec: "hevc",
                audioCodec: "eac3",
                container: "mkv",
                bitrate: 40000,
                aspectRatio: 1.78,
                audioChannels: 6,
                videoResolution: "4k",
                videoProfile: "main 10",
                audioProfile: "dd+",
                optimizedForStreaming: 0,
                Part: [{ file: "/m/x.mkv", size: 123 }],
              },
            ],
          },
        ],
      }),
    );
    const [s] = await new PlexClient(url, "t").getSessions();
    expect(s).toEqual({
      sessionId: "17",
      ratingKey: "42",
      mediaId: "2",
      userId: "3",
      username: "Ann",
      userThumb: "/u",
      title: "Pilot",
      parentTitle: "Season 1",
      grandparentTitle: "Show",
      type: "episode",
      year: 2008,
      seasonNumber: 1,
      episodeNumber: 3,
      thumb: "/t",
      art: "/a",
      parentThumb: "/pt",
      grandparentThumb: "/gt",
      summary: "S",
      contentRating: "TV-MA",
      studio: "AMC",
      rating: 9,
      audienceRating: 9.5,
      tagline: "TL",
      genres: ["Drama"],
      mediaWidth: 3840,
      mediaHeight: 2160,
      duration: 1000,
      viewOffset: 10,
      videoCodec: "hevc",
      audioCodec: "eac3",
      container: "mkv",
      bitrate: 40000,
      aspectRatio: "1.78",
      audioChannels: 6,
      videoResolution: "4k",
      videoProfile: "main 10",
      audioProfile: "dd+",
      optimizedForStreaming: false,
      partFile: "/m/x.mkv",
      partSize: 123,
      player: { product: "Plex Web", platform: "Chrome", state: "playing", address: "10.0.0.2", local: true },
      session: { bandwidth: 5000, location: "lan" },
      transcoding: {
        videoDecision: "transcode",
        audioDecision: "copy",
        throttled: true,
        sourceVideoCodec: "hevc",
        sourceAudioCodec: "eac3",
        speed: 2.1,
        transcodeHwRequested: false,
        hwDecode: "vaapi",
        hwEncode: "vaapi",
        hwFullPipeline: true,
      },
    });
  });

  it("fills defaults for a bare session and leaves episode numbers unset when not numeric", async () => {
    const url = await serve(() =>
      mc({
        Metadata: [
          { type: "episode", parentIndex: "1", TranscodeSession: {} },
          { Session: { id: "abc" }, Media: [{ id: 5 }] },
        ],
      }),
    );
    const [bare, withId] = await new PlexClient(url, "t").getSessions();
    expect(bare).toMatchObject({
      sessionId: "",
      ratingKey: undefined,
      mediaId: undefined,
      userId: "",
      username: "Unknown",
      title: "",
      seasonNumber: undefined,
      episodeNumber: undefined,
      genres: undefined,
      optimizedForStreaming: undefined,
      player: { product: "", platform: "", state: "", address: "", local: false },
      session: { bandwidth: 0, location: "" },
      transcoding: {
        videoDecision: "",
        audioDecision: "",
        throttled: false,
        transcodeHwRequested: undefined,
        hwFullPipeline: undefined,
      },
    });
    expect(withId).toMatchObject({ sessionId: "abc", mediaId: "5", type: "" });
    expect(withId).not.toHaveProperty("transcoding");
    expect(withId).not.toHaveProperty("seasonNumber");
  });

  it("returns [] when the container has no Metadata or no container at all", async () => {
    const url = await serve(() => ({ body: {} }));
    expect(await new PlexClient(url, "t").getSessions()).toEqual([]);
  });
});

describe("fetchImage", () => {
  it("falls back to the original when the transcoder answers with a non-image", async () => {
    const url = await serve((u) => {
      if (u.pathname === "/photo/:/transcode") return { raw: "<html>err</html>", contentType: "text/html" };
      return { raw: Buffer.from([9, 9]), contentType: "image/png" };
    });
    const img = await new PlexClient(url, "t").fetchImage("/library/metadata/1/thumb/2", { width: 400 });
    expect(img).toEqual({ data: Buffer.from([9, 9]), contentType: "image/png" });
    expect(requests.map((r) => r.path)).toEqual(["/photo/:/transcode", "/library/metadata/1/thumb/2"]);
  });

  it("falls back when the transcoder fails, and when it returns an empty body", async () => {
    let mode: "fail" | "empty" = "fail";
    const url = await serve((u) => {
      if (u.pathname === "/photo/:/transcode") return mode === "fail" ? { status: 400, body: {} } : { raw: "", contentType: "image/jpeg" };
      return { raw: Buffer.from([1]), contentType: "image/jpeg" };
    });
    const c = new PlexClient(url, "t");
    expect((await c.fetchImage("/p", { width: 400 })).data).toEqual(Buffer.from([1]));
    mode = "empty";
    expect((await c.fetchImage("/p", { width: 400 })).data).toEqual(Buffer.from([1]));
  });

  it("accepts a transcoder answer without a content type, defaulting to JPEG", async () => {
    const url = await serve(() => ({ raw: Buffer.from([7]), contentType: null }));
    const img = await new PlexClient(url, "t").fetchImage("/p", { width: 400 });
    expect(img).toEqual({ data: Buffer.from([7]), contentType: "image/jpeg" });
    expect(requests).toHaveLength(1);
  });

  it("defaults the content type on the direct path too", async () => {
    const url = await serve(() => ({ raw: Buffer.from([8]), contentType: null }));
    const img = await new PlexClient(url, "t").fetchImage("/p");
    expect(img.contentType).toBe("image/jpeg");
    expect(requests[0].path).toBe("/p");
  });
});

describe("preroll", () => {
  it("returns an empty preroll when the pref is absent", async () => {
    const url = await serve(() => mc({ Setting: [{ id: "Other", value: "x" }] }));
    expect(await new PlexClient(url, "t").getPrerollSetting()).toBe("");
  });

  it("returns an empty preroll when prefs carry no settings", async () => {
    const url = await serve(() => ({ body: {} }));
    expect(await new PlexClient(url, "t").getPrerollSetting()).toBe("");
  });
});

describe("testConnection", () => {
  it("refuses a response without a MediaContainer", async () => {
    const url = await serve(() => ({ body: { hello: 1 } }));
    expect(await new PlexClient(url, "t").testConnection()).toEqual({
      ok: false,
      error: "This does not appear to be a Plex server — no MediaContainer in response",
    });
  });

  it("asks the server even while it is marked unreachable", async () => {
    const url = await serve(() => mc({ friendlyName: "Basement" }));
    markUnreachable(url, new Error("x"));
    expect(await new PlexClient(url, "t").testConnection()).toEqual({ ok: true, serverName: "Basement" });
  });

  it.each([
    [404, "This does not appear to be a Plex server — check your server type selection"],
    [401, "Authentication failed - invalid access token"],
  ])("maps HTTP %i", async (status, error) => {
    const url = await serve(() => ({ status, body: {} }));
    expect(await new PlexClient(url, "t").testConnection()).toEqual({ ok: false, error });
  });

  it("reports the axios message for any other status", async () => {
    const url = await serve(() => ({ status: 400, body: {} }));
    const result = await new PlexClient(url, "t").testConnection();
    expect(result).toEqual({ ok: false, error: "Request failed with status code 400" });
  });

  it("maps a refused connection", async () => {
    const url = await serve(() => undefined);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect(await new PlexClient(url, "t").testConnection()).toEqual({
      ok: false,
      error: "Connection refused - server may be offline or unreachable from this network",
    });
  });
});

describe("getWatchlistGuids", () => {
  it("collects every GUID, tolerating items without any", async () => {
    const spy = vi.spyOn(axios, "get").mockResolvedValue({
      data: { MediaContainer: { Metadata: [{ Guid: [{ id: "tmdb://1" }, {}] }, {}, { Guid: [{ id: "imdb://tt2" }] }] } },
    });
    const guids = await new PlexClient("http://plex", "tok").getWatchlistGuids();
    expect(guids).toEqual(new Set(["tmdb://1", "imdb://tt2"]));
    expect(spy.mock.calls[0][1]?.headers).toMatchObject({ "X-Plex-Token": "tok" });
  });

  it("returns an empty set for an empty watchlist", async () => {
    // plex.tv's own answer for an account with nothing watchlisted.
    vi.spyOn(axios, "get").mockResolvedValue({ data: { MediaContainer: { offset: 0, size: 0, totalSize: 0 } } });
    expect(await new PlexClient("http://plex", "tok").getWatchlistGuids()).toEqual(new Set());
  });

  // The sync clears `isWatchlisted` on every item missing from the set, so a
  // truncated answer must read as unknown (null), never as a shorter list.
  // It used to be one 10,000-item request with no paging.
  /** A watchlist of `total` items that plex.tv serves `cap` at a time. */
  function servePagedWatchlist(total: number, cap: number, opts: { reportTotal?: boolean } = {}) {
    const items = Array.from({ length: total }, (_, i) => ({ ratingKey: `w${i}`, Guid: [{ id: `tmdb://${i}` }] }));
    return vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
      const params = (config?.params ?? {}) as Record<string, number>;
      const start = params["X-Plex-Container-Start"] ?? 0;
      const size = Math.min(params["X-Plex-Container-Size"] ?? 50, cap);
      const page = items.slice(start, start + size);
      return {
        data: {
          MediaContainer: {
            offset: start,
            size: page.length,
            ...(opts.reportTotal === false ? {} : { totalSize: total }),
            Metadata: page,
          },
        },
      };
    });
  }

  it("pages until totalSize when plex.tv caps the page", async () => {
    const spy = servePagedWatchlist(5, 2);
    const guids = await new PlexClient("http://plex", "tok").getWatchlistGuids();
    expect(guids).toEqual(new Set(["tmdb://0", "tmdb://1", "tmdb://2", "tmdb://3", "tmdb://4"]));
    expect(spy.mock.calls.map((c) => (c[1]?.params as Record<string, number>)["X-Plex-Container-Start"])).toEqual([0, 2, 4]);
  });

  it("pages past a full page when no total is reported, ending on the short one", async () => {
    const spy = servePagedWatchlist(130, 1000, { reportTotal: false });
    const guids = await new PlexClient("http://plex", "tok").getWatchlistGuids();
    expect(guids?.size).toBe(130);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns null when the pages stop before totalSize", async () => {
    vi.spyOn(axios, "get")
      .mockResolvedValueOnce({
        data: { MediaContainer: { offset: 0, totalSize: 3, Metadata: [{ Guid: [{ id: "tmdb://1" }] }] } },
      })
      .mockResolvedValueOnce({ data: { MediaContainer: { offset: 1, totalSize: 3, Metadata: [] } } });
    expect(await new PlexClient("http://plex", "tok").getWatchlistGuids()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("Plex", expect.stringContaining("stopped at 1 of 3 items"));
  });

  it("returns null when plex.tv ignores the start offset", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: { MediaContainer: { offset: 0, totalSize: 3, Metadata: [{ Guid: [{ id: "tmdb://1" }] }] } },
    });
    expect(await new PlexClient("http://plex", "tok").getWatchlistGuids()).toBeNull();
  });

  it("returns null for an answer that is not a MediaContainer", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: "<html>Sign in</html>" });
    expect(await new PlexClient("http://plex", "tok").getWatchlistGuids()).toBeNull();
  });

  it("returns null (not an empty set) on a non-Error failure", async () => {
    vi.spyOn(axios, "get").mockRejectedValue("nope");
    expect(await new PlexClient("http://plex", "tok").getWatchlistGuids()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "Plex",
      "Failed to fetch the plex.tv watchlist — stored watchlist flags are kept unchanged this sync",
      { error: "Unknown error" },
    );
  });
});
