import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

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
import { GET } from "@/app/api/auth/check-setup/route";

describe("GET /api/auth/check-setup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns setupRequired true when no users exist", async () => {
    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(true);
  });

  it("returns setupRequired false when a user exists", async () => {
    await createTestUser();

    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(false);
  });

  it("returns localAuthEnabled true when AppSettings has it enabled", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    await prisma.appSettings.create({
      data: { userId: user.id, localAuthEnabled: true },
    });

    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(false);
    expect(body.localAuthEnabled).toBe(true);
  });

  it("returns localAuthEnabled false when no AppSettings exist", async () => {
    // User exists but no AppSettings row
    await createTestUser();

    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(false);
    expect(body.localAuthEnabled).toBe(false);
  });

  it("returns localAuthEnabled false when no users exist (skips AppSettings query)", async () => {
    const response = await callRoute(GET, {
      url: "/api/auth/check-setup",
    });
    const body = await expectJson<{ setupRequired: boolean; localAuthEnabled: boolean }>(response, 200);
    expect(body.setupRequired).toBe(true);
    // localAuthEnabled defaults to false when setupRequired is true
    expect(body.localAuthEnabled).toBe(false);
  });
});
