import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Mock the query executor to avoid complex dependency chain (Arr clients, Seerr, dedup, etc.)
const mockExecuteQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/execute", () => ({
  executeQuery: mockExecuteQuery,
}));

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

// Import route handler AFTER mocks
import { POST } from "@/app/api/query/route";

// A minimal valid query definition that passes Zod validation
const validQuery = {
  mediaTypes: ["MOVIE"] as const,
  serverIds: ["server-1"],
  groups: [],
  sortBy: "title",
  sortOrder: "asc" as const,
};

describe("POST /api/query", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/query",
      method: "POST",
      body: { query: validQuery },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 on invalid body (no JSON)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/query",
      method: "POST",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid JSON in request body");
  });

  it("returns 400 on invalid query shape", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/query",
      method: "POST",
      body: { query: { mediaTypes: ["INVALID_TYPE"] } },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns matching items for a valid query", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const mockResult = {
      items: [
        { id: "item-1", title: "Test Movie", type: "MOVIE" },
        { id: "item-2", title: "Another Movie", type: "MOVIE" },
      ],
      pagination: { page: 1, limit: 50, hasMore: false },
      totalMatched: 2,
    };
    mockExecuteQuery.mockResolvedValue(mockResult);

    const response = await callRoute(POST, {
      url: "/api/query",
      method: "POST",
      body: { query: validQuery },
    });
    const body = await expectJson<typeof mockResult>(response, 200);

    expect(body.items).toHaveLength(2);
    expect(body.items[0].title).toBe("Test Movie");
    expect(body.pagination.hasMore).toBe(false);

    // Verify executeQuery was called with the right args
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ["MOVIE"],
        serverIds: ["server-1"],
        sortBy: "title",
        sortOrder: "asc",
      }),
      user.id,
      1,   // default page
      50,  // default limit
    );
  });

  it("handles empty result set", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockExecuteQuery.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 50, hasMore: false },
      totalMatched: 0,
    });

    const response = await callRoute(POST, {
      url: "/api/query",
      method: "POST",
      body: { query: validQuery },
    });
    const body = await expectJson<{ items: unknown[]; totalMatched: number }>(response, 200);
    expect(body.items).toHaveLength(0);
    expect(body.totalMatched).toBe(0);
  });

  it("passes custom page and limit to executeQuery", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockExecuteQuery.mockResolvedValue({
      items: [],
      pagination: { page: 2, limit: 25, hasMore: false },
      totalMatched: 0,
    });

    const response = await callRoute(POST, {
      url: "/api/query",
      method: "POST",
      body: { query: validQuery, page: 2, limit: 25 },
    });
    await expectJson(response, 200);

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      2,
      25,
    );
  });
});
