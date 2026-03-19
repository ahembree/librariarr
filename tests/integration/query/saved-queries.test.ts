import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
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

// Import route handlers AFTER mocks
import { GET, POST } from "@/app/api/saved-queries/route";
import { PUT, DELETE } from "@/app/api/saved-queries/[id]/route";

/** Minimal valid query object matching queryDefinitionSchema */
function makeQuery(overrides: Record<string, unknown> = {}) {
  return {
    mediaTypes: ["MOVIE"],
    serverIds: [],
    groups: [],
    sortBy: "title",
    sortOrder: "asc" as const,
    ...overrides,
  };
}

/** Helper: create a saved query via the POST route and return parsed body */
async function createSavedQuery(name: string, query = makeQuery()) {
  const response = await callRoute(POST, {
    url: "/api/saved-queries",
    method: "POST",
    body: { name, query },
  });
  return expectJson<{
    query: { id: string; name: string; query: object; createdAt: string; updatedAt: string };
  }>(response, 201);
}

describe("Saved queries API", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ===== GET /api/saved-queries =====

  describe("GET /api/saved-queries", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty list when no queries exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: unknown[] }>(response, 200);
      expect(body.queries).toEqual([]);
    });

    it("returns only queries belonging to the authenticated user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });

      // Create queries as user1
      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });
      await createSavedQuery("User1 Query");

      // Create queries as user2
      setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });
      await createSavedQuery("User2 Query");

      // List as user1 — should only see their own
      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: { name: string }[] }>(response, 200);
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0].name).toBe("User1 Query");
    });

    it("returns queries ordered by updatedAt descending", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await createSavedQuery("First");
      await createSavedQuery("Second");
      await createSavedQuery("Third");

      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: { name: string }[] }>(response, 200);
      expect(body.queries).toHaveLength(3);
      // Most recently created (updated) should be first
      expect(body.queries[0].name).toBe("Third");
      expect(body.queries[2].name).toBe("First");
    });
  });

  // ===== POST /api/saved-queries =====

  describe("POST /api/saved-queries", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "Test", query: makeQuery() },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("creates a saved query successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const query = makeQuery({ mediaTypes: ["MOVIE", "SERIES"] });
      const body = await createSavedQuery("My Query", query);

      expect(body.query.id).toBeDefined();
      expect(body.query.name).toBe("My Query");
      expect(body.query.query).toMatchObject({ mediaTypes: ["MOVIE", "SERIES"] });
      expect(body.query.createdAt).toBeDefined();
      expect(body.query.updatedAt).toBeDefined();
    });

    it("returns 400 when name is empty", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "", query: makeQuery() },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 when query is missing", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "No Query" },
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 when name exceeds 100 characters", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "x".repeat(101), query: makeQuery() },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 400 for invalid query shape", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "Bad", query: { invalid: true } },
      });
      expect(response.status).toBe(400);
    });
  });

  // ===== PUT /api/saved-queries/[id] =====

  describe("PUT /api/saved-queries/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        PUT,
        { id: "any" },
        { url: "/api/saved-queries/any", method: "PUT", body: { name: "New" } }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent query", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: "00000000-0000-0000-0000-000000000000" },
        { method: "PUT", body: { name: "New" } }
      );
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns 404 when updating another user's query", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });

      setMockSession({ userId: owner.id, plexToken: "tok", isLoggedIn: true });
      const created = await createSavedQuery("Owner's Query");

      setMockSession({ userId: intruder.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { name: "Stolen" } }
      );
      await expectJson<{ error: string }>(response, 404);
    });

    it("updates name successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const created = await createSavedQuery("Original Name");

      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { name: "Updated Name" } }
      );
      const body = await expectJson<{ query: { name: string; query: object } }>(response, 200);
      expect(body.query.name).toBe("Updated Name");
    });

    it("updates query definition successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const created = await createSavedQuery("My Query", makeQuery({ mediaTypes: ["MOVIE"] }));

      const newQuery = makeQuery({ mediaTypes: ["SERIES", "MUSIC"] });
      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { query: newQuery } }
      );
      const body = await expectJson<{ query: { query: { mediaTypes: string[] } } }>(response, 200);
      expect(body.query.query.mediaTypes).toEqual(["SERIES", "MUSIC"]);
    });

    it("updates both name and query at once", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const created = await createSavedQuery("Old");

      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        {
          method: "PUT",
          body: {
            name: "New",
            query: makeQuery({ mediaTypes: ["MUSIC"], sortOrder: "desc" }),
          },
        }
      );
      const body = await expectJson<{
        query: { name: string; query: { mediaTypes: string[]; sortOrder: string } };
      }>(response, 200);
      expect(body.query.name).toBe("New");
      expect(body.query.query.mediaTypes).toEqual(["MUSIC"]);
      expect(body.query.query.sortOrder).toBe("desc");
    });

    it("returns 400 for invalid update data", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const created = await createSavedQuery("Valid");

      // Empty name violates min(1)
      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { name: "" } }
      );
      expect(response.status).toBe(400);
    });
  });

  // ===== DELETE /api/saved-queries/[id] =====

  describe("DELETE /api/saved-queries/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        DELETE,
        { id: "any" },
        { url: "/api/saved-queries/any", method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent query", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: "00000000-0000-0000-0000-000000000000" },
        { method: "DELETE" }
      );
      await expectJson<{ error: string }>(response, 404);
    });

    it("returns 404 when deleting another user's query", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });

      setMockSession({ userId: owner.id, plexToken: "tok", isLoggedIn: true });
      const created = await createSavedQuery("Owner's Query");

      setMockSession({ userId: intruder.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRouteWithParams(
        DELETE,
        { id: created.query.id },
        { method: "DELETE" }
      );
      await expectJson<{ error: string }>(response, 404);
    });

    it("deletes query successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const created = await createSavedQuery("To Delete");

      const response = await callRouteWithParams(
        DELETE,
        { id: created.query.id },
        { method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify it's gone
      const listResponse = await callRoute(GET, { url: "/api/saved-queries" });
      const listBody = await expectJson<{ queries: unknown[] }>(listResponse, 200);
      expect(listBody.queries).toHaveLength(0);
    });

    it("only deletes the targeted query, leaving others intact", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const q1 = await createSavedQuery("Keep This");
      const q2 = await createSavedQuery("Delete This");

      await callRouteWithParams(
        DELETE,
        { id: q2.query.id },
        { method: "DELETE" }
      );

      const listResponse = await callRoute(GET, { url: "/api/saved-queries" });
      const listBody = await expectJson<{ queries: { id: string; name: string }[] }>(listResponse, 200);
      expect(listBody.queries).toHaveLength(1);
      expect(listBody.queries[0].id).toBe(q1.query.id);
    });
  });
});
