import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

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

// Import route handler AFTER mocks
import { GET } from "@/app/api/system/info/route";

describe("GET /api/system/info", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/system/info" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns system info with version and stats", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/system/info" });
    const body = await expectJson<{
      appVersion: string;
      latestMigration: string;
      databaseSize: string;
      stats: {
        mediaItems: number;
        enabledLibraries: number;
        totalLibraries: number;
        servers: number;
      };
    }>(response, 200);

    expect(body.appVersion).toBeDefined();
    expect(body.latestMigration).toBeDefined();
    expect(body.databaseSize).toBeDefined();
    expect(body.stats.mediaItems).toBe(0);
    expect(body.stats.enabledLibraries).toBe(0);
    expect(body.stats.totalLibraries).toBe(0);
    expect(body.stats.servers).toBe(0);
  });

  it("returns correct counts with data", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library1 = await createTestLibrary(server.id, { title: "Movies", enabled: true });
    await createTestLibrary(server.id, { title: "TV Shows", enabled: false });
    await createTestMediaItem(library1.id, { title: "Test Movie 1" });
    await createTestMediaItem(library1.id, { title: "Test Movie 2" });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/system/info" });
    const body = await expectJson<{
      stats: {
        mediaItems: number;
        enabledLibraries: number;
        totalLibraries: number;
        servers: number;
      };
    }>(response, 200);

    expect(body.stats.mediaItems).toBe(2);
    expect(body.stats.enabledLibraries).toBe(1);
    expect(body.stats.totalLibraries).toBe(2);
    expect(body.stats.servers).toBe(1);
  });

  it("returns database size as a string", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: "/api/system/info" });
    const body = await expectJson<{ databaseSize: string }>(response, 200);

    // pg_size_pretty returns strings like "8192 kB" or "7 MB"
    expect(typeof body.databaseSize).toBe("string");
    expect(body.databaseSize.length).toBeGreaterThan(0);
  });
});
