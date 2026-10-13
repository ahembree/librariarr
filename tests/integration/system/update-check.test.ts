import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockCheckForUpdate } = vi.hoisted(() => ({ mockCheckForUpdate: vi.fn() }));
vi.mock("@/lib/version/update-checker", () => ({ checkForUpdate: mockCheckForUpdate }));

// Import route handler AFTER mocks
import { GET } from "@/app/api/system/update-check/route";

describe("GET /api/system/update-check", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/system/update-check" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it("returns whether a newer release exists and where it is", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/ahembree/librariarr/releases/tag/v1.1.0",
      releaseName: "v1.1.0",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await callRoute(GET, { url: "/api/system/update-check" });
    const body = await expectJson<Record<string, unknown>>(response, 200);

    expect(body).toEqual({
      updateAvailable: true,
      latestVersion: "1.1.0",
      releaseUrl: "https://github.com/ahembree/librariarr/releases/tag/v1.1.0",
    });
  });

  it("answers with no release when GitHub could not be asked", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await callRoute(GET, { url: "/api/system/update-check" });
    const body = await expectJson<Record<string, unknown>>(response, 200);

    expect(body).toEqual({ updateAvailable: false, latestVersion: null, releaseUrl: null });
  });
});
