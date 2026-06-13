import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AxiosRequestConfig } from "axios";

// NOTE: src/lib/emby/types.ts was deleted (it was dead code) — do not import from it.

const { mockFakeClient, mockAxiosCreate, requestInterceptors } = vi.hoisted(() => {
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
    mockFakeClient: fakeClient,
    mockAxiosCreate: vi.fn(() => fakeClient),
    requestInterceptors,
  };
});

vi.mock("axios", () => ({
  default: {
    create: mockAxiosCreate,
    isAxiosError: vi.fn(() => false),
  },
}));

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

import { EmbyClient } from "@/lib/emby/client";

describe("EmbyClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestInterceptors.length = 0;
  });

  it("constructs and trims the base URL", () => {
    const client = new EmbyClient("http://emby:8096//", "emby-token");
    expect(client).toBeInstanceOf(EmbyClient);
    const config = (mockAxiosCreate.mock.calls[0] as unknown[])[0] as { baseURL: string };
    expect(config.baseURL).toBe("http://emby:8096");
  });

  it("passes the X-Emby-Token auth header via the request interceptor", () => {
    new EmbyClient("http://emby:8096", "emby-token");
    expect(requestInterceptors.length).toBe(1);

    const config = { headers: {} as Record<string, string> };
    requestInterceptors[0](config);
    expect(config.headers["X-Emby-Token"]).toBe("emby-token");
  });

  it("uses 'Emby' as the log prefix via the request debug log", async () => {
    const { logger } = await import("@/lib/logger");
    new EmbyClient("http://emby:8096", "emby-token");

    requestInterceptors[0]({ headers: {}, method: "get", url: "/Items" });
    expect(logger.debug).toHaveBeenCalledWith("Emby", expect.stringContaining("GET /Items"));
  });

  describe("getItemMetadata", () => {
    it("resolves the user id then fetches /Users/{userId}/Items/{id}", async () => {
      const client = new EmbyClient("http://emby:8096", "emby-token");

      // getUserId(): /Users/Me succeeds (cached afterwards).
      mockFakeClient.get.mockResolvedValueOnce({ data: { Id: "user-1" } });
      // The metadata fetch.
      mockFakeClient.get.mockResolvedValueOnce({
        data: { Id: "abc", Name: "Inception", Type: "Movie", ProductionYear: 2010 },
      });

      const result = await client.getItemMetadata("abc");

      expect(mockFakeClient.get).toHaveBeenNthCalledWith(1, "/Users/Me");
      expect(mockFakeClient.get).toHaveBeenNthCalledWith(
        2,
        "/Users/user-1/Items/abc",
        { params: { Fields: expect.any(String) } },
      );
      // normalizeItem maps Jellyfin/Emby shape → MediaMetadataItem.
      expect(result.ratingKey).toBe("abc");
      expect(result.title).toBe("Inception");
      expect(result.type).toBe("movie");
      expect(result.year).toBe(2010);
    });

    it("falls back to /Users list when /Users/Me fails", async () => {
      const client = new EmbyClient("http://emby:8096", "emby-token");

      // /Users/Me throws (Emby returns 500), fallback to /Users list.
      mockFakeClient.get.mockRejectedValueOnce(new Error("Unrecognized Guid format"));
      mockFakeClient.get.mockResolvedValueOnce({
        data: [
          { Id: "u-regular", Name: "Regular", Policy: { IsAdministrator: false } },
          { Id: "u-admin", Name: "Admin", Policy: { IsAdministrator: true } },
        ],
      });
      // The metadata fetch with the admin user id.
      mockFakeClient.get.mockResolvedValueOnce({
        data: { Id: "xyz", Name: "Dune", Type: "Movie" },
      });

      const result = await client.getItemMetadata("xyz");

      expect(mockFakeClient.get).toHaveBeenNthCalledWith(1, "/Users/Me");
      expect(mockFakeClient.get).toHaveBeenNthCalledWith(2, "/Users");
      expect(mockFakeClient.get).toHaveBeenNthCalledWith(
        3,
        "/Users/u-admin/Items/xyz",
        { params: { Fields: expect.any(String) } },
      );
      expect(result.title).toBe("Dune");
    });
  });

  describe("getWatchHistory", () => {
    it("emits one entry per play count across users, sorted newest first", async () => {
      const client = new EmbyClient("http://emby:8096", "emby-token");

      // /Users list
      mockFakeClient.get.mockResolvedValueOnce({
        data: [
          { Id: "u1", Name: "Alice" },
          { Id: "u2", Name: "Bob" },
        ],
      });
      // Alice's item: 2 plays, last played 2024-01-02
      mockFakeClient.get.mockResolvedValueOnce({
        data: { UserData: { PlayCount: 2, LastPlayedDate: "2024-01-02T00:00:00.000Z" } },
      });
      // Bob's item: 1 play, last played 2024-03-01 (newer)
      mockFakeClient.get.mockResolvedValueOnce({
        data: { UserData: { PlayCount: 1, LastPlayedDate: "2024-03-01T00:00:00.000Z" } },
      });

      const entries = await client.getWatchHistory("item-1");

      // 2 (Alice) + 1 (Bob) = 3 entries
      expect(entries).toHaveLength(3);
      // First entry has a timestamp; sorted so Bob's newer play is first.
      expect(entries[0]).toEqual({
        username: "Bob",
        watchedAt: "2024-03-01T00:00:00.000Z",
      });
      // Alice's first play carries her LastPlayedDate; the second is null.
      const aliceEntries = entries.filter((e) => e.username === "Alice");
      expect(aliceEntries).toHaveLength(2);
      expect(aliceEntries.map((e) => e.watchedAt).sort()).toEqual([
        "2024-01-02T00:00:00.000Z",
        null,
      ].sort());

      expect(mockFakeClient.get).toHaveBeenNthCalledWith(1, "/Users");
      expect(mockFakeClient.get).toHaveBeenNthCalledWith(2, "/Users/u1/Items/item-1");
      expect(mockFakeClient.get).toHaveBeenNthCalledWith(3, "/Users/u2/Items/item-1");
    });

    it("skips users whose item fetch fails and ignores zero play counts", async () => {
      const client = new EmbyClient("http://emby:8096", "emby-token");

      mockFakeClient.get.mockResolvedValueOnce({
        data: [
          { Id: "u1", Name: "Alice" },
          { Id: "u2", Name: "Bob" },
        ],
      });
      // Alice: zero plays → no entries
      mockFakeClient.get.mockResolvedValueOnce({
        data: { UserData: { PlayCount: 0 } },
      });
      // Bob: fetch throws → skipped
      mockFakeClient.get.mockRejectedValueOnce(new Error("403"));

      const entries = await client.getWatchHistory("item-1");
      expect(entries).toEqual([]);
    });

    it("returns an empty array when the /Users list request throws", async () => {
      const client = new EmbyClient("http://emby:8096", "emby-token");
      mockFakeClient.get.mockRejectedValueOnce(new Error("network"));

      const entries = await client.getWatchHistory("item-1");
      expect(entries).toEqual([]);
    });
  });
});
