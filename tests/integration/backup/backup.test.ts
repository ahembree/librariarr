import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
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
const mockCreateBackup = vi.hoisted(() => vi.fn());
const mockListBackups = vi.hoisted(() => vi.fn());
const mockGetBackupPassphrase = vi.hoisted(() => vi.fn());
const mockGetBackupFilePath = vi.hoisted(() => vi.fn());
const mockDeleteBackup = vi.hoisted(() => vi.fn());
const mockRestoreBackup = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backup/backup-service", () => ({
  createBackup: mockCreateBackup,
  listBackups: mockListBackups,
  getBackupPassphrase: mockGetBackupPassphrase,
  getBackupFilePath: mockGetBackupFilePath,
  deleteBackup: mockDeleteBackup,
  restoreBackup: mockRestoreBackup,
}));

// Mock fs/promises for the [filename] route (download)
const mockReadFile = vi.hoisted(() => vi.fn());
vi.mock("fs/promises", () => ({
  readFile: mockReadFile,
  stat: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  access: vi.fn(),
  mkdir: vi.fn(),
  default: {
    readFile: mockReadFile,
    stat: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    access: vi.fn(),
    mkdir: vi.fn(),
  },
}));

// Import route handlers AFTER mocks
import { GET as listBackups, POST as createBackup } from "@/app/api/backup/route";
import {
  GET as downloadBackup,
  DELETE as deleteBackupRoute,
} from "@/app/api/backup/[filename]/route";
import { POST as restoreBackup } from "@/app/api/backup/restore/route";

describe("Backup endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockListBackups.mockResolvedValue([]);
    mockGetBackupPassphrase.mockResolvedValue(null);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/backup (list) -----
  describe("GET /api/backup", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(listBackups, { url: "/api/backup" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty list when no backups exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(listBackups, { url: "/api/backup" });
      const body = await expectJson<{ backups: unknown[] }>(response, 200);
      expect(body.backups).toEqual([]);
    });

    it("returns list of backups", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockListBackups.mockResolvedValue([
        {
          filename: "backup-2024-01-01.json.gz",
          size: 12345,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
        {
          filename: "backup-2024-01-02.json.gz",
          size: 67890,
          createdAt: "2024-01-02T00:00:00.000Z",
        },
      ]);

      const response = await callRoute(listBackups, { url: "/api/backup" });
      const body = await expectJson<{ backups: unknown[] }>(response, 200);
      expect(body.backups).toHaveLength(2);
    });
  });

  // ----- POST /api/backup (create) -----
  describe("POST /api/backup", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 on invalid body (passphrase too short)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: { passphrase: "short" },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("creates backup successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockCreateBackup.mockResolvedValue("backup-2024-01-01.json.gz");

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ success: boolean; filename: string }>(response, 200);
      expect(body.success).toBe(true);
      expect(body.filename).toBe("backup-2024-01-01.json.gz");
    });

    it("uses saved passphrase as fallback when none provided", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetBackupPassphrase.mockResolvedValue("saved-secret-passphrase");
      mockCreateBackup.mockResolvedValue("backup-encrypted.json.gz.enc");

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ success: boolean; filename: string }>(response, 200);
      expect(body.success).toBe(true);
      expect(mockCreateBackup).toHaveBeenCalledWith("saved-secret-passphrase", true);
    });

    it("uses explicit passphrase over saved one", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetBackupPassphrase.mockResolvedValue("saved-passphrase-value");
      mockCreateBackup.mockResolvedValue("backup-encrypted.json.gz.enc");

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: { passphrase: "explicit-passphrase" },
      });
      await expectJson<{ success: boolean }>(response, 200);
      expect(mockCreateBackup).toHaveBeenCalledWith("explicit-passphrase", true);
    });
  });

  // ----- GET /api/backup/[filename] (download) -----
  describe("GET /api/backup/[filename]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "backup.json.gz" },
        { url: "/api/backup/backup.json.gz" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent file", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetBackupFilePath.mockReturnValue("/backups/missing.json.gz");
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));

      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "missing.json.gz" },
        { url: "/api/backup/missing.json.gz" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Backup not found");
    });

    it("returns 400 for invalid filename", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetBackupFilePath.mockReturnValue(null);

      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "../../../etc/passwd" },
        { url: "/api/backup/../../../etc/passwd" }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Invalid filename");
    });
  });

  // ----- DELETE /api/backup/[filename] -----
  describe("DELETE /api/backup/[filename]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        deleteBackupRoute,
        { filename: "backup.json.gz" },
        { url: "/api/backup/backup.json.gz", method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 for non-existent file", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockDeleteBackup.mockResolvedValue(false);

      const response = await callRouteWithParams(
        deleteBackupRoute,
        { filename: "missing.json.gz" },
        { url: "/api/backup/missing.json.gz", method: "DELETE" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Backup not found");
    });

    it("deletes backup successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockDeleteBackup.mockResolvedValue(true);

      const response = await callRouteWithParams(
        deleteBackupRoute,
        { filename: "backup-2024-01-01.json.gz" },
        { url: "/api/backup/backup-2024-01-01.json.gz", method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);
    });
  });

  // ----- POST /api/backup/restore -----
  describe("POST /api/backup/restore", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(restoreBackup, {
        url: "/api/backup/restore",
        method: "POST",
        body: { filename: "backup.json.gz" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 400 on invalid body (missing filename)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(restoreBackup, {
        url: "/api/backup/restore",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });
  });
});
