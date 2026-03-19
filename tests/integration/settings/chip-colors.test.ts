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

import { GET, PUT } from "@/app/api/settings/chip-colors/route";

describe("GET /api/settings/chip-colors", () => {
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

  it("returns null when no chip colors saved", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ chipColors: unknown }>(res);
    expect(body.chipColors).toBeNull();
  });

  it("returns saved chip colors", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const colors = { resolution: { "4K": "#ff0000", "1080P": "#00ff00" } };
    await callRoute(PUT, { method: "PUT", body: { chipColors: colors } });

    const res = await callRoute(GET);
    const body = await expectJson<{ chipColors: typeof colors }>(res);
    expect(body.chipColors).toEqual(colors);
  });
});

describe("PUT /api/settings/chip-colors", () => {
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
      body: { chipColors: { resolution: { "4K": "#ff0000" } } },
    });
    await expectJson(res, 401);
  });

  it("saves chip colors successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const colors = { resolution: { "4K": "#ff0000" }, codec: { h264: "#0000ff" } };
    const res = await callRoute(PUT, { method: "PUT", body: { chipColors: colors } });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("returns 400 for invalid chipColors structure", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { chipColors: "not-an-object" } });
    await expectJson(res, 400);
  });

  it("returns 400 for missing chipColors field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    await expectJson(res, 400);
  });
});
