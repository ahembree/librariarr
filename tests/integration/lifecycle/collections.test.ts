import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock PlexClient (used by apply and visibility routes)
vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      getCollections: vi.fn().mockResolvedValue([]),
      syncCollection: vi.fn().mockResolvedValue(undefined),
      removePlexCollection: vi.fn().mockResolvedValue(undefined),
      renameCollection: vi.fn().mockResolvedValue(undefined),
      getCollectionVisibility: vi.fn().mockResolvedValue({ home: false, recommended: false }),
    };
  }),
}));

// Mock lifecycle collections module (used by apply and sync routes)
const { mockSyncPlexCollection, mockRemovePlexCollection } = vi.hoisted(() => ({
  mockSyncPlexCollection: vi.fn().mockResolvedValue(undefined),
  mockRemovePlexCollection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/lifecycle/collections", () => ({
  syncPlexCollection: mockSyncPlexCollection,
  removePlexCollection: mockRemovePlexCollection,
}));

// Mock Arr clients (not directly used, but the rules engine import chain may pull them)
vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return {
      getMovies: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      getSeries: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      getArtists: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Import AFTER mocks
import { POST as applyPost } from "@/app/api/lifecycle/collections/apply/route";
import { POST as syncPost } from "@/app/api/lifecycle/collections/sync/route";
import { GET as visibilityGet } from "@/app/api/lifecycle/collections/visibility/route";

describe("Lifecycle Collections", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    // Reset collection mocks to clear any unconsumed mockRejectedValueOnce queues
    mockSyncPlexCollection.mockReset();
    mockSyncPlexCollection.mockResolvedValue(undefined);
    mockRemovePlexCollection.mockReset();
    mockRemovePlexCollection.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- POST /api/lifecycle/collections/apply ----

  describe("POST /api/lifecycle/collections/apply", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: { ruleSetId: "some-id" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when ruleSetId is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: {},
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: { ruleSetId: "nonexistent" },
      });

      await expectJson(response, 404);
    });

    it("returns success with no changes when collection is not enabled", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "No Collection",
        type: "MOVIE",
        collectionEnabled: false,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
      expect(body.success).toBe(true);
      expect(body.changes).toHaveLength(0);
    });

    it("removes collection when previousCollectionEnabled but now disabled", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Disabled Collection",
        type: "MOVIE",
        collectionEnabled: false,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          previousCollectionEnabled: true,
          previousCollectionName: "Old Collection",
        },
      });

      const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
      expect(body.success).toBe(true);
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0]).toContain("Removed");
      expect(mockRemovePlexCollection).toHaveBeenCalledWith(
        user.id,
        "MOVIE",
        "Old Collection"
      );
    });

    it("returns success with no changes when collection is enabled but no rename/removal needed", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      const ruleSet = await createTestRuleSet(user.id, {
        name: "Collection Sync",
        type: "MOVIE",
        collectionEnabled: true,
        collectionName: "My Collection",
        rules: [
          {
            id: "r1",
            field: "playCount",
            operator: "equals",
            value: 0,
            condition: "AND",
          },
        ],
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      // Apply route only handles rename/removal — item syncing is done by the sync route
      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
      expect(body.success).toBe(true);
      expect(body.changes).toHaveLength(0);
      expect(mockSyncPlexCollection).not.toHaveBeenCalled();
    });

    it("returns 404 for another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const ruleSet = await createTestRuleSet(user1.id, {
        name: "Private Collection",
        collectionEnabled: true,
        collectionName: "Secret",
      });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      await expectJson(response, 404);
    });

    it("returns 500 when Plex removal fails", async () => {
      mockRemovePlexCollection.mockRejectedValueOnce(new Error("Plex connection refused"));

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      // Collection is now disabled but was previously enabled — triggers removal
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Failing Collection",
        type: "MOVIE",
        collectionEnabled: false,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(applyPost, {
        url: "/api/lifecycle/collections/apply",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          previousCollectionEnabled: true,
          previousCollectionName: "Old Collection",
        },
      });

      const body = await expectJson<{ error: string }>(response, 500);
      expect(body.error).toContain("Plex connection refused");
    });
  });

  // ---- POST /api/lifecycle/collections/sync ----

  describe("POST /api/lifecycle/collections/sync", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { ruleSetId: "some-id" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when ruleSetId is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: {},
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { ruleSetId: "nonexistent" },
      });

      await expectJson(response, 404);
    });

    it("returns 400 when collection sync is not enabled", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "No Collection",
        type: "MOVIE",
        collectionEnabled: false,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("not enabled");
    });

    it("syncs collection and returns match count", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(library.id, {
        title: "Movie A",
        type: "MOVIE",
        playCount: 0,
      });
      await createTestMediaItem(library.id, {
        title: "Movie B",
        type: "MOVIE",
        playCount: 0,
      });

      const ruleSet = await createTestRuleSet(user.id, {
        name: "Sync Test",
        type: "MOVIE",
        collectionEnabled: true,
        collectionName: "Synced Collection",
        rules: [
          {
            id: "r1",
            field: "playCount",
            operator: "equals",
            value: 0,
            condition: "AND",
          },
        ],
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{
        success: boolean;
        matchedCount: number;
        collectionName: string;
      }>(response, 200);

      expect(body.success).toBe(true);
      expect(body.matchedCount).toBe(2);
      expect(body.collectionName).toBe("Synced Collection");
      expect(mockSyncPlexCollection).toHaveBeenCalled();
    });

    it("returns 404 for another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const ruleSet = await createTestRuleSet(user1.id, {
        name: "Private Sync",
        collectionEnabled: true,
        collectionName: "Secret Sync",
      });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      await expectJson(response, 404);
    });

    it("returns 400 when all rules are disabled (safety guard)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "All Disabled",
        type: "MOVIE",
        collectionEnabled: true,
        collectionName: "Dangerous Collection",
        rules: [
          {
            id: "g1",
            condition: "AND",
            rules: [
              { id: "r1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND", enabled: false },
            ],
            groups: [],
          },
        ],
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("No active rules to evaluate");
      // Ensure syncPlexCollection was NOT called
      expect(mockSyncPlexCollection).not.toHaveBeenCalled();
    });
  });

  // ---- GET /api/lifecycle/collections/visibility ----

  describe("GET /api/lifecycle/collections/visibility", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
        searchParams: { ruleSetId: "some-id" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when ruleSetId is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("ruleSetId");
    });

    it("returns defaults when rule set has no collection name", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "No Collection Name",
        collectionEnabled: false,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
        searchParams: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
      expect(body.home).toBe(false);
      expect(body.recommended).toBe(false);
    });

    it("returns defaults when rule set does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
        searchParams: { ruleSetId: "nonexistent" },
      });

      const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
      expect(body.home).toBe(false);
      expect(body.recommended).toBe(false);
    });

    it("returns defaults when no libraries exist for user", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "With Collection",
        type: "MOVIE",
        collectionEnabled: true,
        collectionName: "Test",
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
        searchParams: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
      expect(body.home).toBe(false);
      expect(body.recommended).toBe(false);
    });

    it("queries Plex for visibility when library and server exist", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id, { machineId: "plex-machine-1" });
      await createTestLibrary(server.id, { type: "MOVIE" });

      const ruleSet = await createTestRuleSet(user.id, {
        name: "Visibility Test",
        type: "MOVIE",
        collectionEnabled: true,
        collectionName: "Visible Collection",
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
        searchParams: { ruleSetId: ruleSet.id },
      });

      // PlexClient mock returns { home: false, recommended: false } by default,
      // but getCollections returns [] so no collection is found, falling through
      // to the default response
      const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
      expect(body.home).toBe(false);
      expect(body.recommended).toBe(false);
    });

    it("returns visibility when another user's ruleSetId is provided (returns defaults)", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "viewer" });
      const ruleSet = await createTestRuleSet(user1.id, {
        name: "Private",
        collectionEnabled: true,
        collectionName: "Private Col",
      });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      // The visibility route uses findUnique with userId filter, so it won't
      // find it and returns defaults
      const response = await callRoute(visibilityGet, {
        url: "/api/lifecycle/collections/visibility",
        searchParams: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
      expect(body.home).toBe(false);
      expect(body.recommended).toBe(false);
    });
  });
});
