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
import { GET, PUT } from "@/app/api/settings/realtime/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("GET /api/settings/realtime", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("defaults realtimeSync to true when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ realtimeSync: boolean }>(res);
    expect(body.realtimeSync).toBe(true);
  });

  it("returns the saved value after PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, { method: "PUT", body: { realtimeSync: false } });

    const res = await callRoute(GET);
    const body = await expectJson<{ realtimeSync: boolean }>(res);
    expect(body.realtimeSync).toBe(false);
  });
});

describe("PUT /api/settings/realtime", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, { method: "PUT", body: { realtimeSync: false } });
    await expectJson(res, 401);
  });

  it("saves realtimeSync=false", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { realtimeSync: false } });
    const body = await expectJson<{ realtimeSync: boolean }>(res);
    expect(body.realtimeSync).toBe(false);
  });

  it("returns 400 when realtimeSync is missing", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when realtimeSync is not a boolean", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { realtimeSync: "yes" } });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("toggles back and forth", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, { method: "PUT", body: { realtimeSync: false } });
    let body = await expectJson<{ realtimeSync: boolean }>(await callRoute(GET));
    expect(body.realtimeSync).toBe(false);

    await callRoute(PUT, { method: "PUT", body: { realtimeSync: true } });
    body = await expectJson<{ realtimeSync: boolean }>(await callRoute(GET));
    expect(body.realtimeSync).toBe(true);
  });
});
