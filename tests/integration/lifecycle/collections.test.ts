import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestRuleSet,
  createTestCollection,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the Plex-touching collection helpers so route logic is exercised against
// the real DB without hitting Plex. The sync engine itself is unit-tested.
const { mockSyncCollectionById, mockRemovePlexCollection, mockRenameCollectionInPlex } = vi.hoisted(() => ({
  mockSyncCollectionById: vi.fn().mockResolvedValue(undefined),
  mockRemovePlexCollection: vi.fn().mockResolvedValue(undefined),
  mockRenameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollectionById: mockSyncCollectionById,
  removePlexCollection: mockRemovePlexCollection,
  renameCollectionInPlex: mockRenameCollectionInPlex,
}));

// Import AFTER mocks
import { GET as listGet, POST as createPost } from "@/app/api/lifecycle/collections/route";
import { PUT as updatePut, DELETE as deleteDelete } from "@/app/api/lifecycle/collections/[id]/route";
import { POST as syncPost } from "@/app/api/lifecycle/collections/sync/route";

describe("Lifecycle Collections CRUD", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- GET /api/lifecycle/collections ----
  describe("GET /api/lifecycle/collections", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(listGet, { url: "/api/lifecycle/collections" });
      await expectJson(response, 401);
    });

    it("lists the user's collections, optionally filtered by type", async () => {
      const user = await createTestUser();
      await createTestCollection(user.id, { name: "Leaving Soon", type: "MOVIE" });
      await createTestCollection(user.id, { name: "TV Soon", type: "SERIES" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const all = await callRoute(listGet, { url: "/api/lifecycle/collections" });
      const allBody = await expectJson<{ collections: Array<{ name: string }> }>(all, 200);
      expect(allBody.collections).toHaveLength(2);

      const movies = await callRoute(listGet, {
        url: "/api/lifecycle/collections",
        searchParams: { type: "MOVIE" },
      });
      const moviesBody = await expectJson<{ collections: Array<{ name: string }> }>(movies, 200);
      expect(moviesBody.collections).toHaveLength(1);
      expect(moviesBody.collections[0].name).toBe("Leaving Soon");
    });

    it("includes a rule set usage count", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { type: "MOVIE" });
      await createTestRuleSet(user.id, { type: "MOVIE", collectionId: collection.id });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(listGet, { url: "/api/lifecycle/collections" });
      const body = await expectJson<{ collections: Array<{ _count: { ruleSets: number } }> }>(response, 200);
      expect(body.collections[0]._count.ruleSets).toBe(1);
    });
  });

  // ---- POST /api/lifecycle/collections ----
  describe("POST /api/lifecycle/collections", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(createPost, {
        url: "/api/lifecycle/collections",
        method: "POST",
        body: { name: "X", type: "MOVIE" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 on validation failure", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(createPost, {
        url: "/api/lifecycle/collections",
        method: "POST",
        body: { type: "MOVIE" },
      });
      await expectJson(response, 400);
    });

    it("creates a collection", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(createPost, {
        url: "/api/lifecycle/collections",
        method: "POST",
        body: { name: "Leaving Soon", type: "MOVIE", sort: "DELETION_DATE", homeScreen: true },
      });
      const body = await expectJson<{ collection: { id: string; name: string; sort: string; homeScreen: boolean } }>(response, 201);
      expect(body.collection.name).toBe("Leaving Soon");
      expect(body.collection.sort).toBe("DELETION_DATE");
      expect(body.collection.homeScreen).toBe(true);

      const inDb = await getTestPrisma().collection.findFirst({ where: { userId: user.id } });
      expect(inDb?.name).toBe("Leaving Soon");
    });

    it("returns 409 on duplicate name for the same type", async () => {
      const user = await createTestUser();
      await createTestCollection(user.id, { name: "Leaving Soon", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(createPost, {
        url: "/api/lifecycle/collections",
        method: "POST",
        body: { name: "Leaving Soon", type: "MOVIE" },
      });
      await expectJson(response, 409);
    });

    it("allows the same name across different types", async () => {
      const user = await createTestUser();
      await createTestCollection(user.id, { name: "Leaving Soon", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(createPost, {
        url: "/api/lifecycle/collections",
        method: "POST",
        body: { name: "Leaving Soon", type: "SERIES" },
      });
      await expectJson(response, 201);
    });
  });

  // ---- PUT /api/lifecycle/collections/[id] ----
  describe("PUT /api/lifecycle/collections/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(updatePut, { id: "x" }, {
        url: "/api/lifecycle/collections/x",
        method: "PUT",
        body: { sort: "ALPHABETICAL" },
      });
      await expectJson(response, 401);
    });

    it("returns 404 for a non-existent collection", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(updatePut, { id: "missing" }, {
        url: "/api/lifecycle/collections/missing",
        method: "PUT",
        body: { sort: "ALPHABETICAL" },
      });
      await expectJson(response, 404);
    });

    it("updates settings and re-syncs", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { type: "MOVIE", sort: "ALPHABETICAL" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(updatePut, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "PUT",
        body: { sort: "DELETION_DATE", recommended: true },
      });
      const body = await expectJson<{ collection: { sort: string; recommended: boolean } }>(response, 200);
      expect(body.collection.sort).toBe("DELETION_DATE");
      expect(body.collection.recommended).toBe(true);
      expect(mockSyncCollectionById).toHaveBeenCalledWith(collection.id);
      expect(mockRenameCollectionInPlex).not.toHaveBeenCalled();
    });

    it("renames on Plex when the name changes", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { name: "Old", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(updatePut, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "PUT",
        body: { name: "New" },
      });
      await expectJson(response, 200);
      expect(mockRenameCollectionInPlex).toHaveBeenCalledWith(user.id, "MOVIE", "Old", "New");
    });

    it("returns 409 when renaming to an existing name", async () => {
      const user = await createTestUser();
      await createTestCollection(user.id, { name: "Taken", type: "MOVIE" });
      const collection = await createTestCollection(user.id, { name: "Mine", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(updatePut, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "PUT",
        body: { name: "Taken" },
      });
      await expectJson(response, 409);
    });
  });

  // ---- DELETE /api/lifecycle/collections/[id] ----
  describe("DELETE /api/lifecycle/collections/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(deleteDelete, { id: "x" }, {
        url: "/api/lifecycle/collections/x",
        method: "DELETE",
      });
      await expectJson(response, 401);
    });

    it("deletes an unused collection and removes it from Plex", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { name: "Gone", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(deleteDelete, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "DELETE",
      });
      await expectJson(response, 200);
      expect(mockRemovePlexCollection).toHaveBeenCalledWith(user.id, "MOVIE", "Gone");

      const deleted = await getTestPrisma().collection.findUnique({ where: { id: collection.id } });
      expect(deleted).toBeNull();
    });

    it("refuses to delete a collection that is in use", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { name: "Busy", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE", collectionId: collection.id });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(deleteDelete, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "DELETE",
      });
      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toContain("in use");
      // The collection and its rule-set link are untouched.
      expect(mockRemovePlexCollection).not.toHaveBeenCalled();
      const stillThere = await getTestPrisma().collection.findUnique({ where: { id: collection.id } });
      expect(stillThere).not.toBeNull();
      const rs = await getTestPrisma().ruleSet.findUnique({ where: { id: ruleSet.id } });
      expect(rs?.collectionId).toBe(collection.id);
    });

    it("deletes from the last rule using it (detaches that rule)", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { name: "Last", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE", collectionId: collection.id });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(deleteDelete, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "DELETE",
        searchParams: { ruleSetId: ruleSet.id },
      });
      await expectJson(response, 200);
      expect(mockRemovePlexCollection).toHaveBeenCalledWith(user.id, "MOVIE", "Last");
      // Collection gone; the named rule is detached via the FK SetNull.
      const deleted = await getTestPrisma().collection.findUnique({ where: { id: collection.id } });
      expect(deleted).toBeNull();
      const rs = await getTestPrisma().ruleSet.findUnique({ where: { id: ruleSet.id } });
      expect(rs?.collectionId).toBeNull();
    });

    it("still refuses when OTHER rules use it even if one is named", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { name: "Shared", type: "MOVIE" });
      const ruleA = await createTestRuleSet(user.id, { type: "MOVIE", collectionId: collection.id });
      const ruleB = await createTestRuleSet(user.id, { type: "MOVIE", collectionId: collection.id });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(deleteDelete, { id: collection.id }, {
        url: `/api/lifecycle/collections/${collection.id}`,
        method: "DELETE",
        searchParams: { ruleSetId: ruleA.id },
      });
      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toContain("other rule");
      const stillThere = await getTestPrisma().collection.findUnique({ where: { id: collection.id } });
      expect(stillThere).not.toBeNull();
      // Both rules still linked.
      expect((await getTestPrisma().ruleSet.findUnique({ where: { id: ruleA.id } }))?.collectionId).toBe(collection.id);
      expect((await getTestPrisma().ruleSet.findUnique({ where: { id: ruleB.id } }))?.collectionId).toBe(collection.id);
    });

    it("returns 404 for a non-existent collection", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(deleteDelete, { id: "missing" }, {
        url: "/api/lifecycle/collections/missing",
        method: "DELETE",
      });
      await expectJson(response, 404);
    });
  });

  // ---- POST /api/lifecycle/collections/sync ----
  describe("POST /api/lifecycle/collections/sync", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { collectionId: "x" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when collectionId is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: {},
      });
      await expectJson(response, 400);
    });

    it("returns 404 for a non-existent collection", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { collectionId: "missing" },
      });
      await expectJson(response, 404);
    });

    it("syncs an existing collection", async () => {
      const user = await createTestUser();
      const collection = await createTestCollection(user.id, { name: "Leaving Soon", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(syncPost, {
        url: "/api/lifecycle/collections/sync",
        method: "POST",
        body: { collectionId: collection.id },
      });
      const body = await expectJson<{ success: boolean; collectionName: string }>(response, 200);
      expect(body.success).toBe(true);
      expect(body.collectionName).toBe("Leaving Soon");
      expect(mockSyncCollectionById).toHaveBeenCalledWith(collection.id);
    });
  });
});
