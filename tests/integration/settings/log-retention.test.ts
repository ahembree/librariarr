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

import { GET, PUT } from "@/app/api/settings/log-retention/route";

const prisma = getTestPrisma();
const storedRetention = async (userId: string) =>
  (await prisma.appSettings.findUnique({ where: { userId } }))?.logRetentionDays;

describe("GET /api/settings/log-retention", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default 7 days when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(7);
  });

  it("returns saved retention value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await prisma.appSettings.create({ data: { userId: user.id, logRetentionDays: 30 } });

    const res = await callRoute(GET);
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(30);
  });
});

describe("PUT /api/settings/log-retention", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 14 },
    });
    await expectJson(res, 401);
  });

  it("updates log retention days", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 90 },
    });
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(90);
    expect(await storedRetention(user.id)).toBe(90);
  });

  it("accepts minimum value of 1", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 1 },
    });
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(1);
    expect(await storedRetention(user.id)).toBe(1);
  });

  it("accepts maximum value of 365", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 365 },
    });
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(365);
    expect(await storedRetention(user.id)).toBe(365);
  });

  it("returns 400 for value below minimum", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 0 },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["logRetentionDays: Too small: expected number to be >=1"]);
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 for value above maximum", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 366 },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["logRetentionDays: Too big: expected number to be <=365"]);
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 for non-integer value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { logRetentionDays: 7.5 },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^logRetentionDays: /);
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 for a value that is not a number", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { logRetentionDays: "thirty" } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["logRetentionDays: Invalid input: expected number, received string"]);
    expect(await storedRetention(user.id)).toBeUndefined();
  });

  it("returns 400 for missing field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(await storedRetention(user.id)).toBeUndefined();
  });
});
