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
    // No saved encryption password (the service answers undefined, not null).
    mockGetBackupPassphrase.mockResolvedValue(undefined);
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

      // The shape `listBackups` returns: sidecar metadata plus the file's size.
      const backups = [
        {
          filename: "librariarr-backup-2024-01-02T03-00-00.json.gz",
          createdAt: "2024-01-02T03:00:00.000Z",
          size: 67890,
          tables: { user: 1, appSettings: 1, mediaServer: 1, mediaItem: 1200 },
          encrypted: false,
          configOnly: false,
        },
        {
          filename: "librariarr-backup-2024-01-01T03-00-00.json.gz",
          createdAt: "2024-01-01T03:00:00.000Z",
          size: 12345,
          tables: { user: 1, appSettings: 1, mediaServer: 1 },
          encrypted: false,
          configOnly: true,
        },
      ];
      mockListBackups.mockResolvedValue(backups);

      const response = await callRoute(listBackups, { url: "/api/backup" });
      const body = await expectJson<{ backups: unknown[] }>(response, 200);
      expect(body.backups).toEqual(backups);
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

    // A backup holds the Plex token, and a Plex token is a sign-in that
    // passes every recent-login check — so making one needs a recent sign-in.
    it("asks a session signed in more than 15 minutes ago to confirm it's them", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() - 16 * 60 * 1000 });

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: { passphrase: "chosen-by-the-caller" },
      });
      const body = await expectJson<{ code: string; methods: string[] }>(response, 403);
      expect(body.code).toBe("reauth_required");
      expect(body.methods).toEqual(["plex"]);
      expect(mockCreateBackup).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid body (passphrase too short)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: { passphrase: "short" },
      });
      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toEqual(["passphrase: Passphrase must be at least 8 characters"]);
      expect(mockCreateBackup).not.toHaveBeenCalled();
    });

    it("creates backup successfully", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockCreateBackup.mockResolvedValue("librariarr-backup-2024-01-01T03-00-00.json.gz");

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ success: boolean; filename: string }>(response, 200);
      expect(body).toEqual({ success: true, filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" });
      // No passphrase given or saved: an unencrypted, config-only backup.
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined, true);
    });

    it("includes media data only when asked to", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockCreateBackup.mockResolvedValue("librariarr-backup-2024-01-01T03-00-00.json.gz");

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: { includeMediaData: true },
      });
      await expectJson(response, 200);
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined, false);
    });

    it("uses saved passphrase as fallback when none provided", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockGetBackupPassphrase.mockResolvedValue("saved-secret-passphrase");
      mockCreateBackup.mockResolvedValue("librariarr-backup-2024-01-01T03-00-00.json.gz.enc");

      const response = await callRoute(createBackup, {
        url: "/api/backup",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ success: boolean; filename: string }>(response, 200);
      expect(body).toEqual({ success: true, filename: "librariarr-backup-2024-01-01T03-00-00.json.gz.enc" });
      expect(mockCreateBackup).toHaveBeenCalledWith("saved-secret-passphrase", true);
    });

    it("uses explicit passphrase over saved one", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockGetBackupPassphrase.mockResolvedValue("saved-passphrase-value");
      mockCreateBackup.mockResolvedValue("librariarr-backup-2024-01-01T03-00-00.json.gz.enc");

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
        { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2024-01-01T03-00-00.json.gz" }
      );
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    // Scheduled backups sit in the same directory, so downloading needs the
    // recent sign-in too, not just creating.
    it("asks a session with no recent sign-in to confirm it's them", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      mockGetBackupFilePath.mockReturnValue("/config/backups/librariarr-backup-2024-01-01T03-00-00.json.gz");
      mockReadFile.mockResolvedValue(Buffer.from("backup bytes"));

      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2024-01-01T03-00-00.json.gz" }
      );
      const body = await expectJson<{ code: string }>(response, 403);
      expect(body.code).toBe("reauth_required");
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("sends the file to a session signed in recently", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockGetBackupFilePath.mockReturnValue("/config/backups/librariarr-backup-2024-01-01T03-00-00.json.gz");
      mockReadFile.mockResolvedValue(Buffer.from("backup bytes"));

      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2024-01-01T03-00-00.json.gz" }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toBe("application/gzip");
      expect(response.headers.get("Content-Disposition")).toBe(
        'attachment; filename="librariarr-backup-2024-01-01T03-00-00.json.gz"'
      );
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("backup bytes");
      expect(mockReadFile).toHaveBeenCalledWith("/config/backups/librariarr-backup-2024-01-01T03-00-00.json.gz");
    });

    it("returns 404 for non-existent file", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockGetBackupFilePath.mockReturnValue("/config/backups/librariarr-backup-2023-12-31T03-00-00.json.gz");
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));

      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "librariarr-backup-2023-12-31T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2023-12-31T03-00-00.json.gz" }
      );
      const body = await expectJson<{ error: string }>(response, 404);
      expect(body.error).toBe("Backup not found");
    });

    it("returns 400 for invalid filename", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      mockGetBackupFilePath.mockReturnValue(null);

      const response = await callRouteWithParams(
        downloadBackup,
        { filename: "../../../etc/passwd" },
        { url: "/api/backup/../../../etc/passwd" }
      );
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Invalid filename");
      expect(mockGetBackupFilePath).toHaveBeenCalledWith("../../../etc/passwd");
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });

  // ----- DELETE /api/backup/[filename] -----
  describe("DELETE /api/backup/[filename]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        deleteBackupRoute,
        { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2024-01-01T03-00-00.json.gz", method: "DELETE" }
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
        { filename: "librariarr-backup-2023-12-31T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2023-12-31T03-00-00.json.gz", method: "DELETE" }
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
        { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
        { url: "/api/backup/librariarr-backup-2024-01-01T03-00-00.json.gz", method: "DELETE" }
      );
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);
      expect(mockDeleteBackup).toHaveBeenCalledWith("librariarr-backup-2024-01-01T03-00-00.json.gz");
    });
  });

  // ----- POST /api/backup/restore -----
  describe("POST /api/backup/restore", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(restoreBackup, {
        url: "/api/backup/restore",
        method: "POST",
        body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
      });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    // A restore replaces the account's password hash, Plex link and SSO
    // identity with the file's.
    it("asks a session with no recent sign-in to confirm it's them", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(restoreBackup, {
        url: "/api/backup/restore",
        method: "POST",
        body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
      });
      const body = await expectJson<{ code: string }>(response, 403);
      expect(body.code).toBe("reauth_required");
      expect(mockRestoreBackup).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid body (missing filename)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

      const response = await callRoute(restoreBackup, {
        url: "/api/backup/restore",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
      expect(mockRestoreBackup).not.toHaveBeenCalled();
    });
  });
});
