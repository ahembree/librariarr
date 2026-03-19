import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/settings/action-retention/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/action-retention
// ---------------------------------------------------------------------------
describe("GET /api/settings/action-retention", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default (30) when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(30);
  });

  it("returns saved value after PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 90 },
    });

    const res = await callRoute(GET);
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/action-retention
// ---------------------------------------------------------------------------
describe("PUT /api/settings/action-retention", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 30 },
    });
    await expectJson(res, 401);
  });

  it("saves a valid retention value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 14 },
    });
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(14);
  });

  it("accepts 0 (keep forever)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 0 },
    });
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(0);
  });

  it("returns 400 for value > 365", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 500 },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 for negative value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: -1 },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when field is missing", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });
});
