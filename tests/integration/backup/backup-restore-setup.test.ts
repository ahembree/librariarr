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
const mockRestoreBackup = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backup/backup-service", () => ({
  restoreBackup: mockRestoreBackup,
}));

// The real limiter is exercised in tests/integration/auth/setup-rate-limit.test.ts;
// here it would make the eleventh request of the file a 429.
vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  SETUP_BUCKET: "setup",
  checkAuthRateLimit: () => null,
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/backup/restore-setup/route";
import type { RestoreProgress } from "@/lib/backup/backup-service";

// Helper to read NDJSON stream into parsed events
async function readNdjsonStream(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("POST /api/backup/restore-setup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 403 when users already exist", async () => {
    await createTestUser();

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });
    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toBe("Setup already completed");
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("returns 400 when filename is missing", async () => {
    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^filename: /);
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("returns 400 when body is empty string filename", async () => {
    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(response, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual(["filename: Filename is required"]);
    expect(mockRestoreBackup).not.toHaveBeenCalled();
  });

  it("streams progress and complete events on successful restore", async () => {
    mockRestoreBackup.mockImplementation(
      async (
        _filename: string,
        _passphrase: string | undefined,
        onProgress: (progress: RestoreProgress) => void
      ) => {
        onProgress({ phase: "truncate", message: "Clearing existing data..." });
        onProgress({ phase: "restore", message: "Restoring user (1 rows)...", table: "user", tableIndex: 1, tableCount: 23, rowsInserted: 0, totalRows: 1 });
      }
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");

    const events = await readNdjsonStream(response);
    expect(events).toEqual([
      { type: "progress", phase: "truncate", message: "Clearing existing data..." },
      {
        type: "progress",
        phase: "restore",
        message: "Restoring user (1 rows)...",
        table: "user",
        tableIndex: 1,
        tableCount: 23,
        rowsInserted: 0,
        totalRows: 1,
      },
      { type: "complete" },
    ]);
  });

  it("passes passphrase to restoreBackup", async () => {
    mockRestoreBackup.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz.enc", passphrase: "my-secret" },
    });

    expect(response.status).toBe(200);
    await readNdjsonStream(response); // consume the stream

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "librariarr-backup-2024-01-01T03-00-00.json.gz.enc",
      "my-secret",
      expect.any(Function)
    );
  });

  it("streams error event when restore fails", async () => {
    mockRestoreBackup.mockRejectedValue(new Error("Decryption failed — wrong passphrase or corrupted backup"));

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz.enc" },
    });

    expect(response.status).toBe(200);

    // An error ends the stream: no "complete" after it.
    const events = await readNdjsonStream(response);
    expect(events).toEqual([
      { type: "error", message: "Decryption failed — wrong passphrase or corrupted backup" },
    ]);
  });

  it("streams generic error when non-Error is thrown", async () => {
    mockRestoreBackup.mockRejectedValue("something went wrong");

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    expect(events).toEqual([{ type: "error", message: "Restore failed" }]);
  });

  it("does not require authentication (setup endpoint)", async () => {
    mockRestoreBackup.mockResolvedValue(undefined);

    // No session set - should still work when no users exist
    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "librariarr-backup-2024-01-01T03-00-00.json.gz" },
    });

    expect(response.status).toBe(200);
    expect(await readNdjsonStream(response)).toEqual([{ type: "complete" }]);
    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "librariarr-backup-2024-01-01T03-00-00.json.gz",
      undefined,
      expect.any(Function)
    );
  });
});
