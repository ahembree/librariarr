import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/http-retry", () => ({
  configureRetry: vi.fn(),
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

import { PlexClient } from "@/lib/plex/client";

describe("PlexClient", () => {
  let client: PlexClient;

  beforeEach(() => {
    vi.clearAllMocks();
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

    it("fetches paginated items with track type", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [], size: 0 } },
      });
      const result = await client.getLibraryItemsPage("3", "track", 0, 50);
      expect(result.total).toBe(0);
    });

    it("fetches paginated items for movie type (no type param)", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { MediaContainer: { Metadata: [{ ratingKey: "1" }] } },
      });
      const result = await client.getLibraryItemsPage("1", "movie", 10, 25);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1); // falls back to items.length
      const callParams = mockAxiosInstance.get.mock.calls[0][1].params;
      expect(callParams.type).toBeUndefined();
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
      expect(result.get(1)).toBe("Admin");
      expect(result.get(2)).toBe("User1");
    });

    it("returns empty map on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      const result = await client.getAccounts();
      expect(result.size).toBe(0);
    });
  });

  describe("getWatchHistory", () => {
    it("returns watch history with usernames", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            MediaContainer: {
              Metadata: [
                { accountID: 1, viewedAt: 1700000000 },
                { accountID: 2, viewedAt: 1700001000 },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            MediaContainer: {
              Account: [
                { id: 1, name: "Admin" },
                { id: 2, name: "User1" },
              ],
            },
          },
        });

      const result = await client.getWatchHistory("123");
      expect(result).toHaveLength(2);
      expect(result[0].username).toBe("Admin");
      expect(result[0].watchedAt).toBeTruthy();
    });

    it("filters partial plays (below 90%)", async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            MediaContainer: {
              Metadata: [
                { accountID: 1, viewedAt: 1700000000, viewOffset: 5000, duration: 100000 }, // 5% — partial
                { accountID: 1, viewedAt: 1700001000, viewOffset: 95000, duration: 100000 }, // 95% — full
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: { MediaContainer: { Account: [{ id: 1, name: "Admin" }] } },
        });

      const result = await client.getWatchHistory("123");
      expect(result).toHaveLength(1);
    });
  });

  describe("getWatchCounts", () => {
    it("aggregates watch counts by ratingKey", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              { ratingKey: "1", viewedAt: 1700000000 },
              { ratingKey: "1", viewedAt: 1700001000 },
              { ratingKey: "2", viewedAt: 1700002000 },
            ],
          },
        },
      });

      const result = await client.getWatchCounts();
      expect(result.get("1")?.count).toBe(2);
      expect(result.get("2")?.count).toBe(1);
      expect(result.get("1")?.lastWatchedAt).toBe(1700001000);
    });

    it("filters partial plays from counts", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          MediaContainer: {
            Metadata: [
              { ratingKey: "1", viewedAt: 1700000000, viewOffset: 100, duration: 1000 }, // 10% — skip
              { ratingKey: "1", viewedAt: 1700001000 }, // no viewOffset — count it
            ],
          },
        },
      });

      const result = await client.getWatchCounts();
      expect(result.get("1")?.count).toBe(1);
    });

    it("returns empty map on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      const result = await client.getWatchCounts();
      expect(result.size).toBe(0);
    });

    it("paginates when metadata length equals PAGE_SIZE", async () => {
      // First page: 5000 items (full page)
      const page1 = Array.from({ length: 5000 }, (_, i) => ({
        ratingKey: String(i),
        viewedAt: 1700000000 + i,
      }));
      // Second page: empty (end of data)
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { MediaContainer: { Metadata: page1 } } })
        .mockResolvedValueOnce({ data: { MediaContainer: { Metadata: [] } } });

      const result = await client.getWatchCounts();
      expect(result.size).toBe(5000);
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
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

    it("returns empty array on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
      const result = await client.getSessions();
      expect(result).toEqual([]);
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
    it("returns buffer and content type", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: Buffer.from("image-data"),
        headers: { "content-type": "image/png" },
      });
      const result = await client.fetchImage("/library/metadata/123/thumb");
      expect(result.contentType).toBe("image/png");
      expect(result.data).toBeInstanceOf(Buffer);
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
      expect(result.ok).toBe(false);
      expect(result.error).toContain("does not appear to be a Plex server");
    });

    it("returns auth error on 401", async () => {
      const error = new Error("Unauthorized") as Error & { isAxiosError: boolean; response: { status: number }; code?: string; config?: Record<string, unknown> };
      error.isAxiosError = true;
      error.response = { status: 401 };
      mockAxiosInstance.get.mockRejectedValueOnce(error);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Authentication failed");
    });

    it("returns ECONNREFUSED error", async () => {
      const error = new Error("connect ECONNREFUSED") as Error & { isAxiosError: boolean; code: string; response?: unknown; config?: Record<string, unknown> };
      error.isAxiosError = true;
      error.code = "ECONNREFUSED";
      mockAxiosInstance.get.mockRejectedValueOnce(error);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Connection refused");
    });

    it("returns TLS error", async () => {
      const error = new Error("certificate has expired") as Error & { isAxiosError: boolean; code: string; response?: unknown; config?: Record<string, unknown> };
      error.isAxiosError = true;
      error.code = "ERR_TLS_CERT_ALTNAME_MISMATCH";
      mockAxiosInstance.get.mockRejectedValueOnce(error);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("TLS certificate");
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
      const { default: axios } = await import("axios");
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
      expect(result.has("tmdb://123")).toBe(true);
      expect(result.has("imdb://tt456")).toBe(true);
      expect(result.has("tvdb://789")).toBe(true);
    });

    it("returns empty set on error", async () => {
      const { default: axios } = await import("axios");
      vi.mocked(axios.get).mockRejectedValueOnce(new Error("fail"));
      const result = await client.getWatchlistGuids();
      expect(result.size).toBe(0);
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
});
