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

import { GET, PUT } from "@/app/api/settings/accent-color/route";

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
    setMockSession({ isLoggedIn: true, userId: "nonexistent-id", plexToken: "tok" });
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default accent color when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("default");
  });

  it("returns saved accent color", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Set a color first
    await callRoute(PUT, { method: "PUT", body: { accentColor: "blue" } });

    const res = await callRoute(GET);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("blue");
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
    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "blue" } });
    await expectJson(res, 401);
  });

  it("returns 401 when user no longer exists in DB", async () => {
    setMockSession({ isLoggedIn: true, userId: "nonexistent-id", plexToken: "tok" });
    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "blue" } });
    await expectJson(res, 401);
  });

  it("updates accent color successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "violet" } });
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("violet");
  });

  it("returns 400 for invalid accent color name", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "neon-pink" } });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid accent color");
  });

  it("returns 400 for empty accent color", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { accentColor: "" } });
    await expectJson(res, 400);
  });

  it("returns 400 for missing accentColor field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    await expectJson(res, 400);
  });
});
