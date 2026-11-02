import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
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

// Mock backup service
const mockListBackups = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backup/backup-service", () => ({
  listBackups: mockListBackups,
}));

// The real limiter is exercised in tests/integration/auth/setup-rate-limit.test.ts;
// here it would make the eleventh request of the file a 429.
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  SETUP_BUCKET: "setup",
  checkAuthRateLimit: () => null,
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/backup/list-setup/route";

describe("GET /api/backup/list-setup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockListBackups.mockResolvedValue([]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 403 when users already exist", async () => {
    await createTestUser();

    const response = await callRoute(GET, {
      url: "/api/backup/list-setup",
    });
    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toBe("Setup already completed");
    // The listing is never even read once an admin exists.
    expect(mockListBackups).not.toHaveBeenCalled();
  });

  it("returns an empty list, without a session, when no users and no backups exist", async () => {
    // No session: the endpoint serves the setup screen, before anyone can sign in.
    const response = await callRoute(GET, {
      url: "/api/backup/list-setup",
    });
    const body = await expectJson<{ backups: unknown[] }>(response, 200);
    expect(body.backups).toEqual([]);
  });

  it("returns backup list when no users exist", async () => {
    // The shape `listBackups` returns: sidecar metadata plus the file's size.
    const backups = [
      {
        filename: "librariarr-backup-2024-01-02T03-00-00.json.gz.enc",
        createdAt: "2024-01-02T03:00:00.000Z",
        size: 67890,
        tables: { user: 1, appSettings: 1, mediaServer: 2 },
        encrypted: true,
        configOnly: true,
      },
      {
        filename: "librariarr-backup-2024-01-01T03-00-00.json.gz",
        createdAt: "2024-01-01T03:00:00.000Z",
        size: 12345,
        tables: { user: 1, appSettings: 1, mediaServer: 2, mediaItem: 1500 },
        encrypted: false,
        configOnly: false,
      },
    ];
    mockListBackups.mockResolvedValue(backups);

    const response = await callRoute(GET, {
      url: "/api/backup/list-setup",
    });
    const body = await expectJson<{ backups: unknown[] }>(response, 200);
    expect(body.backups).toEqual(backups);
    expect(mockListBackups).toHaveBeenCalledOnce();
  });
});
