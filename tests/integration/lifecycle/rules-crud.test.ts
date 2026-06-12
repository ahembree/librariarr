import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestRuleSet,
  createTestSonarrInstance,
  createTestRadarrInstance,
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

// Mock lifecycle collections (used by DELETE handler)
vi.mock("@/lib/lifecycle/collections", () => ({
  syncPlexCollection: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mocks
import { GET, POST } from "@/app/api/lifecycle/rules/route";
import { PUT, DELETE } from "@/app/api/lifecycle/rules/[id]/route";

// Minimal valid rule for Zod validation (rules array requires min 1 item)
const dummyRule = { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" };

describe("Lifecycle Rules CRUD", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- GET /api/lifecycle/rules ----

  describe("GET /api/lifecycle/rules", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, {
        url: "/api/lifecycle/rules",
      });
      await expectJson(response, 401);
    });

    it("returns empty array when no rule sets exist", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/rules",
      });
      const body = await expectJson<{ ruleSets: unknown[] }>(response, 200);
      expect(body.ruleSets).toEqual([]);
    });

    it("returns only the authenticated user's rule sets", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });

      await createTestRuleSet(user1.id, { name: "User1 Rule", type: "MOVIE" });
      await createTestRuleSet(user2.id, { name: "User2 Rule", type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user1.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/rules",
      });
      const body = await expectJson<{ ruleSets: { name: string }[] }>(response, 200);
      expect(body.ruleSets).toHaveLength(1);
      expect(body.ruleSets[0].name).toBe("User1 Rule");
    });

    it("returns rule sets ordered by createdAt desc", async () => {
      const user = await createTestUser();
      const first = await createTestRuleSet(user.id, { name: "First Rule" });
      const second = await createTestRuleSet(user.id, { name: "Second Rule" });
      // Ensure different timestamps for deterministic ordering
      const prisma = getTestPrisma();
      await prisma.ruleSet.update({
        where: { id: first.id },
        data: { createdAt: new Date(Date.now() - 1000) },
      });
      await prisma.ruleSet.update({
        where: { id: second.id },
        data: { createdAt: new Date(Date.now()) },
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/rules",
      });
      const body = await expectJson<{ ruleSets: { name: string }[] }>(response, 200);
      expect(body.ruleSets).toHaveLength(2);
      expect(body.ruleSets[0].name).toBe("Second Rule");
      expect(body.ruleSets[1].name).toBe("First Rule");
    });
  });

  // ---- POST /api/lifecycle/rules ----

  describe("POST /api/lifecycle/rules", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Test", type: "MOVIE", rules: [] },
      });
      await expectJson(response, 401);
    });

    it("creates a rule set with required fields", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const rules = [
        {
          id: "r1",
          field: "playCount",
          operator: "equals",
          value: 0,
          condition: "AND",
        },
      ];

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Unwatched Movies", type: "MOVIE", rules, serverIds: [server.id] },
      });

      const body = await expectJson<{ ruleSet: { id: string; name: string; type: string; enabled: boolean } }>(
        response,
        201
      );
      expect(body.ruleSet.name).toBe("Unwatched Movies");
      expect(body.ruleSet.type).toBe("MOVIE");
      expect(body.ruleSet.enabled).toBe(true);
      expect(body.ruleSet.id).toBeTruthy();
    });

    it("rejects fields invalid for the rule set's library type", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      // arrSeasonCount is series-only; sending it on a MOVIE rule set must 400.
      const rules = [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "arrSeasonCount", operator: "greaterThan", value: 2, condition: "AND" },
          ],
          groups: [],
        },
      ];

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Bad Movie Rule", type: "MOVIE", rules, serverIds: [server.id] },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("arrSeasonCount");

      // Nothing should have been persisted.
      const prisma = getTestPrisma();
      const count = await prisma.ruleSet.count({ where: { userId: user.id } });
      expect(count).toBe(0);
    });

    it("creates a rule set with all optional fields", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const sonarr = await createTestSonarrInstance(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Full Rule",
          type: "SERIES",
          rules: [dummyRule],
          serverIds: [server.id],
          enabled: false,
          seriesScope: false,
          actionEnabled: true,
          actionType: "DELETE_SONARR",
          actionDelayDays: 14,
          arrInstanceId: sonarr.id,
          addImportExclusion: true,
          collectionEnabled: true,
          collectionName: "Test Collection",
          collectionSortName: "zzz-test",
          collectionHomeScreen: true,
          collectionRecommended: true,
        },
      });

      const body = await expectJson<{
        ruleSet: {
          name: string;
          enabled: boolean;
          seriesScope: boolean;
          actionEnabled: boolean;
          actionType: string;
          actionDelayDays: number;
          arrInstanceId: string;
          addImportExclusion: boolean;
          collectionEnabled: boolean;
          collectionName: string;
          collectionSortName: string;
          collectionHomeScreen: boolean;
          collectionRecommended: boolean;
        };
      }>(response, 201);

      expect(body.ruleSet.name).toBe("Full Rule");
      expect(body.ruleSet.enabled).toBe(false);
      expect(body.ruleSet.seriesScope).toBe(false);
      expect(body.ruleSet.actionEnabled).toBe(true);
      expect(body.ruleSet.actionType).toBe("DELETE_SONARR");
      expect(body.ruleSet.actionDelayDays).toBe(14);
      expect(body.ruleSet.arrInstanceId).toBe(sonarr.id);
      expect(body.ruleSet.addImportExclusion).toBe(true);
      expect(body.ruleSet.collectionEnabled).toBe(true);
      expect(body.ruleSet.collectionName).toBe("Test Collection");
      expect(body.ruleSet.collectionSortName).toBe("zzz-test");
      expect(body.ruleSet.collectionHomeScreen).toBe(true);
      expect(body.ruleSet.collectionRecommended).toBe(true);
    });

    it("creates a rule set with CHANGE_QUALITY_PROFILE action and target profile", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const radarr = await createTestRadarrInstance(user.id);
      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Bump Profile",
          type: "MOVIE",
          rules: [dummyRule],
          serverIds: [server.id],
          actionEnabled: true,
          actionType: "CHANGE_QUALITY_PROFILE_RADARR",
          arrInstanceId: radarr.id,
          targetQualityProfileId: 7,
        },
      });

      const body = await expectJson<{
        ruleSet: {
          actionType: string;
          targetQualityProfileId: number;
        };
      }>(response, 201);

      expect(body.ruleSet.actionType).toBe("CHANGE_QUALITY_PROFILE_RADARR");
      expect(body.ruleSet.targetQualityProfileId).toBe(7);
    });

    it("returns 400 when CHANGE_QUALITY_PROFILE action is enabled but no target profile is set", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Missing Target",
          type: "MOVIE",
          rules: [dummyRule],
          serverIds: [server.id],
          actionEnabled: true,
          actionType: "CHANGE_QUALITY_PROFILE_RADARR",
          arrInstanceId: "some-arr-id",
          // targetQualityProfileId intentionally omitted
        },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/target quality profile/i);
    });

    it("returns 400 when targetQualityProfileId is not an integer", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: {
          name: "Bad Profile",
          type: "MOVIE",
          rules: [dummyRule],
          serverIds: [server.id],
          actionEnabled: true,
          actionType: "CHANGE_QUALITY_PROFILE_RADARR",
          arrInstanceId: "some-arr-id",
          targetQualityProfileId: "not-a-number",
        },
      });

      await expectJson(response, 400);
    });

    it("returns 400 when name is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { type: "MOVIE", rules: [dummyRule] },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when type is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Test", rules: [dummyRule] },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when rules is not an array", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Test", type: "MOVIE", rules: "not-array" },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 409 when duplicate name exists for same user and type", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      await createTestRuleSet(user.id, { name: "Dupe Rule", type: "MOVIE" });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Dupe Rule", type: "MOVIE", rules: [dummyRule], serverIds: [server.id] },
      });

      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toContain("already exists");
    });

    it("allows same name for different types", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      await createTestRuleSet(user.id, { name: "Same Name", type: "MOVIE" });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Same Name", type: "SERIES", rules: [dummyRule], serverIds: [server.id] },
      });

      await expectJson(response, 201);
    });

    it("allows same name for different users", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });
      const server2 = await createTestServer(user2.id);

      await createTestRuleSet(user1.id, { name: "Shared Name", type: "MOVIE" });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules",
        method: "POST",
        body: { name: "Shared Name", type: "MOVIE", rules: [dummyRule], serverIds: [server2.id] },
      });

      await expectJson(response, 201);
    });
  });

  // ---- PUT /api/lifecycle/rules/[id] ----

  describe("PUT /api/lifecycle/rules/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent" },
        {
          url: "/api/lifecycle/rules/nonexistent",
          method: "PUT",
          body: { name: "Updated" },
        }
      );
      await expectJson(response, 401);
    });

    it("updates a rule set name", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, { name: "Original" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { name: "Updated Name" },
        }
      );

      const body = await expectJson<{ ruleSet: { name: string } }>(response, 200);
      expect(body.ruleSet.name).toBe("Updated Name");
    });

    it("rejects a rules update carrying fields invalid for the rule set's type", async () => {
      const user = await createTestUser();
      // Default type is MOVIE.
      const ruleSet = await createTestRuleSet(user.id, { name: "Movie Rule" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const rules = [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "arrSeriesType", operator: "equals", value: "anime", condition: "AND" },
          ],
          groups: [],
        },
      ];

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { rules },
        }
      );

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("arrSeriesType");
    });

    it("updates multiple fields at once", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Test",
        enabled: true,
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: {
            enabled: false,
            actionEnabled: true,
            actionType: "DO_NOTHING",
            collectionEnabled: true,
            collectionName: "New Collection",
          },
        }
      );

      const body = await expectJson<{
        ruleSet: {
          enabled: boolean;
          actionEnabled: boolean;
          actionType: string;
          collectionEnabled: boolean;
          collectionName: string;
        };
      }>(response, 200);

      expect(body.ruleSet.enabled).toBe(false);
      expect(body.ruleSet.actionEnabled).toBe(true);
      expect(body.ruleSet.actionType).toBe("DO_NOTHING");
      expect(body.ruleSet.collectionEnabled).toBe(true);
      expect(body.ruleSet.collectionName).toBe("New Collection");
    });

    it("updates targetQualityProfileId on existing rule set", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Profile Bump",
        actionEnabled: true,
        actionType: "CHANGE_QUALITY_PROFILE_RADARR",
        targetQualityProfileId: 3,
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { targetQualityProfileId: 9 },
        }
      );

      const body = await expectJson<{
        ruleSet: { targetQualityProfileId: number };
      }>(response, 200);

      expect(body.ruleSet.targetQualityProfileId).toBe(9);
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        PUT,
        { id: "nonexistent-id" },
        {
          url: "/api/lifecycle/rules/nonexistent-id",
          method: "PUT",
          body: { name: "Updated" },
        }
      );

      await expectJson(response, 404);
    });

    it("returns 404 when updating another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Private Rule" });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { name: "Stolen" },
        }
      );

      await expectJson(response, 404);
    });

    it("returns 409 when renaming to a duplicate name", async () => {
      const user = await createTestUser();
      await createTestRuleSet(user.id, { name: "Existing", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Other", type: "MOVIE" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { name: "Existing" },
        }
      );

      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toContain("already exists");
    });

    it("allows keeping the same name on update", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, { name: "Keep Name" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        PUT,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "PUT",
          body: { name: "Keep Name", enabled: false },
        }
      );

      const body = await expectJson<{ ruleSet: { name: string; enabled: boolean } }>(response, 200);
      expect(body.ruleSet.name).toBe("Keep Name");
      expect(body.ruleSet.enabled).toBe(false);
    });
  });

  // ---- DELETE /api/lifecycle/rules/[id] ----

  describe("DELETE /api/lifecycle/rules/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent" },
        {
          url: "/api/lifecycle/rules/nonexistent",
          method: "DELETE",
        }
      );
      await expectJson(response, 401);
    });

    it("deletes an owned rule set", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, { name: "To Delete" });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        DELETE,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "DELETE",
        }
      );

      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify it's gone
      const listResponse = await callRoute(GET, {
        url: "/api/lifecycle/rules",
      });
      const listBody = await expectJson<{ ruleSets: unknown[] }>(listResponse, 200);
      expect(listBody.ruleSets).toHaveLength(0);
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        DELETE,
        { id: "nonexistent-id" },
        {
          url: "/api/lifecycle/rules/nonexistent-id",
          method: "DELETE",
        }
      );

      await expectJson(response, 404);
    });

    it("returns 404 when deleting another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Not Yours" });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRouteWithParams(
        DELETE,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "DELETE",
        }
      );

      await expectJson(response, 404);
    });

    it("attempts to remove Plex collection when collectionName is set", async () => {
      const { removePlexCollection } = await import("@/lib/lifecycle/collections");
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "With Collection",
        type: "MOVIE",
        collectionEnabled: true,
        collectionName: "My Collection",
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        DELETE,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "DELETE",
        }
      );

      await expectJson<{ success: boolean }>(response, 200);
      expect(removePlexCollection).toHaveBeenCalledWith(
        user.id,
        "MOVIE",
        "My Collection"
      );
    });

    it("still deletes when Plex collection removal fails", async () => {
      const { removePlexCollection } = await import("@/lib/lifecycle/collections");
      (removePlexCollection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Plex unreachable")
      );

      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Failing Collection",
        collectionName: "Bad Collection",
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        DELETE,
        { id: ruleSet.id },
        {
          url: `/api/lifecycle/rules/${ruleSet.id}`,
          method: "DELETE",
        }
      );

      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Audit regressions — action configuration must target the right Arr family
// ---------------------------------------------------------------------------

describe("action configuration validation", () => {
  const base = (user: { id: string }, serverId: string) => ({
    name: "Config Audit",
    type: "MOVIE" as const,
    rules: [{ id: "g1", condition: "AND", rules: [dummyRule], groups: [] }],
    serverIds: [serverId],
  });

  it("rejects a MOVIE rule set with a Sonarr action type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(POST, {
      method: "POST",
      url: "/api/lifecycle/rules",
      body: { ...base(user, server.id), actionEnabled: true, actionType: "DELETE_SONARR" },
    });
    const json = await expectJson<{ error: string }>(response, 400);
    expect(json.error).toMatch(/not valid for movie/i);
  });

  it("rejects an arrInstanceId that does not exist for the user/family", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(POST, {
      method: "POST",
      url: "/api/lifecycle/rules",
      body: { ...base(user, server.id), actionType: "DELETE_RADARR", arrInstanceId: "nonexistent-id" },
    });
    const json = await expectJson<{ error: string }>(response, 400);
    expect(json.error).toMatch(/instance not found/i);
  });

  it("rejects a Sonarr instance id attached to a MOVIE rule set", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const sonarr = await createTestSonarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(POST, {
      method: "POST",
      url: "/api/lifecycle/rules",
      body: { ...base(user, server.id), actionType: "DELETE_RADARR", arrInstanceId: sonarr.id },
    });
    await expectJson<{ error: string }>(response, 400);
  });

  it("accepts a matching Radarr instance and rejects a mismatched merged UPDATE", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const radarr = await createTestRadarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const createRes = await callRoute(POST, {
      method: "POST",
      url: "/api/lifecycle/rules",
      body: { ...base(user, server.id), actionType: "DELETE_RADARR", arrInstanceId: radarr.id },
    });
    const created = await expectJson<{ ruleSet: { id: string } }>(createRes, 201);

    // merged-state check: switching only actionType to the wrong family fails
    const updateRes = await callRouteWithParams(PUT, { id: created.ruleSet.id }, {
      method: "PUT",
      url: `/api/lifecycle/rules/${created.ruleSet.id}`,
      body: { actionType: "DELETE_SONARR" },
    });
    await expectJson<{ error: string }>(updateRes, 400);
  });
});
