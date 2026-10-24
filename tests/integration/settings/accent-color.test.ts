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

import { GET, PUT } from "@/app/api/settings/accent-color/route";

const prisma = getTestPrisma();

describe("GET /api/settings/accent-color", () => {
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

  it("returns 401 when user no longer exists in DB", async () => {
    setMockSession({ isLoggedIn: true, userId: "nonexistent-id"});
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default accent color when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("default");
    // The settings row is created on first read.
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.accentColor).toBe("default");
  });

  it("returns saved accent color", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await prisma.appSettings.create({ data: { userId: user.id, accentColor: "teal" } });

    const res = await callRoute(GET);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("teal");
  });

  it("returns default for a removed preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await prisma.appSettings.create({ data: { userId: user.id, accentColor: "blue" } });

    const res = await callRoute(GET);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("default");
  });

  it("rejects the removed blue preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "blue" } });
    await expectJson(res, 400);
  });
});

describe("PUT /api/settings/accent-color", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "teal" } });
    await expectJson(res, 401);
  });

  it("returns 401 when user no longer exists in DB", async () => {
    setMockSession({ isLoggedIn: true, userId: "nonexistent-id"});
    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "teal" } });
    await expectJson(res, 401);
  });

  it("updates accent color successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "violet" } });
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("violet");
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.accentColor).toBe("violet");
  });

  it("returns 400 for invalid accent color name", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await prisma.appSettings.create({ data: { userId: user.id, accentColor: "teal" } });

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "neon-pink" } });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toMatch(/^Invalid accent color\. Must be one of: default, /);
    expect((await prisma.appSettings.findUnique({ where: { userId: user.id } }))?.accentColor).toBe("teal");
  });

  it("returns 400 for empty accent color", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "" } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["accentColor: Accent color is required"]);
  });

  it("returns 400 for missing accentColor field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(await prisma.appSettings.count()).toBe(0);
  });
});
