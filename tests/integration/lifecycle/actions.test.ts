import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
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

// Mock Arr clients (used by execute route when evaluating rules to find items)
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

// Mock executeAction to avoid real Arr API calls
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return {
    ...actual,
    executeAction: vi.fn().mockResolvedValue(undefined),
  };
});

// Import AFTER mocks
import { GET } from "@/app/api/lifecycle/actions/route";
import { DELETE as actionDelete } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as executePost } from "@/app/api/lifecycle/actions/execute/route";

describe("Lifecycle Actions", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- Helper: create a lifecycle action in DB ----
  async function createTestAction(
    userId: string,
    mediaItemId: string,
    ruleSetId: string,
    overrides?: Partial<{
      actionType: string;
      status: "PENDING" | "COMPLETED" | "FAILED";
      scheduledFor: Date;
      executedAt: Date;
      error: string;
      arrInstanceId: string;
    }>
  ) {
    const prisma = getTestPrisma();
    return prisma.lifecycleAction.create({
      data: {
        userId,
        mediaItemId,
        ruleSetId,
        actionType: overrides?.actionType ?? "DO_NOTHING",
        status: overrides?.status ?? "PENDING",
        scheduledFor: overrides?.scheduledFor ?? new Date(),
        executedAt: overrides?.executedAt,
        error: overrides?.error,
        arrInstanceId: overrides?.arrInstanceId,
      },
    });
  }

  // ---- GET /api/lifecycle/actions ----

  describe("GET /api/lifecycle/actions", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });
      await expectJson(response, 401);
    });

    it("returns empty groups for user with none", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: unknown[];
      }>(response, 200);
      expect(body.groups).toHaveLength(0);
    });

    it("returns PENDING actions by default grouped by rule set", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      await createTestAction(user.id, item.id, ruleSet.id, { status: "PENDING" });
      await createTestAction(user.id, item.id, ruleSet.id, { status: "COMPLETED" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: { ruleSet: { id: string }; items: { status: string }[]; count: number }[];
      }>(response, 200);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].status).toBe("PENDING");
      expect(body.groups[0].count).toBe(1);
    });

    it("filters by status parameter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      await createTestAction(user.id, item.id, ruleSet.id, { status: "PENDING" });
      await createTestAction(user.id, item.id, ruleSet.id, {
        status: "COMPLETED",
        executedAt: new Date(),
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
        searchParams: { status: "COMPLETED" },
      });

      const body = await expectJson<{
        groups: { items: { status: string }[] }[];
      }>(response, 200);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].status).toBe("COMPLETED");
    });

    it("returns ALL statuses when status=ALL", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item1 = await createTestMediaItem(library.id, { title: "Movie 1", type: "MOVIE" });
      const item2 = await createTestMediaItem(library.id, { title: "Movie 2", type: "MOVIE" });
      const item3 = await createTestMediaItem(library.id, { title: "Movie 3", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      // Use different media items to avoid per-(ruleSet, mediaItem) dedup
      await createTestAction(user.id, item1.id, ruleSet.id, { status: "PENDING" });
      await createTestAction(user.id, item2.id, ruleSet.id, { status: "COMPLETED" });
      await createTestAction(user.id, item3.id, ruleSet.id, { status: "FAILED" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
        searchParams: { status: "ALL" },
      });

      const body = await expectJson<{
        groups: { items: unknown[]; count: number }[];
      }>(response, 200);
      // All 3 actions belong to the same rule set
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(3);
      expect(body.groups[0].count).toBe(3);
    });

    it("groups multiple items under one rule set", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      // Create 3 pending actions for different items under the same rule set
      for (let i = 0; i < 3; i++) {
        const item = await createTestMediaItem(library.id, {
          title: `Movie ${i}`,
          type: "MOVIE",
        });
        await createTestAction(user.id, item.id, ruleSet.id, {
          status: "PENDING",
          scheduledFor: new Date(Date.now() + i * 1000),
        });
      }

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: { ruleSet: { id: string; name: string }; items: unknown[]; count: number }[];
      }>(response, 200);

      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].ruleSet.name).toBe("Rule");
      expect(body.groups[0].items).toHaveLength(3);
      expect(body.groups[0].count).toBe(3);
    });

    it("does not return other user's actions", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });

      const server = await createTestServer(user1.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Rule" });

      await createTestAction(user1.id, item.id, ruleSet.id);

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
        searchParams: { status: "ALL" },
      });

      const body = await expectJson<{ groups: unknown[] }>(response, 200);
      expect(body.groups).toHaveLength(0);
    });

    it("includes mediaItem and ruleSet relations", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Included Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, { name: "Included Rule" });

      await createTestAction(user.id, item.id, ruleSet.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: {
          ruleSet: { name: string };
          items: {
            mediaItem: { id: string; title: string; type: string };
          }[];
        }[];
      }>(response, 200);

      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].ruleSet.name).toBe("Included Rule");
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].mediaItem.title).toBe("Included Movie");
    });
  });

  // ---- DELETE /api/lifecycle/actions/[id] (remove failed action) ----

  describe("DELETE /api/lifecycle/actions/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        actionDelete,
        { id: "nonexistent" },
        {
          url: "/api/lifecycle/actions/nonexistent",
          method: "DELETE",
        }
      );
      await expectJson(response, 401);
    });

    it("deletes a FAILED action", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, {
        status: "FAILED",
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: action.id },
        {
          url: `/api/lifecycle/actions/${action.id}`,
          method: "DELETE",
        }
      );

      const body = await expectJson<{ action: null }>(response, 200);
      expect(body.action).toBeNull();

      // Verify it's actually deleted
      const prisma = getTestPrisma();
      const deleted = await prisma.lifecycleAction.findUnique({ where: { id: action.id } });
      expect(deleted).toBeNull();
    });

    it("returns 404 for non-existent action", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: "nonexistent-id" },
        {
          url: "/api/lifecycle/actions/nonexistent-id",
          method: "DELETE",
        }
      );

      await expectJson(response, 404);
    });

    it("returns 404 when deleting another user's action", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });

      const server = await createTestServer(user1.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Rule" });
      const action = await createTestAction(user1.id, item.id, ruleSet.id, { status: "FAILED" });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: action.id },
        {
          url: `/api/lifecycle/actions/${action.id}`,
          method: "DELETE",
        }
      );

      await expectJson(response, 404);
    });

    it("returns 400 when deleting a non-FAILED action", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, {
        status: "PENDING",
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: action.id },
        {
          url: `/api/lifecycle/actions/${action.id}`,
          method: "DELETE",
        }
      );

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("failed");
    });
  });

  // ---- POST /api/lifecycle/actions/execute ----

  describe("POST /api/lifecycle/actions/execute", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: "some-id" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when ruleSetId is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {},
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: "nonexistent" },
      });

      await expectJson(response, 404);
    });

    it("returns 404 for another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const ruleSet = await createTestRuleSet(user1.id, {
        name: "Private Rule",
        actionType: "DO_NOTHING",
      });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      await expectJson(response, 404);
    });

    it("returns 400 when rule set has no action configured", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "No Action",
        actionType: undefined as unknown as string,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("action");
    });

    it("returns 400 when non-DO_NOTHING action has no arrInstanceId", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Missing Arr",
        actionType: "DELETE_RADARR",
        arrInstanceId: undefined as unknown as string,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Arr instance");
    });

    it("executes DO_NOTHING action for specified media items", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Target Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Do Nothing Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          mediaItemIds: [item.id],
        },
      });

      const body = await expectJson<{ executed: number; failed: number; errors: string[] }>(
        response,
        200
      );
      expect(body.executed).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.errors).toHaveLength(0);
    });

    it("creates COMPLETED lifecycle action records after execution", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Record Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Record Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          mediaItemIds: [item.id],
        },
      });

      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("COMPLETED");
      expect(actions[0].actionType).toBe("DO_NOTHING");
      expect(actions[0].mediaItemId).toBe(item.id);
      expect(actions[0].ruleSetId).toBe(ruleSet.id);
    });

    it("records FAILED status when executeAction throws", async () => {
      const { executeAction } = await import("@/lib/lifecycle/actions");
      (executeAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Radarr API down")
      );

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Failing Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Failing Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          mediaItemIds: [item.id],
        },
      });

      const body = await expectJson<{ executed: number; failed: number; errors: string[] }>(
        response,
        200
      );
      expect(body.executed).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain("Radarr API down");

      // Check the DB record
      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("FAILED");
      expect(actions[0].error).toContain("Radarr API down");
    });
  });
});
