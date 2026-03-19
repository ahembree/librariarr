import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Mock the lifecycle processor
const mockRunDetection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lifecycle/detect-matches", () => ({
  runDetection: mockRunDetection,
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
import { POST } from "@/app/api/lifecycle/rules/run/route";

describe("POST /api/lifecycle/rules/run", () => {
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
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: {},
    });
    await expectJson(response, 401);
  });

  it("returns 400 on invalid body (non-JSON)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      // No body triggers "Invalid JSON in request body"
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid JSON in request body");
  });

  it("calls runDetection with correct params for specific ruleSetId", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const mockResult = [{ ruleSetId: "rs-1", matchCount: 5 }];
    mockRunDetection.mockResolvedValue(mockResult);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { ruleSetId: "rs-1" },
    });
    const body = await expectJson<{ ruleMatches: unknown[] }>(response, 200);

    expect(mockRunDetection).toHaveBeenCalledWith(user.id, "rs-1", false);
    expect(body.ruleMatches).toEqual(mockResult);
  });

  it("calls runDetection with fullReEval when specified", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockRunDetection.mockResolvedValue([]);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { ruleSetId: "rs-1", fullReEval: true },
    });
    await expectJson(response, 200);

    expect(mockRunDetection).toHaveBeenCalledWith(user.id, "rs-1", true);
  });

  it("calls runDetection with undefined ruleSetId when not specified", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockRunDetection.mockResolvedValue([]);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ ruleMatches: unknown[] }>(response, 200);
    expect(body.ruleMatches).toEqual([]);

    expect(mockRunDetection).toHaveBeenCalledWith(user.id, undefined, false);
  });
});
