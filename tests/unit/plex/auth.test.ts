import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = {
  systemConfig: {
    upsert: vi.fn(),
  },
};

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockAxiosGet = vi.fn();
const mockAxiosPost = vi.fn();

vi.mock("axios", () => ({
  default: {
    get: mockAxiosGet,
    post: mockAxiosPost,
  },
}));

// Must clear the cached client ID between tests since the module caches it
let createPlexPin: typeof import("@/lib/plex/auth").createPlexPin;
let checkPlexPin: typeof import("@/lib/plex/auth").checkPlexPin;
let getPlexUser: typeof import("@/lib/plex/auth").getPlexUser;
let getPlexResources: typeof import("@/lib/plex/auth").getPlexResources;
let getPlexFriends: typeof import("@/lib/plex/auth").getPlexFriends;
let getPlexAuthUrl: typeof import("@/lib/plex/auth").getPlexAuthUrl;
let getPlexClientId: typeof import("@/lib/plex/auth").getPlexClientId;
let PLEX_PRODUCT: string;
let PLEX_VERSION: string;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset module to clear cachedClientId
  vi.resetModules();

  // Re-mock after resetModules
  vi.doMock("@/lib/db", () => ({ prisma: mockPrisma }));
  vi.doMock("@/lib/logger", () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock("axios", () => ({
    default: { get: mockAxiosGet, post: mockAxiosPost },
  }));

  const auth = await import("@/lib/plex/auth");
  createPlexPin = auth.createPlexPin;
  checkPlexPin = auth.checkPlexPin;
  getPlexUser = auth.getPlexUser;
  getPlexResources = auth.getPlexResources;
  getPlexFriends = auth.getPlexFriends;
  getPlexAuthUrl = auth.getPlexAuthUrl;
  getPlexClientId = auth.getPlexClientId;
  PLEX_PRODUCT = auth.PLEX_PRODUCT;
  PLEX_VERSION = auth.PLEX_VERSION;
});

describe("Plex Auth", () => {
  describe("getPlexClientId", () => {
    it("upserts and returns client ID from database", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        id: "singleton",
        plexClientId: "test-uuid-123",
      });
      const result = await getPlexClientId();
      expect(result).toBe("test-uuid-123");
      expect(mockPrisma.systemConfig.upsert).toHaveBeenCalledWith({
        where: { id: "singleton" },
        create: expect.objectContaining({ id: "singleton" }),
        update: {},
      });
    });

    it("caches the client ID on subsequent calls", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        id: "singleton",
        plexClientId: "cached-uuid",
      });
      const first = await getPlexClientId();
      const second = await getPlexClientId();
      expect(first).toBe("cached-uuid");
      expect(second).toBe("cached-uuid");
      expect(mockPrisma.systemConfig.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe("constants", () => {
    it("exports correct product name", () => {
      expect(PLEX_PRODUCT).toBe("Librariarr");
    });

    it("exports version string", () => {
      expect(PLEX_VERSION).toBeTruthy();
    });
  });

  describe("createPlexPin", () => {
    it("posts to plex.tv and returns pin data", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      const pinData = { id: 123, code: "ABC123", authToken: null };
      mockAxiosPost.mockResolvedValueOnce({ data: pinData });

      const result = await createPlexPin();
      expect(result).toEqual(pinData);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        "https://plex.tv/api/v2/pins",
        { strong: true },
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Plex-Product": "Librariarr",
            "X-Plex-Client-Identifier": "client-id",
          }),
        })
      );
    });
  });

  describe("checkPlexPin", () => {
    it("checks pin status without code", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      const pinData = { id: 123, code: "ABC", authToken: "token-123" };
      mockAxiosGet.mockResolvedValueOnce({ data: pinData });

      const result = await checkPlexPin(123);
      expect(result).toEqual(pinData);
      expect(mockAxiosGet).toHaveBeenCalledWith(
        "https://plex.tv/api/v2/pins/123",
        expect.objectContaining({
          params: undefined,
        })
      );
    });

    it("checks pin status with code", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      mockAxiosGet.mockResolvedValueOnce({ data: { id: 123 } });

      await checkPlexPin(123, "CODE");
      expect(mockAxiosGet).toHaveBeenCalledWith(
        "https://plex.tv/api/v2/pins/123",
        expect.objectContaining({
          params: { code: "CODE" },
        })
      );
    });
  });

  describe("getPlexUser", () => {
    it("fetches user with auth token", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      const userData = { id: 1, username: "testuser", email: "test@example.com" };
      mockAxiosGet.mockResolvedValueOnce({ data: userData });

      const result = await getPlexUser("auth-token-123");
      expect(result).toEqual(userData);
      expect(mockAxiosGet).toHaveBeenCalledWith(
        "https://plex.tv/api/v2/user",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Plex-Token": "auth-token-123",
          }),
        })
      );
    });
  });

  describe("getPlexResources", () => {
    it("fetches resources with includeHttps", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      const resources = [{ name: "Server1", clientIdentifier: "abc" }];
      mockAxiosGet.mockResolvedValueOnce({ data: resources });

      const result = await getPlexResources("auth-token");
      expect(result).toEqual(resources);
      expect(mockAxiosGet).toHaveBeenCalledWith(
        "https://plex.tv/api/v2/resources",
        expect.objectContaining({
          params: { includeHttps: 1, includeRelay: 0 },
        })
      );
    });
  });

  describe("getPlexFriends", () => {
    it("returns array of friend usernames", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      mockAxiosGet.mockResolvedValueOnce({
        data: [
          { username: "friend1", title: "Friend 1" },
          { username: "friend2" },
          { title: "friend3" },
        ],
      });

      const result = await getPlexFriends("auth-token");
      expect(result).toEqual(["friend1", "friend2", "friend3"]);
    });

    it("returns empty array on error", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      mockAxiosGet.mockRejectedValueOnce(new Error("fail"));
      const result = await getPlexFriends("auth-token");
      expect(result).toEqual([]);
    });

    it("filters out empty usernames", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "client-id",
      });
      mockAxiosGet.mockResolvedValueOnce({
        data: [
          { username: "friend1" },
          { username: "", title: "" },
          {},
        ],
      });
      const result = await getPlexFriends("auth-token");
      expect(result).toEqual(["friend1"]);
    });
  });

  describe("getPlexAuthUrl", () => {
    it("constructs auth URL with params", async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValueOnce({
        plexClientId: "my-client-id",
      });

      const url = await getPlexAuthUrl("PIN-CODE");
      expect(url).toContain("https://app.plex.tv/auth#?");
      expect(url).toContain("clientID=my-client-id");
      expect(url).toContain("code=PIN-CODE");
      expect(url).toContain("context%5Bdevice%5D%5Bproduct%5D=Librariarr");
    });
  });
});
