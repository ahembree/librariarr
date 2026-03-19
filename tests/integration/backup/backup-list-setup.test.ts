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
  });

  it("returns empty backup list when no users and no backups exist", async () => {
    const response = await callRoute(GET, {
      url: "/api/backup/list-setup",
    });
    const body = await expectJson<{ backups: unknown[] }>(response, 200);
    expect(body.backups).toEqual([]);
  });

  it("returns backup list when no users exist", async () => {
    mockListBackups.mockResolvedValue([
      {
        filename: "backup-2024-01-01.json.gz",
        size: 12345,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        filename: "backup-2024-01-02.json.gz.enc",
        size: 67890,
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    ]);

    const response = await callRoute(GET, {
      url: "/api/backup/list-setup",
    });
    const body = await expectJson<{ backups: unknown[] }>(response, 200);
    expect(body.backups).toHaveLength(2);
    expect(mockListBackups).toHaveBeenCalledOnce();
  });

  it("does not require authentication (setup endpoint)", async () => {
    // No session set - should still work when no users exist
    const response = await callRoute(GET, {
      url: "/api/backup/list-setup",
    });
    const body = await expectJson<{ backups: unknown[] }>(response, 200);
    expect(body.backups).toEqual([]);
  });
});
