import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: unknown[] }>(response, 200);
      expect(body.queries).toEqual([]);
    });

    it("returns only queries belonging to the authenticated user", async () => {
      const user1 = await createTestUser({ plexId: "user1" });
      const user2 = await createTestUser({ plexId: "user2" });

      // Create queries as user1
      setMockSession({ userId: user1.id, isLoggedIn: true });
      await createSavedQuery("User1 Query");

      // Create queries as user2
      setMockSession({ userId: user2.id, isLoggedIn: true });
      await createSavedQuery("User2 Query");

      // List as user1 — should only see their own
      setMockSession({ userId: user1.id, isLoggedIn: true });
      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: { name: string }[] }>(response, 200);
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0].name).toBe("User1 Query");
    });

    it("returns queries ordered by updatedAt descending", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const first = await createSavedQuery("First");
      const second = await createSavedQuery("Second");
      const third = await createSavedQuery("Third");
      // Three inserts can share a millisecond; give them distinct times, and an
      // order that differs from creation order, so the sort is what is tested.
      const prisma = getTestPrisma();
      const now = Date.now();
      await prisma.savedQuery.update({ where: { id: first.query.id }, data: { updatedAt: new Date(now - 60_000) } });
      await prisma.savedQuery.update({ where: { id: second.query.id }, data: { updatedAt: new Date(now) } });
      await prisma.savedQuery.update({ where: { id: third.query.id }, data: { updatedAt: new Date(now - 120_000) } });

      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: { name: string }[] }>(response, 200);
      expect(body.queries.map((q) => q.name)).toEqual(["Second", "First", "Third"]);
    });

    // Ordered by `updatedAt` alone, two queries saved in the same millisecond
    // came back in whatever order Postgres read them and could swap between
    // loads; `id` makes the order total.
    it("orders queries with the same updatedAt by id", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      // One shared timestamp, stored in descending id order — the order an
      // unordered tie came back in.
      const prisma = getTestPrisma();
      const at = new Date("2024-05-01T12:00:00Z");
      for (const id of ["sq-c", "sq-b", "sq-a"]) {
        await prisma.savedQuery.create({ data: { id, userId: user.id, name: id, query: makeQuery(), updatedAt: at } });
      }

      const response = await callRoute(GET, { url: "/api/saved-queries" });
      const body = await expectJson<{ queries: { id: string }[] }>(response, 200);
      expect(body.queries.map((q) => q.id)).toEqual(["sq-a", "sq-b", "sq-c"]);
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const query = makeQuery({ mediaTypes: ["MOVIE", "SERIES"] });
      const body = await createSavedQuery("My Query", query);

      expect(body.query.name).toBe("My Query");
      // Stored as validated: the schema's defaults filled in.
      expect(body.query.query).toEqual({ ...query, includeEpisodes: false });
      expect(Number.isNaN(Date.parse(body.query.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(body.query.updatedAt))).toBe(false);

      const row = await getTestPrisma().savedQuery.findUniqueOrThrow({ where: { id: body.query.id } });
      expect(row).toMatchObject({ userId: user.id, name: "My Query", query: { ...query, includeEpisodes: false } });
    });

    it("returns 400 when name is empty", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "No Query" },
      });
      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(body.details.some((d) => d.startsWith("query"))).toBe(true);
      expect(await getTestPrisma().savedQuery.count()).toBe(0);
    });

    it("returns 400 when name exceeds 100 characters", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "Bad", query: { invalid: true } },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(await getTestPrisma().savedQuery.count()).toBe(0);
    });

    it("rejects fields invalid for every selected media type", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      // arrSeasonCount is series-only; a MUSIC-only query can never match it.
      const query = makeQuery({
        mediaTypes: ["MUSIC"],
        groups: [
          {
            id: "g1",
            condition: "AND",
            rules: [
              { id: "r1", field: "arrSeasonCount", operator: "greaterThan", value: 1, condition: "AND" },
            ],
            groups: [],
          },
        ],
      });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "Bad Music Query", query },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("These criteria are not valid for the selected media types: arrSeasonCount");
      // A silently-dead query is never persisted.
      expect(await getTestPrisma().savedQuery.count()).toBe(0);
    });

    it("accepts a field valid for at least one of several selected types", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      // arrSeasonCount is valid for SERIES, so a Movie+Series query keeps it.
      const query = makeQuery({
        mediaTypes: ["MOVIE", "SERIES"],
        groups: [
          {
            id: "g1",
            condition: "AND",
            rules: [
              { id: "r1", field: "arrSeasonCount", operator: "greaterThan", value: 1, condition: "AND" },
            ],
            groups: [],
          },
        ],
      });

      const response = await callRoute(POST, {
        url: "/api/saved-queries",
        method: "POST",
        body: { name: "OK Mixed Query", query },
      });

      const body = await expectJson<{ query: { id: string; name: string } }>(response, 201);
      expect(body.query.name).toBe("OK Mixed Query");
      expect(await getTestPrisma().savedQuery.count({ where: { id: body.query.id } })).toBe(1);
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        PUT,
        { id: "00000000-0000-0000-0000-000000000000" },
        { method: "PUT", body: { name: "New" } }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 when updating another user's query", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });

      setMockSession({ userId: owner.id, isLoggedIn: true });
      const created = await createSavedQuery("Owner's Query");

      setMockSession({ userId: intruder.id, isLoggedIn: true });
      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { name: "Stolen" } }
      );
      await expectJson<{ error: string }>(response, 404);
      const row = await getTestPrisma().savedQuery.findUniqueOrThrow({ where: { id: created.query.id } });
      expect(row.name).toBe("Owner's Query");
    });

    it("updates name successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const created = await createSavedQuery("Original Name");

      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { name: "Updated Name" } }
      );
      const body = await expectJson<{ query: { name: string; query: object } }>(response, 200);
      expect(body.query.name).toBe("Updated Name");
      // Only the name changed: the stored definition is untouched.
      expect(body.query.query).toEqual(created.query.query);
      const row = await getTestPrisma().savedQuery.findUniqueOrThrow({ where: { id: created.query.id } });
      expect(row.name).toBe("Updated Name");
      expect(row.query).toEqual(created.query.query);
    });

    it("updates query definition successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const created = await createSavedQuery("My Query", makeQuery({ mediaTypes: ["MOVIE"] }));

      const newQuery = makeQuery({ mediaTypes: ["SERIES", "MUSIC"] });
      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { query: newQuery } }
      );
      const body = await expectJson<{ query: { name: string; query: { mediaTypes: string[] } } }>(response, 200);
      expect(body.query.query.mediaTypes).toEqual(["SERIES", "MUSIC"]);
      expect(body.query.name).toBe("My Query");
      const row = await getTestPrisma().savedQuery.findUniqueOrThrow({ where: { id: created.query.id } });
      expect(row.query).toMatchObject({ mediaTypes: ["SERIES", "MUSIC"] });
    });

    it("updates both name and query at once", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const created = await createSavedQuery("Valid");

      // Empty name violates min(1)
      const response = await callRouteWithParams(
        PUT,
        { id: created.query.id },
        { method: "PUT", body: { name: "" } }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
      const row = await getTestPrisma().savedQuery.findUniqueOrThrow({ where: { id: created.query.id } });
      expect(row.name).toBe("Valid");
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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRouteWithParams(
        DELETE,
        { id: "00000000-0000-0000-0000-000000000000" },
        { method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 when deleting another user's query", async () => {
      const owner = await createTestUser({ plexId: "owner" });
      const intruder = await createTestUser({ plexId: "intruder" });

      setMockSession({ userId: owner.id, isLoggedIn: true });
      const created = await createSavedQuery("Owner's Query");

      setMockSession({ userId: intruder.id, isLoggedIn: true });
      const response = await callRouteWithParams(
        DELETE,
        { id: created.query.id },
        { method: "DELETE" }
      );
      await expectJson<{ error: string }>(response, 404);
      expect(await getTestPrisma().savedQuery.count({ where: { id: created.query.id } })).toBe(1);
    });

    it("deletes query successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

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
      setMockSession({ userId: user.id, isLoggedIn: true });

      const q1 = await createSavedQuery("Keep This");
      const q2 = await createSavedQuery("Delete This");

      await expectJson(await callRouteWithParams(
        DELETE,
        { id: q2.query.id },
        { method: "DELETE" }
      ), 200);

      const listResponse = await callRoute(GET, { url: "/api/saved-queries" });
      const listBody = await expectJson<{ queries: { id: string; name: string }[] }>(listResponse, 200);
      expect(listBody.queries).toHaveLength(1);
      expect(listBody.queries[0].id).toBe(q1.query.id);
    });
  });
});
