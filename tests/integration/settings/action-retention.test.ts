import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

const prisma = getTestPrisma();
const storedRetention = async (userId: string) =>
  (await prisma.appSettings.findUnique({ where: { userId } }))?.actionHistoryRetentionDays;

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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(30);
  });

  it("returns the saved value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    await prisma.appSettings.create({ data: { userId: user.id, actionHistoryRetentionDays: 90 } });

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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 14 },
    });
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(14);
    expect(await storedRetention(user.id)).toBe(14);
  });

  it("updates an existing settings row", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    await prisma.appSettings.create({ data: { userId: user.id, actionHistoryRetentionDays: 90 } });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 7 },
    });
    await expectJson(res);
    expect(await storedRetention(user.id)).toBe(7);
    expect(await prisma.appSettings.count()).toBe(1);
  });

  it("accepts 0 (keep forever)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 0 },
    });
    const body = await expectJson<{ actionHistoryRetentionDays: number }>(res);
    expect(body.actionHistoryRetentionDays).toBe(0);
    expect(await storedRetention(user.id)).toBe(0);
  });

  it("returns 400 for value > 365", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 500 },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["actionHistoryRetentionDays: Too big: expected number to be <=365"]);
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 for a fractional value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: 7.5 },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 for negative value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { actionHistoryRetentionDays: -1 },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["actionHistoryRetentionDays: Too small: expected number to be >=0"]);
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 when field is missing", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });
});
