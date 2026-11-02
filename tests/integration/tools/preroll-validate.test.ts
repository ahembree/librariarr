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

// Mock fs/promises access function
const mockAccess = vi.hoisted(() => vi.fn());
vi.mock("fs/promises", () => ({
  access: mockAccess,
  constants: { R_OK: 4 },
  default: {
    access: mockAccess,
    constants: { R_OK: 4 },
  },
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/tools/preroll/validate-path/route";

describe("POST /api/tools/preroll/validate-path", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/tools/preroll/validate-path",
      method: "POST",
      body: { path: "/media/preroll.mp4" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 on missing path", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/tools/preroll/validate-path",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^path: /)]);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it("returns exists:true for accessible path", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockAccess.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/tools/preroll/validate-path",
      method: "POST",
      body: { path: "/media/preroll.mp4" },
    });
    const body = await expectJson<{ exists: boolean }>(response, 200);
    expect(body).toEqual({ exists: true });
    // Checked for readability, as the media server will need to read it.
    expect(mockAccess).toHaveBeenCalledExactlyOnceWith("/media/preroll.mp4", 4);
  });

  it("returns exists:false for inaccessible path", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockAccess.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    const response = await callRoute(POST, {
      url: "/api/tools/preroll/validate-path",
      method: "POST",
      body: { path: "/media/missing.mp4" },
    });
    const body = await expectJson<{ exists: boolean }>(response, 200);
    expect(body).toEqual({ exists: false });
  });

  // The route probes the app's own filesystem, so it answers only for the
  // directories prerolls are kept in — never "does /etc/shadow exist".
  it.each([
    ["a path outside every allowed directory", "/etc/passwd"],
    ["a sibling sharing an allowed prefix", "/media-secret/preroll.mp4"],
    ["a traversal out of an allowed directory", "/media/../etc/passwd"],
    ["a relative path", "prerolls/intro.mp4"],
  ])("refuses %s without touching the filesystem", async (_label, path) => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    mockAccess.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/tools/preroll/validate-path",
      method: "POST",
      body: { path },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body).toEqual({ error: "Path is outside allowed directories" });
    expect(mockAccess).not.toHaveBeenCalled();
  });
});
