import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession, getMockSession } from "../../setup/mock-session";
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
const { mockRestoreBackup, mockClearImageCache } = vi.hoisted(() => ({
  mockRestoreBackup: vi.fn(),
  mockClearImageCache: vi.fn(),
}));

vi.mock("@/lib/backup/backup-service", () => ({
  restoreBackup: mockRestoreBackup,
}));

// A successful restore clears the on-disk artwork cache; the real one would
// empty the host's /config/cache/images.
vi.mock("@/lib/image-cache/image-cache", () => ({
  clearImageCache: mockClearImageCache,
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/backup/restore/route";

// Helper to read NDJSON stream into parsed events
async function readNdjsonStream(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("POST /api/backup/restore", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockClearImageCache.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("returns 403 reauth_required for a sign-in older than 15 minutes, without restoring", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() - 16 * 60_000 });

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });
    const body = await expectJson<{ error: string; code: string }>(response, 403);
    expect(body.code).toBe("reauth_required");
    expect(body.error).toMatch(/^Restoring a backup needs a sign-in from the last 15 minutes\./);
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("returns 400 when filename is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^filename: /);
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("returns 400 when filename is empty string", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["filename: Filename is required"]);
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("streams progress and complete events on successful restore", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockRestoreBackup.mockImplementation(
      async (
        _filename: string,
        _passphrase: string | undefined,
        onProgress: (progress: Record<string, unknown>) => void
      ) => {
        onProgress({ phase: "truncate", message: "Clearing existing data..." });
        onProgress({
          phase: "restore",
          message: "Restoring user (1 rows)...",
          table: "user",
          tableIndex: 1,
          tableCount: 5,
          rowsInserted: 0,
          totalRows: 1,
        });
      }
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const events = await readNdjsonStream(response);
    expect(events).toEqual([
      { type: "progress", phase: "truncate", message: "Clearing existing data..." },
      {
        type: "progress",
        phase: "restore",
        message: "Restoring user (1 rows)...",
        table: "user",
        tableIndex: 1,
        tableCount: 5,
        rowsInserted: 0,
        totalRows: 1,
      },
      { type: "complete" },
    ]);
    // The restored rows replaced the artwork's items, and the restore revoked
    // every session — this one included, so its cookie is cleared.
    expect(mockClearImageCache).toHaveBeenCalledOnce();
    expect(getMockSession()).toMatchObject({ isLoggedIn: false, userId: undefined });
  });

  it("passes passphrase to restoreBackup when provided", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockRestoreBackup.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz.enc", passphrase: "my-secret-pass" },
    });

    expect(response.status).toBe(200);
    await readNdjsonStream(response); // consume the stream

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "librariarr-backup-2024-01-01T03-00-00.json.gz.enc",
      "my-secret-pass",
      expect.any(Function)
    );
  });

  it("calls restoreBackup without passphrase when not provided", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockRestoreBackup.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);
    await readNdjsonStream(response);

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "librariarr-backup-2024-01-01T03-00-00.json.gz",
      undefined,
      expect.any(Function)
    );
  });

  it("streams error event when restore fails with Error", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockRestoreBackup.mockRejectedValue(
      new Error("Decryption failed — wrong passphrase or corrupted backup")
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    expect(events).toEqual([
      { type: "error", message: "Decryption failed — wrong passphrase or corrupted backup" },
    ]);
    // A failed restore leaves the session and the artwork cache alone.
    expect(mockClearImageCache).not.toHaveBeenCalled();
    expect(getMockSession()).toMatchObject({ isLoggedIn: true, userId: user.id });
  });

  it("streams generic error when non-Error is thrown", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockRestoreBackup.mockRejectedValue("unexpected failure");

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    expect(events).toEqual([{ type: "error", message: "Restore failed" }]);
  });

  it("streams progress events before error when restore partially succeeds", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

    mockRestoreBackup.mockImplementation(
      async (
        _filename: string,
        _passphrase: string | undefined,
        onProgress: (progress: { phase: string; message: string }) => void
      ) => {
        onProgress({ phase: "decrypt", message: "Reading and decompressing backup..." });
        onProgress({ phase: "truncate", message: "Clearing existing data..." });
        throw new Error("Failed to restore table mediaServer: Unique constraint failed on the fields: (`id`)");
      }
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz.enc", passphrase: "test-pass" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    expect(events).toEqual([
      { type: "progress", phase: "decrypt", message: "Reading and decompressing backup..." },
      { type: "progress", phase: "truncate", message: "Clearing existing data..." },
      {
        type: "error",
        message: "Failed to restore table mediaServer: Unique constraint failed on the fields: (`id`)",
      },
    ]);
  });
});
