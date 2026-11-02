import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/http-retry", () => ({
  configureRetry: vi.fn(),
  NO_RETRY: { __noRetry: true },
  NO_BREAKER_MARK: { __noBreakerMark: true },
}));

const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

vi.mock("axios", () => {
  const actualAxios = {
    create: vi.fn(() => mockAxiosInstance),
    get: vi.fn(),
    isAxiosError: function (e: unknown) {
      return e instanceof Error && "isAxiosError" in e;
    },
  };
  return { default: actualAxios };
});

import axios from "axios";
import { PlexClient } from "@/lib/plex/client";
import { MediaItemNotFoundError } from "@/lib/media-server/client";

describe("PlexClient", () => {
  let client: PlexClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued `mock*Once` answers; one a failed test left
    // unconsumed would answer the next test's first request.
    for (const fn of [mockAxiosInstance.get, mockAxiosInstance.post, mockAxiosInstance.put, mockAxiosInstance.delete]) {
      fn.mockReset();
    }
    vi.mocked(axios.get).mockReset();
    client = new PlexClient("http://plex:32400", "test-token");
  });

  describe("getLibraries", () => {
    it("returns filtered library sections (movie, show, artist)", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Directory: [
              { key: "1", title: "Movies", type: "movie" },
              { key: "2", title: "TV Shows", type: "show" },
              { key: "3", title: "Music", type: "artist" },
              { key: "4", title: "Photos", type: "photo" },
            ],
          },
        },
      });
      const result = await client.getLibraries();
      expect(result).toHaveLength(3);
      expect(result.map((l) => l.type)).toEqual(["movie", "show", "artist"]);
    });

    it("returns empty array when no directories", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: {} },
      });
      const result = await client.getLibraries();
      expect(result).toEqual([]);
    });
  });

  describe("getLibraryItems", () => {
    it("fetches all items with includeGuids", async () => {
      const items = [{ ratingKey: "1", title: "Movie 1" }];
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: items } },
      });
      const result = await client.getLibraryItems("1");
      expect(result).toEqual(items);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/sections/1/all",
        { params: { includeGuids: 1 } }
      );
    });

    it("returns empty array when no metadata", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: {} },
      });
      const result = await client.getLibraryItems("1");
      expect(result).toEqual([]);
    });

    it("drops collections returned by an untyped section listing", async () => {
      // Callers resolve series rating keys by title from this list. A Plex
      // collection sharing a series' title would otherwise resolve to the
      // collection and get nested inside another collection.
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              { ratingKey: "1", title: "Breaking Bad", type: "show" },
              { ratingKey: "99", title: "Breaking Bad", type: "collection" },
            ],
          },
        },
      });
      const result = await client.getLibraryItems("2");
      expect(result).toEqual([
        { ratingKey: "1", title: "Breaking Bad", type: "show" },
      ]);
    });
  });

  describe("getLibraryShows", () => {
    it("fetches shows with type=2", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "1", title: "Show" }] } },
      });
      const result = await client.getLibraryShows("2");
      expect(result).toHaveLength(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/sections/2/all",
        { params: { type: 2, includeGuids: 1 } }
      );
    });
  });

  describe("getLibraryEpisodes", () => {
    it("fetches episodes with type=4", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [] } },
      });
      await client.getLibraryEpisodes("2");
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/sections/2/all",
        { params: { type: 4, includeGuids: 1 } }
      );
    });
  });

  describe("getLibraryTracks", () => {
    it("fetches tracks with type=10", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [] } },
      });
      await client.getLibraryTracks("3");
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/sections/3/all",
        { params: { type: 10, includeGuids: 1 } }
      );
    });
  });

  describe("getLibraryItemsPage", () => {
    it("fetches paginated items with episode type", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "1" }], totalSize: 100 } },
      });
      const result = await client.getLibraryItemsPage("2", "episode", 0, 50);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(100);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/sections/2/all",
        {
          params: {
            includeGuids: 1,
            "X-Plex-Container-Start": 0,
            "X-Plex-Container-Size": 50,
            type: 4,
          },
        }
      );
    });

    it("returns total=null when totalSize is absent (never a numeric sentinel)", async () => {
      // `size` is the per-page count, not the library total. Trusting it would
      // terminate the sync loop early and wrongly delete unfetched items as
      // stale. The client returns null ("unknown") — NOT a large sentinel,
      // which previously overflowed the Int SyncJob.totalItems column — and the
      // sync loop's short-page detection governs termination.
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [], size: 0 } },
      });
      const result = await client.getLibraryItemsPage("3", "track", 0, 50);
      expect(result.total).toBeNull();
    });

    it("fetches paginated items for movie type with an explicit type=1", async () => {
      // An untyped `/all` listing returns the section's COLLECTIONS alongside
      // its movies, and the sync stored those as phantom media items. Filtering
      // server-side (rather than dropping them from the response) also keeps
      // `totalSize` consistent with the returned page — the sync's paging and
      // stale-item purge accounting both depend on that.
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "1" }] } },
      });
      const result = await client.getLibraryItemsPage("1", "movie", 10, 25);
      expect(result.items).toHaveLength(1);
      // No totalSize → null (see note above); loop terminates on short page.
      expect(result.total).toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/sections/1/all",
        {
          params: {
            includeGuids: 1,
            "X-Plex-Container-Start": 10,
            "X-Plex-Container-Size": 25,
            type: 1,
          },
        }
      );
    });
  });

  describe("getItemMetadata", () => {
    it("fetches single item metadata", async () => {
      const item = { ratingKey: "123", title: "Test" };
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [item] } },
      });
      const result = await client.getItemMetadata("123");
      expect(result).toEqual(item);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/library/metadata/123");
    });

    it("merges librarySectionID down from the container when the item lacks it", async () => {
      // The incremental sync maps a brand-new item to its library through this
      // field; some responses carry it only on the MediaContainer.
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            librarySectionID: 1,
            Metadata: [{ ratingKey: "123", title: "Test" }],
          },
        },
      });
      const result = await client.getItemMetadata("123");
      expect(result.librarySectionID).toBe(1);
    });

    it("prefers the item's own librarySectionID over the container's", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            librarySectionID: 1,
            Metadata: [{ ratingKey: "123", title: "Test", librarySectionID: 2 }],
          },
        },
      });
      expect((await client.getItemMetadata("123")).librarySectionID).toBe(2);
    });

    it("throws MediaItemNotFoundError for a 200 carrying an empty MediaContainer", async () => {
      // A well-formed container holding no item is the server saying "gone".
      // It must THROW, not resolve undefined: enrichBatch in the full sync uses
      // Promise.allSettled so a rejection keeps the un-enriched bulk item, and a
      // resolved undefined would be written over it and abort the library sync.
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { MediaContainer: { size: 0 } } });
      await expect(client.getItemMetadata("123")).rejects.toBeInstanceOf(MediaItemNotFoundError);
    });

    it("throws a NON-not-found error for an unparseable response", async () => {
      // An empty body or a proxy's HTML/XML page is NOT evidence of deletion.
      // Conflating the two would let the incremental sync delete a live row —
      // cascading its RuleMatch, LifecycleException and WatchHistory rows.
      for (const data of ["", "<html>bad gateway</html>", null, { nope: true }]) {
        mockAxiosInstance.get.mockResolvedValueOnce({ data });
        const err = await client.getItemMetadata("123").catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(MediaItemNotFoundError);
        expect(err.message).toBe("Unrecognized Plex metadata response for 123 (no MediaContainer)");
      }
    });
  });

  describe("getAccounts", () => {
    it("returns account map", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Account: [
              { id: 1, name: "Admin" },
              { id: 2, name: "User1" },
            ],
          },
        },
      });
      const result = await client.getAccounts();
      expect(result).toEqual(new Map([[1, "Admin"], [2, "User1"]]));
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/accounts", { signal: undefined });
    });

    it("stays lenient on error, for the views that only decorate a name", async () => {
      // The per-item history panel and the excluded-users picker keep working
      // without names; only the watch-history sync needs the strict lookup.
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      const result = await client.getAccounts();
      expect(result.size).toBe(0);
    });
  });

  describe("listUsernames", () => {
    it("returns every account name the server knows, not just active streamers", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Account: [
              // id 0 is Plex's anonymous/local pseudo-account (blank name).
              { id: 0, name: "" },
              { id: 1, name: "Admin" },
              { id: 2, name: "User1" },
              { id: 3, name: "User2" },
            ],
          },
        },
      });
      const result = await client.listUsernames();
      // The blank anonymous account is dropped; everyone else is listed even
      // though none of them are currently streaming.
      expect(result).toEqual(["Admin", "User1", "User2"]);
    });

    it("returns empty array on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      const result = await client.listUsernames();
      expect(result).toEqual([]);
    });
  });

  describe("getWatchHistory", () => {
    /** Answers the item's history and `/accounts` by URL, as the two run in parallel. */
    function serveHistory(history: unknown[], accounts: unknown[]) {
      mockAxiosInstance.get.mockImplementation(async (url: string) => {
        if (url === "/status/sessions/history/all") return { data: { MediaContainer: { Metadata: history } } };
        if (url === "/accounts") return { data: { MediaContainer: { Account: accounts } } };
        throw new Error(`unexpected ${url}`);
      });
    }

    it("returns watch history with usernames", async () => {
      // Newest first, as the server sorts it.
      serveHistory(
        [
          { ratingKey: "123", accountID: 2, viewedAt: 1700001000 },
          { ratingKey: "123", accountID: 1, viewedAt: 1700000000 },
        ],
        [
          { id: 1, name: "Admin" },
          { id: 2, name: "User1" },
        ],
      );

      const result = await client.getWatchHistory("123");
      expect(result).toEqual([
        { username: "User1", watchedAt: "2023-11-14T22:30:00.000Z" },
        { username: "Admin", watchedAt: "2023-11-14T22:13:20.000Z" },
      ]);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/status/sessions/history/all", {
        params: { metadataItemID: "123", sort: "viewedAt:desc" },
      });
    });

    it("filters partial plays (below 90%)", async () => {
      serveHistory(
        [
          { ratingKey: "123", accountID: 1, viewedAt: 1700001000, viewOffset: 95000, duration: 100000 }, // 95% — full
          { ratingKey: "123", accountID: 1, viewedAt: 1700000000, viewOffset: 5000, duration: 100000 }, // 5% — partial
        ],
        [{ id: 1, name: "Admin" }],
      );

      const result = await client.getWatchHistory("123");
      expect(result).toEqual([{ username: "Admin", watchedAt: "2023-11-14T22:30:00.000Z" }]);
    });
  });

  describe("getCollections", () => {
    it("returns collections for section", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "100", title: "My Collection" }] } },
      });
      const result = await client.getCollections("1");
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("My Collection");
    });
  });

  describe("createCollection", () => {
    it("posts collection with correct uri", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "200", title: "New" }] } },
      });
      const result = await client.createCollection("1", "New", "machine-id", ["10", "20"], 1);
      expect(result.ratingKey).toBe("200");
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/library/collections",
        null,
        {
          params: {
            type: 1,
            title: "New",
            smart: 0,
            sectionId: "1",
            uri: "server://machine-id/com.plexapp.plugins.library/library/metadata/10,20",
          },
        }
      );
    });

    it("batches the create + remainder so the request URI can't overflow", async () => {
      // 120 keys with a batch size of 50 => create with the first 50, then two
      // PUT batches (50 + 20) for the remainder.
      const keys = Array.from({ length: 120 }, (_, i) => String(i + 1));
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "col", title: "Big" }] } },
      });
      mockAxiosInstance.put.mockResolvedValue({});

      await client.createCollection("1", "Big", "machine-id", keys, 1);

      const postUri = mockAxiosInstance.post.mock.calls[0][2].params.uri as string;
      expect(postUri.split("/metadata/")[1].split(",")).toHaveLength(50);
      // Remainder added via two PUT batches.
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(2);
      const secondBatch = mockAxiosInstance.put.mock.calls[1][2].params.uri as string;
      expect(secondBatch.split("/metadata/")[1].split(",")).toHaveLength(20);
    });
  });

  describe("addCollectionItems", () => {
    it("puts items with uri", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      await client.addCollectionItems("100", "machine-id", ["10", "20"]);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        "/library/collections/100/items",
        null,
        {
          params: {
            uri: "server://machine-id/com.plexapp.plugins.library/library/metadata/10,20",
          },
        }
      );
    });

    it("skips when ratingKeys is empty", async () => {
      await client.addCollectionItems("100", "machine-id", []);
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
    });

    it("splits a large add into batches of 50", async () => {
      const keys = Array.from({ length: 105 }, (_, i) => String(i + 1));
      mockAxiosInstance.put.mockResolvedValue({});

      await client.addCollectionItems("100", "machine-id", keys);

      // 105 keys => 50 + 50 + 5 => three PUT requests.
      expect(mockAxiosInstance.put).toHaveBeenCalledTimes(3);
      const batchSizes = mockAxiosInstance.put.mock.calls.map(
        (c) => (c[2].params.uri as string).split("/metadata/")[1].split(",").length,
      );
      expect(batchSizes).toEqual([50, 50, 5]);
    });
  });

  describe("removeCollectionItem", () => {
    it("deletes item from collection", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.removeCollectionItem("100", "50");
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        "/library/collections/100/children/50"
      );
    });
  });

  describe("deleteCollection", () => {
    it("deletes collection", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteCollection("100");
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/library/collections/100");
    });
  });

  describe("renameCollection", () => {
    it("puts new title with locked flag", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      await client.renameCollection("1", "100", "New Name");
      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        "/library/sections/1/all",
        null,
        {
          params: {
            type: 18,
            id: "100",
            "title.value": "New Name",
            "title.locked": 1,
          },
        }
      );
    });
  });

  describe("getSessions", () => {
    it("returns parsed sessions", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Test Movie",
                type: "movie",
                User: { id: "1", title: "Admin", thumb: "" },
                Player: { product: "Plex Web", platform: "Chrome", state: "playing", address: "127.0.0.1", local: true },
                Session: { id: "abc", bandwidth: 10000, location: "lan" },
                Media: [{ videoCodec: "h264", Part: [{ file: "/path/to/file.mkv" }] }],
              },
            ],
          },
        },
      });
      const result = await client.getSessions();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Test Movie");
      expect(result[0].player.product).toBe("Plex Web");
      expect(result[0].sessionId).toBe("abc");
    });

    it("carries an episode's season and episode numbers, so it can be named by show and SxxExx", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Pilot",
                type: "episode",
                parentTitle: "Season 1",
                grandparentTitle: "Breaking Bad",
                parentIndex: 1,
                index: 1,
                User: { id: "1", title: "Admin" },
                Player: { product: "Plex Web", platform: "Chrome", state: "playing" },
                Session: { id: "ep-session" },
              },
              {
                title: "Teardrop",
                type: "track",
                parentTitle: "Mezzanine",
                grandparentTitle: "Massive Attack",
                parentIndex: 1,
                index: 3,
                User: { id: "1", title: "Admin" },
                Player: { product: "Plexamp", platform: "iOS", state: "playing" },
                Session: { id: "track-session" },
              },
            ],
          },
        },
      });
      const [episode, track] = await client.getSessions();
      expect(episode).toMatchObject({ grandparentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1 });
      // A track's parentIndex/index are its disc and track numbers, not an SxxExx.
      expect(track.seasonNumber).toBeUndefined();
      expect(track.episodeNumber).toBeUndefined();
    });

    it("falls back to the item sessionKey when no Session element is present", async () => {
      // Plex omits the Session element for some clients; without a fallback the
      // sessionId was "" and multiple such sessions collided on one key.
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "No Session Elem",
                type: "movie",
                sessionKey: "42",
                ratingKey: "53912",
                User: { id: "1", title: "Admin" },
                Player: { product: "TV", platform: "Roku", state: "playing" },
                Media: [{ id: 98123, width: 3840, height: 2160, Part: [] }],
              },
            ],
          },
        },
      });
      const result = await client.getSessions();
      expect(result[0].sessionId).toBe("42");
      expect(result[0].ratingKey).toBe("53912");
      expect(result[0].mediaId).toBe("98123");
    });

    it("throws on error so callers can distinguish unreachable from no sessions", async () => {
      // Swallowing to [] made a hiccup look like "all streams ended", which
      // reset grace timers and mass-terminated grandfathered block_new_only
      // streams on recovery. Callers now treat a throw as "unreachable".
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      await expect(client.getSessions()).rejects.toThrow("fail");
    });

    it("handles sessions with TranscodeSession", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Movie",
                type: "movie",
                User: { id: "1", title: "Admin" },
                Player: { product: "TV", platform: "Roku", state: "playing" },
                Session: { id: "def" },
                TranscodeSession: {
                  videoDecision: "transcode",
                  audioDecision: "copy",
                  throttled: true,
                  speed: 2.5,
                },
                Media: [],
              },
            ],
          },
        },
      });
      const result = await client.getSessions();
      expect(result[0].transcoding).toBeDefined();
      expect(result[0].transcoding?.videoDecision).toBe("transcode");
      expect(result[0].transcoding?.throttled).toBe(true);
    });

    it("captures the acceleration APIs actually doing the work", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Movie",
                type: "movie",
                User: { id: "1", title: "Admin" },
                Player: { product: "TV", platform: "Roku", state: "playing" },
                Session: { id: "hw" },
                TranscodeSession: {
                  videoDecision: "transcode",
                  audioDecision: "transcode",
                  transcodeHwRequested: true,
                  transcodeHwDecoding: "vaapi",
                  transcodeHwEncoding: "vaapi",
                  transcodeHwFullPipeline: true,
                  speed: 0.8,
                },
                Media: [],
              },
            ],
          },
        },
      });

      const result = await client.getSessions();

      expect(result[0].transcoding?.hwDecode).toBe("vaapi");
      expect(result[0].transcoding?.hwEncode).toBe("vaapi");
      expect(result[0].transcoding?.hwFullPipeline).toBe(true);
      expect(result[0].transcoding?.speed).toBe(0.8);
    });

    // Plex sets transcodeHwRequested when it asks for hardware and then falls
    // back to software without saying so, which is why the decode/encode
    // fields are what the exemption reads.
    it("leaves the acceleration APIs unset when Plex fell back to software", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Movie",
                type: "movie",
                User: { id: "1", title: "Admin" },
                Player: { product: "TV", platform: "Roku", state: "playing" },
                Session: { id: "sw" },
                TranscodeSession: {
                  videoDecision: "transcode",
                  audioDecision: "copy",
                  transcodeHwRequested: true,
                },
                Media: [],
              },
            ],
          },
        },
      });

      const result = await client.getSessions();

      expect(result[0].transcoding?.transcodeHwRequested).toBe(true);
      expect(result[0].transcoding?.hwDecode).toBeUndefined();
      expect(result[0].transcoding?.hwEncode).toBeUndefined();
    });

    // A multi-version item reports every version; `selected` marks the copy
    // being played. Taking Media[0] blindly reported the wrong resolution and
    // file, which in turn fed the transcode manager's 4K criterion bad data.
    it("reads the selected media version, not the first one", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Multi-version Movie",
                type: "movie",
                User: { id: "1", title: "Admin" },
                Player: { product: "TV", platform: "Roku", state: "playing" },
                Session: { id: "multi" },
                Media: [
                  {
                    width: 1920,
                    height: 1080,
                    videoCodec: "h264",
                    videoResolution: "1080",
                    bitrate: 8000,
                    Part: [{ file: "/movies/Movie (2020) - 1080p.mkv" }],
                  },
                  {
                    selected: true,
                    width: 3840,
                    height: 2160,
                    videoCodec: "hevc",
                    videoResolution: "4k",
                    bitrate: 60000,
                    Part: [{ file: "/movies/Movie (2020) - 2160p.mkv" }],
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await client.getSessions();

      expect(result[0].mediaWidth).toBe(3840);
      expect(result[0].mediaHeight).toBe(2160);
      expect(result[0].videoCodec).toBe("hevc");
      expect(result[0].videoResolution).toBe("4k");
      expect(result[0].bitrate).toBe(60000);
      // The Part must come from the selected version too.
      expect(result[0].partFile).toBe("/movies/Movie (2020) - 2160p.mkv");
    });

    it("falls back to the first media version when none is marked selected", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                title: "Single-version Movie",
                type: "movie",
                User: { id: "1", title: "Admin" },
                Player: { product: "TV", platform: "Roku", state: "playing" },
                Session: { id: "single" },
                Media: [{ width: 1920, height: 1080, videoCodec: "h264", Part: [] }],
              },
            ],
          },
        },
      });

      const result = await client.getSessions();

      expect(result[0].mediaWidth).toBe(1920);
      expect(result[0].videoCodec).toBe("h264");
    });
  });

  describe("getItemMediaResolutions", () => {
    it("maps each Media version's source resolution by id", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              {
                Media: [
                  { id: 100, width: 3840, height: 2160 },
                  { id: 200, width: 1920, height: 1080 },
                  { id: 300, videoResolution: "720" },
                ],
              },
            ],
          },
        },
      });

      const map = await client.getItemMediaResolutions("rk1");

      expect(map.get("100")).toBe("4k");
      expect(map.get("200")).toBe("1080");
      expect(map.get("300")).toBe("720");
    });
  });

  describe("terminateSession", () => {
    it("posts terminate with reason", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.terminateSession("abc", "Test reason");
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/status/sessions/terminate",
        null,
        { params: { sessionId: "abc", reason: "Test reason" } }
      );
    });
  });

  describe("getImageUrl", () => {
    it("constructs URL with token", () => {
      const url = client.getImageUrl("/library/metadata/123/thumb");
      expect(url).toBe("http://plex:32400/library/metadata/123/thumb?X-Plex-Token=test-token");
    });
  });

  describe("fetchImage", () => {
    const imageResponse = (over: Record<string, unknown> = {}) => ({
      data: Buffer.from("image-data"),
      headers: { "content-type": "image/png" },
      ...over,
    });

    it("returns buffer and content type", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(imageResponse());
      const result = await client.fetchImage("/library/metadata/123/thumb");
      expect(result.contentType).toBe("image/png");
      expect(result.data).toEqual(Buffer.from("image-data"));
    });

    it("fetches the original path when no width is requested", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce(imageResponse());
      await client.fetchImage("/library/metadata/123/thumb");
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/library/metadata/123/thumb",
        expect.objectContaining({ responseType: "arraybuffer" }),
      );
    });

    // The breaker is shared with the job worker: a poster the transcoder was
    // slow to resize must not mark the server down for a sync reaching it fine.
    it("does not let an artwork failure mark the server unreachable", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(imageResponse());
      await client.fetchImage("/library/metadata/123/thumb", { width: 400 });
      for (const [, config] of mockAxiosInstance.get.mock.calls) {
        expect(config).toMatchObject({ __noBreakerMark: true });
      }
    });

    it("asks the photo transcoder to resize when a width is requested", async () => {
      // Server-side resize is the whole point: a grid-sized poster arrives as
      // tens of KB instead of the multi-megabyte original.
      mockAxiosInstance.get.mockResolvedValueOnce(imageResponse());
      await client.fetchImage("/library/metadata/123/thumb", { width: 400 });

      const url = mockAxiosInstance.get.mock.calls[0][0] as string;
      expect(url.startsWith("/photo/:/transcode?")).toBe(true);
      const params = new URLSearchParams(url.split("?")[1]);
      expect(params.get("url")).toBe("/library/metadata/123/thumb");
      expect(params.get("width")).toBe("400");
      // Square box + minSize=1 ("fill the box") guarantees at least `width` on
      // both axes for any source aspect ratio, so the local resize never
      // upscales; upscale=0 leaves a smaller source alone.
      expect(params.get("height")).toBe("400");
      expect(params.get("minSize")).toBe("1");
      expect(params.get("upscale")).toBe("0");
    });

    it("falls back to the original when the transcoder errors", async () => {
      // Older PMS builds, or a disabled transcoder, must not break artwork.
      mockAxiosInstance.get
        .mockRejectedValueOnce(new Error("404"))
        .mockResolvedValueOnce(imageResponse());

      const result = await client.fetchImage("/library/metadata/123/thumb", { width: 400 });

      expect(result.data).toBeInstanceOf(Buffer);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.get.mock.calls[1][0]).toBe("/library/metadata/123/thumb");
    });

    it("falls back when the transcoder answers with a non-image body", async () => {
      // An HTML error page must not be cached as artwork.
      mockAxiosInstance.get
        .mockResolvedValueOnce(imageResponse({ headers: { "content-type": "text/html" } }))
        .mockResolvedValueOnce(imageResponse());

      const result = await client.fetchImage("/library/metadata/123/thumb", { width: 400 });

      expect(result.contentType).toBe("image/png");
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it("falls back when the transcoder answers with an empty body", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(imageResponse({ data: Buffer.alloc(0) }))
        .mockResolvedValueOnce(imageResponse());

      await client.fetchImage("/library/metadata/123/thumb", { width: 400 });

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.get.mock.calls[1][0]).toBe("/library/metadata/123/thumb");
    });
  });

  describe("testConnection", () => {
    it("returns ok with server name", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { friendlyName: "My Plex Server" } },
      });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, serverName: "My Plex Server" });
    });

    it("returns error when no MediaContainer", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} });
      const result = await client.testConnection();
      expect(result).toEqual({
        ok: false,
        error: "This does not appear to be a Plex server — no MediaContainer in response",
      });
    });

    it("returns auth error on 401", async () => {
      const error = new Error("Unauthorized") as Error & { isAxiosError: boolean; response: { status: number }; code?: string; config?: Record<string, unknown> };
      error.isAxiosError = true;
      error.response = { status: 401 };
      mockAxiosInstance.get.mockRejectedValueOnce(error);
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "Authentication failed - invalid access token" });
    });

    it("returns ECONNREFUSED error", async () => {
      const error = new Error("connect ECONNREFUSED") as Error & { isAxiosError: boolean; code: string; response?: unknown; config?: Record<string, unknown> };
      error.isAxiosError = true;
      error.code = "ECONNREFUSED";
      mockAxiosInstance.get.mockRejectedValueOnce(error);
      const result = await client.testConnection();
      expect(result).toEqual({
        ok: false,
        error: "Connection refused - server may be offline or unreachable from this network",
      });
    });

    it("returns TLS error", async () => {
      const error = new Error("Hostname/IP does not match certificate's altnames") as Error & { isAxiosError: boolean; code: string; response?: unknown; config?: Record<string, unknown> };
      error.isAxiosError = true;
      error.code = "ERR_TLS_CERT_ALTNAME_MISMATCH";
      mockAxiosInstance.get.mockRejectedValueOnce(error);
      const result = await client.testConnection();
      expect(result).toEqual({
        ok: false,
        error:
          "TLS certificate verification failed - enable 'Skip TLS Verification' if using a self-signed certificate, or set NODE_EXTRA_CA_CERTS for a custom CA",
      });
    });
  });

  describe("preroll management", () => {
    it("getPrerollSetting returns current value", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Setting: [
              { id: "CinemaTrailersPrerollID", value: "/path/to/preroll.mp4" },
            ],
          },
        },
      });
      const result = await client.getPrerollSetting();
      expect(result).toBe("/path/to/preroll.mp4");
    });

    it("getPrerollSetting returns empty string when not found", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Setting: [] } },
      });
      const result = await client.getPrerollSetting();
      expect(result).toBe("");
    });

    it("setPrerollPath puts the path", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      await client.setPrerollPath("/new/preroll.mp4");
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/:/prefs", null, {
        params: { CinemaTrailersPrerollID: "/new/preroll.mp4" },
      });
    });

    it("clearPreroll sets empty string", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      await client.clearPreroll();
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/:/prefs", null, {
        params: { CinemaTrailersPrerollID: "" },
      });
    });
  });

  describe("getWatchlistGuids", () => {
    it("returns set of guids from watchlist", async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              { Guid: [{ id: "tmdb://123" }, { id: "imdb://tt456" }] },
              { Guid: [{ id: "tvdb://789" }] },
            ],
          },
        },
      });
      const result = await client.getWatchlistGuids();
      expect(result).toEqual(new Set(["tmdb://123", "imdb://tt456", "tvdb://789"]));
      // plex.tv, not the media server — with the account token.
      expect(axios.get).toHaveBeenCalledWith(
        "https://metadata.provider.plex.tv/library/sections/watchlist/all",
        expect.objectContaining({ headers: { "X-Plex-Token": "test-token", Accept: "application/json" } }),
      );
    });

    it("returns an empty set for an account with nothing watchlisted", async () => {
      // A real answer, distinct from a failure: this one legitimately clears
      // every watchlist flag.
      vi.mocked(axios.get).mockResolvedValueOnce({ data: { MediaContainer: {} } });
      const result = await client.getWatchlistGuids();
      expect(result).not.toBeNull();
      expect(result?.size).toBe(0);
    });

    it("returns null (not an empty set) when the fetch fails", async () => {
      // The sync writes every Plex item's isWatchlisted from this set, and an
      // empty set means "nothing is watchlisted". Returning it for a failed
      // fetch cleared the flag on every item the sync touched whenever plex.tv
      // was unreachable or the token had expired.
      vi.mocked(axios.get).mockRejectedValueOnce(new Error("fail"));
      const result = await client.getWatchlistGuids();
      expect(result).toBeNull();
    });
  });

  describe("getDevices", () => {
    it("returns device map", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Device: [
              { id: 1, name: "Roku", platform: "Roku" },
              { id: 2, name: "iPhone", platform: "iOS" },
            ],
          },
        },
      });
      const result = await client.getDevices();
      expect(result.get(1)).toEqual({ name: "Roku", platform: "Roku" });
      expect(result.get(2)).toEqual({ name: "iPhone", platform: "iOS" });
    });

    it("returns empty map on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      const result = await client.getDevices();
      expect(result.size).toBe(0);
    });
  });
  describe("getDetailedWatchHistory", () => {
    const page = (metadata: unknown[]) => ({
      data: { MediaContainer: { Metadata: metadata, totalSize: metadata.length } },
    });
    const emptyContainer = { data: { MediaContainer: {} } };

    it("fetches the whole history when no `since` is given", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer) // /accounts
        .mockResolvedValueOnce(emptyContainer) // /devices
        .mockResolvedValueOnce(page([{ ratingKey: "1", viewedAt: 1700000000, accountID: 1 }]));

      const entries = await client.getDetailedWatchHistory();

      // No account or device answers: the play is kept, unnamed and unlabelled.
      expect(entries).toEqual([
        { ratingKey: "1", username: "Unknown", watchedAt: "2023-11-14T22:13:20.000Z", deviceName: null, platform: null },
      ]);
      const historyCall = mockAxiosInstance.get.mock.calls.find((c) =>
        String(c[0]).startsWith("/status/sessions/history/all"),
      )!;
      expect(historyCall[0]).toBe("/status/sessions/history/all");
    });

    // The pager behind it: a short page is the end only when the container
    // reports no total, or the total has been reached.
    it("keeps paging past a short page while totalSize says more remain", async () => {
      // A server that caps the page below the 5,000 asked for must not
      // truncate the history to its first page: the native watch-history sync
      // commits whatever this returns with a full replace.
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer) // /accounts
        .mockResolvedValueOnce(emptyContainer) // /devices
        .mockResolvedValueOnce({
          data: { MediaContainer: { totalSize: 3, Metadata: [{ ratingKey: "1", viewedAt: 1 }, { ratingKey: "2", viewedAt: 2 }] } },
        })
        .mockResolvedValueOnce({
          data: { MediaContainer: { totalSize: 3, Metadata: [{ ratingKey: "3", viewedAt: 3 }] } },
        });

      const entries = await client.getDetailedWatchHistory();
      expect(entries.map((e) => e.ratingKey)).toEqual(["1", "2", "3"]);
      const pages = mockAxiosInstance.get.mock.calls.filter((c) => String(c[0]).startsWith("/status/sessions/history/all"));
      expect(pages).toHaveLength(2);
      // The second request starts where the first page actually ended.
      expect(pages[1][1].params["X-Plex-Container-Start"]).toBe(2);
    });

    it("stops on a short page when the server reports no total", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer) // /accounts
        .mockResolvedValueOnce(emptyContainer) // /devices
        .mockResolvedValueOnce({ data: { MediaContainer: { Metadata: [{ ratingKey: "1", viewedAt: 1 }] } } });
      const entries = await client.getDetailedWatchHistory();
      expect(entries).toHaveLength(1);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
    });

    it("asks for another page when a page with no total is full", async () => {
      const page1 = Array.from({ length: 5000 }, (_, i) => ({ ratingKey: String(i), viewedAt: 1700000000 + i }));
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer) // /accounts
        .mockResolvedValueOnce(emptyContainer) // /devices
        .mockResolvedValueOnce({ data: { MediaContainer: { Metadata: page1 } } })
        .mockResolvedValueOnce({ data: { MediaContainer: { Metadata: [] } } });

      const entries = await client.getDetailedWatchHistory();
      expect(entries).toHaveLength(5000);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(4);
    });

    it("passes the cancel signal to every request it makes", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer) // /accounts
        .mockResolvedValueOnce(emptyContainer) // /devices
        .mockResolvedValueOnce(page([{ ratingKey: "1", viewedAt: 1700000000 }]));
      const signal = new AbortController().signal;

      await client.getDetailedWatchHistory({ signal });

      for (const [, config] of mockAxiosInstance.get.mock.calls) expect(config.signal).toBe(signal);
    });

    it("stops before the next page once the signal has fired", async () => {
      const controller = new AbortController();
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer)
        .mockImplementationOnce(async () => {
          controller.abort();
          return emptyContainer;
        });

      await expect(client.getDetailedWatchHistory({ signal: controller.signal })).rejects.toThrow();
      expect(mockAxiosInstance.get.mock.calls.some((c) => String(c[0]).startsWith("/status/sessions/history/all"))).toBe(false);
    });

    it("carries the play's library section, which places a rating key two libraries hold", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer) // /accounts
        .mockResolvedValueOnce(emptyContainer) // /devices
        .mockResolvedValueOnce(
          page([
            { ratingKey: "1", viewedAt: 1700000000, librarySectionID: 2 },
            { ratingKey: "1", viewedAt: 1700000060, librarySectionID: "3" },
          ]),
        );

      const entries = await client.getDetailedWatchHistory();

      expect(entries.map((e) => e.librarySectionId)).toEqual(["2", "3"]);
    });

    it("fails instead of filing every play under \"Unknown\" when /accounts cannot be read", async () => {
      // Every play is attributed through the account map. Answering a failed
      // `/accounts` with an empty map made the native full replace rewrite the
      // whole stored history under "Unknown" (and mark it established), and made
      // the incremental append store each play in its overlap a second time
      // under the other name — a permanent playCount inflation. A throw sends
      // the sync down its "leave the stored history intact" path instead.
      mockAxiosInstance.get
        .mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 500"), { response: { status: 500 } }))
        .mockResolvedValueOnce(emptyContainer);

      await expect(client.getDetailedWatchHistory()).rejects.toThrow("status code 500");
      // The history itself is never paged.
      expect(
        mockAxiosInstance.get.mock.calls.some((c) => String(c[0]).startsWith("/status/sessions/history/all")),
      ).toBe(false);
    });

    it("fails on an /accounts answer that is not an account container", async () => {
      // A proxy's HTML page or an error document parses to no MediaContainer —
      // just as unusable as a failed request.
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: "<html>sign in</html>" })
        .mockResolvedValueOnce(emptyContainer);

      await expect(client.getDetailedWatchHistory()).rejects.toThrow(/accounts/);
    });

    it("names each play by its account", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { MediaContainer: { Account: [{ id: 1, name: "alice" }] } } })
        .mockResolvedValueOnce({ data: { MediaContainer: { Device: [{ id: 7, name: "Living Room TV", platform: "Roku" }] } } })
        .mockResolvedValueOnce(page([{ ratingKey: "1", viewedAt: 1700000000, accountID: 1, deviceID: 7 }]));

      const entries = await client.getDetailedWatchHistory();

      expect(entries).toEqual([
        { ratingKey: "1", username: "alice", watchedAt: "2023-11-14T22:13:20.000Z", deviceName: "Living Room TV", platform: "Roku" },
      ]);
    });

    it("puts the `viewedAt>=` filter in the URL verbatim for an incremental fetch", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce(emptyContainer)
        .mockResolvedValueOnce(emptyContainer)
        .mockResolvedValueOnce(page([{ ratingKey: "1", viewedAt: 1700000500, accountID: 1 }]));

      await client.getDetailedWatchHistory({ since: new Date(1700000000 * 1000 + 999) });

      const historyCall = mockAxiosInstance.get.mock.calls.find((c) =>
        String(c[0]).startsWith("/status/sessions/history/all"),
      )!;
      // Epoch seconds, floored, and NOT in `params`: axios percent-encodes
      // `>=` there and Plex then ignores the filter and returns everything.
      expect(historyCall[0]).toBe("/status/sessions/history/all?viewedAt>=1700000000");
      expect(historyCall[1].params).not.toHaveProperty("viewedAt>=");
      expect(historyCall[1].params).toMatchObject({ sort: "viewedAt:desc" });
    });
  });
});
