import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
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

// Import AFTER mocks
import { GET, PUT } from "@/app/api/settings/auth/route";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/auth
// ---------------------------------------------------------------------------
describe("GET /api/settings/auth", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns current auth settings", async () => {
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{
      plexConnected: boolean;
      localAuthEnabled: boolean;
      hasPassword: boolean;
      displayName: string;
    }>(res);
    expect(body.localAuthEnabled).toBe(true);
    expect(body.plexConnected).toBe(true);
    expect(body.hasPassword).toBe(false);
    expect(body.displayName).toBe("testuser");
  });

  it("returns default localAuthEnabled=false when no AppSettings exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ localAuthEnabled: boolean }>(res);
    expect(body.localAuthEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/auth
// ---------------------------------------------------------------------------
describe("PUT /api/settings/auth", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: true },
    });
    await expectJson(res, 401);
  });

  it("returns 400 on invalid body", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: "not-a-boolean" },
    });
    await expectJson(res, 400);
  });

  it("updates localAuthEnabled to true", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { localAuthEnabled: true },
    });
    const body = await expectJson<{ localAuthEnabled: boolean }>(res);
    expect(body.localAuthEnabled).toBe(true);

    // Verify persisted
    const settings = await prisma.appSettings.findUnique({
      where: { userId: user.id },
    });
    expect(settings?.localAuthEnabled).toBe(true);
  });
});
