import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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

// Mock Arr clients (used by ad-hoc preview for arrMetadata fetching)
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
import { POST as savedPreviewPOST } from "@/app/api/lifecycle/rules/[id]/preview/route";
import { POST as adHocPreviewPOST } from "@/app/api/lifecycle/rules/preview/route";

describe("Lifecycle Rules Preview", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- POST /api/lifecycle/rules/[id]/preview (saved rule preview) ----

  describe("POST /api/lifecycle/rules/[id]/preview", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        savedPreviewPOST,
        { id: "nonexistent" },
        {
          url: "/api/lifecycle/rules/nonexistent/preview",
          method: "POST",
        }
      );
      await expectJson(response, 401);
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        savedPreviewPOST,
        { id: "nonexistent-id" },
        {
          url: "/api/lifecycle/rules/nonexistent-id/preview",
          method: "POST",
        }
      );

      await expectJson(response, 404);
    });

    it("returns 404 for another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "viewer" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Private" });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRouteWithParams(
        savedPreviewPOST,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}/preview`,
          method: "POST",
        }
      );

      await expectJson(response, 404);
    });

    it("returns matching items for a saved rule set with playCount rule", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });

      // Create items: one unwatched, one watched
      await createTestMediaItem(library.id, {
        title: "Unwatched Movie",
        type: "MOVIE",
        playCount: 0,
      });
      await createTestMediaItem(library.id, {
        title: "Watched Movie",
        type: "MOVIE",
        playCount: 5,
      });

      const ruleSet = await createTestRuleSet(user.id, {
        name: "Unwatched",
        type: "MOVIE",
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

      const response = await callRouteWithParams(
        savedPreviewPOST,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}/preview`,
          method: "POST",
        }
      );

      const body = await expectJson<{ items: { title: string }[]; count: number }>(
        response,
        200
      );
      expect(body.count).toBe(1);
      expect(body.items[0].title).toBe("Unwatched Movie");
    });

    it("returns empty items when no matches", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(library.id, {
        title: "Watched",
        type: "MOVIE",
        playCount: 10,
      });

      const ruleSet = await createTestRuleSet(user.id, {
        name: "Unwatched",
        type: "MOVIE",
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

      const response = await callRouteWithParams(
        savedPreviewPOST,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}/preview`,
          method: "POST",
        }
      );

      const body = await expectJson<{ items: unknown[]; count: number }>(response, 200);
      expect(body.count).toBe(0);
      expect(body.items).toHaveLength(0);
    });
  });

  // ---- POST /api/lifecycle/rules/preview (ad-hoc preview) ----

  describe("POST /api/lifecycle/rules/preview", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules: [], type: "MOVIE" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when rules are missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { type: "MOVIE" },
      });

      await expectJson(response, 400);
    });

    it("returns 400 when type is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules: [] },
      });

      await expectJson(response, 400);
    });

    it("returns 400 when rules is not an array", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { rules: "invalid", type: "MOVIE" },
      });

      await expectJson(response, 400);
    });

    it("evaluates ad-hoc rules and returns matching items", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });

      await createTestMediaItem(library.id, {
        title: "Old Movie",
        type: "MOVIE",
        year: 2000,
        playCount: 0,
      });
      await createTestMediaItem(library.id, {
        title: "New Movie",
        type: "MOVIE",
        year: 2024,
        playCount: 0,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            {
              id: "r1",
              field: "year",
              operator: "lessThan",
              value: 2010,
              condition: "AND",
            },
          ],
        },
      });

      const body = await expectJson<{ items: { title: string }[]; count: number }>(
        response,
        200
      );
      expect(body.count).toBe(1);
      expect(body.items[0].title).toBe("Old Movie");
    });

    it("returns 400 with empty rules array (min 1 required)", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: { type: "MOVIE", rules: [] },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("does not return items from other user's servers", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });

      const server1 = await createTestServer(user1.id);
      const library1 = await createTestLibrary(server1.id, { type: "MOVIE" });
      await createTestMediaItem(library1.id, {
        title: "User1 Movie",
        type: "MOVIE",
        playCount: 0,
      });

      const server2 = await createTestServer(user2.id);
      const library2 = await createTestLibrary(server2.id, { type: "MOVIE" });
      await createTestMediaItem(library2.id, {
        title: "User2 Movie",
        type: "MOVIE",
        playCount: 0,
      });

      setMockSession({ isLoggedIn: true, userId: user1.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server1.id],
          rules: [
            {
              id: "r1",
              field: "playCount",
              operator: "equals",
              value: 0,
              condition: "AND",
            },
          ],
        },
      });

      const body = await expectJson<{ items: { title: string }[]; count: number }>(
        response,
        200
      );
      expect(body.count).toBe(1);
      expect(body.items[0].title).toBe("User1 Movie");
    });

    it("returns 400 when all rules are disabled (safety guard)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            {
              id: "r1",
              field: "playCount",
              operator: "greaterThan",
              value: 0,
              condition: "AND",
              enabled: false,
            },
          ],
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("No active rules to evaluate");
    });

    it("returns 400 when all groups are disabled (safety guard)", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(adHocPreviewPOST, {
        url: "/api/lifecycle/rules/preview",
        method: "POST",
        body: {
          type: "MOVIE",
          serverIds: [server.id],
          rules: [
            {
              id: "g1",
              condition: "AND",
              enabled: false,
              rules: [
                { id: "r1", field: "playCount", operator: "greaterThan", value: 0, condition: "AND" },
              ],
              groups: [],
            },
          ],
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("No active rules to evaluate");
    });
  });

  // ---- Safety guard tests for saved rule preview ----

  describe("POST /api/lifecycle/rules/[id]/preview — safety guards", () => {
    it("returns 400 when saved rule set has all rules disabled", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      await createTestLibrary(server.id, { type: "MOVIE" });

      const ruleSet = await createTestRuleSet(user.id, {
        name: "All Disabled",
        type: "MOVIE",
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

      const response = await callRouteWithParams(
        savedPreviewPOST,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}/preview`,
          method: "POST",
        }
      );

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("No active rules to evaluate");
    });
  });
});
