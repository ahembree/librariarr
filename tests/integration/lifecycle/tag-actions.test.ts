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

// Mock Arr clients
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
    cleanupArrTags: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock lifecycle collections
vi.mock("@/lib/lifecycle/collections", () => ({
  syncPlexCollection: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mocks
import { POST as createRuleSet } from "@/app/api/lifecycle/rules/route";
import { PUT as updateRuleSet, DELETE as deleteRuleSet } from "@/app/api/lifecycle/rules/[id]/route";
import { POST as executePost } from "@/app/api/lifecycle/actions/execute/route";

// Minimal valid rule for Zod validation (rules array requires min 1 item)
const dummyRule = { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" };

describe("Lifecycle Tag Actions", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- Creating rule sets with tag fields ----

  describe("Rule set CRUD with tag fields", () => {
    it("creates a rule set with addArrTags", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(createRuleSet, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Tag Rule",
          type: "MOVIE",
          rules: [dummyRule],
          serverIds: [server.id],
          addArrTags: ["stale", "unwatched"],
        },
      });

      const body = await expectJson<{
        ruleSet: { id: string; addArrTags: string[]; removeArrTags: string[] };
      }>(response, 201);
      expect(body.ruleSet.addArrTags).toEqual(["stale", "unwatched"]);
      expect(body.ruleSet.removeArrTags).toEqual([]);
    });

    it("creates a rule set with removeArrTags", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(createRuleSet, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Remove Tag Rule",
          type: "SERIES",
          rules: [dummyRule],
          serverIds: [server.id],
          removeArrTags: ["active"],
        },
      });

      const body = await expectJson<{
        ruleSet: { removeArrTags: string[] };
      }>(response, 201);
      expect(body.ruleSet.removeArrTags).toEqual(["active"]);
    });

    it("creates a rule set with both addArrTags and removeArrTags", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(createRuleSet, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Both Tags Rule",
          type: "MOVIE",
          rules: [dummyRule],
          serverIds: [server.id],
          addArrTags: ["cleanup"],
          removeArrTags: ["active", "monitored"],
        },
      });

      const body = await expectJson<{
        ruleSet: { addArrTags: string[]; removeArrTags: string[] };
      }>(response, 201);
      expect(body.ruleSet.addArrTags).toEqual(["cleanup"]);
      expect(body.ruleSet.removeArrTags).toEqual(["active", "monitored"]);
    });

    it("defaults to empty arrays when tag fields not provided", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(createRuleSet, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "No Tags Rule",
          type: "MOVIE",
          rules: [dummyRule],
          serverIds: [server.id],
        },
      });

      const body = await expectJson<{
        ruleSet: { addArrTags: string[]; removeArrTags: string[] };
      }>(response, 201);
      expect(body.ruleSet.addArrTags).toEqual([]);
      expect(body.ruleSet.removeArrTags).toEqual([]);
    });

    it("updates addArrTags on an existing rule set", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, { name: "Updatable" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        updateRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { addArrTags: ["new-tag"] },
        }
      );

      const body = await expectJson<{
        ruleSet: { addArrTags: string[] };
      }>(response, 200);
      expect(body.ruleSet.addArrTags).toEqual(["new-tag"]);
    });

    it("updates removeArrTags on an existing rule set", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Updatable2",
        removeArrTags: ["old-tag"],
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        updateRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { removeArrTags: ["different-tag"] },
        }
      );

      const body = await expectJson<{
        ruleSet: { removeArrTags: string[] };
      }>(response, 200);
      expect(body.ruleSet.removeArrTags).toEqual(["different-tag"]);
    });

    it("clears tag arrays by setting them to empty", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Clear Tags",
        addArrTags: ["tag1", "tag2"],
        removeArrTags: ["tag3"],
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        updateRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { addArrTags: [], removeArrTags: [] },
        }
      );

      const body = await expectJson<{
        ruleSet: { addArrTags: string[]; removeArrTags: string[] };
      }>(response, 200);
      expect(body.ruleSet.addArrTags).toEqual([]);
      expect(body.ruleSet.removeArrTags).toEqual([]);
    });
  });

  // ---- Tag operations with tag-only rule sets ----

  describe("Tag-only rule sets (DO_NOTHING + tags)", () => {
    it("allows execution of rule set with only tag operations", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Tag Target",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Tag Only Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
        addArrTags: ["stale"],
        arrInstanceId: "some-arr-id",
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

      const body = await expectJson<{ executed: number; failed: number }>(
        response,
        200
      );
      expect(body.executed).toBe(1);
      expect(body.failed).toBe(0);

      // Verify action record includes tag fields
      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0].addArrTags).toEqual(["stale"]);
      expect(actions[0].removeArrTags).toEqual([]);
    });

    it("requires arrInstanceId when tag operations are configured", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Tags No Arr",
        type: "MOVIE",
        actionType: "DO_NOTHING",
        addArrTags: ["stale"],
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

    it("allows DO_NOTHING without arrInstanceId when no tag operations", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Simple Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Plain DO_NOTHING",
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

      const body = await expectJson<{ executed: number }>(response, 200);
      expect(body.executed).toBe(1);
    });
  });

  // ---- Execute route passes tag fields ----

  describe("Execute route tag field propagation", () => {
    it("passes addArrTags and removeArrTags to executeAction", async () => {
      const { executeAction } = await import("@/lib/lifecycle/actions");

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Tag Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Full Tag Rule",
        type: "MOVIE",
        actionType: "UNMONITOR_RADARR",
        arrInstanceId: "arr-123",
        addArrTags: ["stale", "old"],
        removeArrTags: ["active"],
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

      expect(executeAction).toHaveBeenCalledOnce();
      const callArg = (executeAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.addArrTags).toEqual(["stale", "old"]);
      expect(callArg.removeArrTags).toEqual(["active"]);
      expect(callArg.actionType).toBe("UNMONITOR_RADARR");
      expect(callArg.arrInstanceId).toBe("arr-123");
    });

    it("records tag fields in lifecycle action DB record", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Record Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Record Tag Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
        addArrTags: ["tagged"],
        removeArrTags: ["untagged"],
        arrInstanceId: "arr-456",
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
      expect(actions[0].addArrTags).toEqual(["tagged"]);
      expect(actions[0].removeArrTags).toEqual(["untagged"]);
      expect(actions[0].status).toBe("COMPLETED");
    });

    it("records tag fields even when execution fails", async () => {
      const { executeAction } = await import("@/lib/lifecycle/actions");
      (executeAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Arr unavailable")
      );

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Fail Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Fail Tag Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
        addArrTags: ["attempted"],
        arrInstanceId: "arr-789",
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

      const body = await expectJson<{ failed: number }>(response, 200);
      expect(body.failed).toBe(1);

      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0].addArrTags).toEqual(["attempted"]);
      expect(actions[0].status).toBe("FAILED");
      expect(actions[0].error).toContain("Arr unavailable");
    });
  });

  // ---- Delete with tag cleanup ----

  describe("Delete rule set with tag cleanup", () => {
    it("calls cleanupArrTags when cleanupTags=true and rule has addArrTags", async () => {
      const { cleanupArrTags } = await import("@/lib/lifecycle/actions");

      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Cleanup Rule",
        type: "MOVIE",
        addArrTags: ["stale", "old"],
        arrInstanceId: "arr-cleanup-id",
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        deleteRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}?cleanupTags=true`,
          method: "DELETE",
          searchParams: { cleanupTags: "true" },
        }
      );

      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);
      expect(cleanupArrTags).toHaveBeenCalledWith(
        "arr-cleanup-id",
        "MOVIE",
        ["stale", "old"]
      );
    });

    it("does not call cleanupArrTags when cleanupTags is not set", async () => {
      const { cleanupArrTags } = await import("@/lib/lifecycle/actions");

      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "No Cleanup Rule",
        type: "MOVIE",
        addArrTags: ["stale"],
        arrInstanceId: "arr-id",
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      await callRouteWithParams(
        deleteRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "DELETE",
        }
      );

      expect(cleanupArrTags).not.toHaveBeenCalled();
    });

    it("does not call cleanupArrTags when rule has no addArrTags", async () => {
      const { cleanupArrTags } = await import("@/lib/lifecycle/actions");

      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "No Tags Rule",
        type: "MOVIE",
        arrInstanceId: "arr-id",
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      await callRouteWithParams(
        deleteRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}?cleanupTags=true`,
          method: "DELETE",
          searchParams: { cleanupTags: "true" },
        }
      );

      expect(cleanupArrTags).not.toHaveBeenCalled();
    });

    it("still deletes rule set when cleanupArrTags fails", async () => {
      const { cleanupArrTags } = await import("@/lib/lifecycle/actions");
      (cleanupArrTags as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Arr unreachable")
      );

      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Failing Cleanup",
        type: "SERIES",
        addArrTags: ["temp"],
        arrInstanceId: "arr-fail-id",
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        deleteRuleSet,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}?cleanupTags=true`,
          method: "DELETE",
          searchParams: { cleanupTags: "true" },
        }
      );

      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify rule set was deleted despite cleanup failure
      const prisma = getTestPrisma();
      const found = await prisma.ruleSet.findUnique({ where: { id: ruleSet.id } });
      expect(found).toBeNull();
    });
  });
});
