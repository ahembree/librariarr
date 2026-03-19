import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
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
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup.json.gz" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when filename is missing", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when filename is empty string", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("streams progress and complete events on successful restore", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockRestoreBackup.mockImplementation(
      async (
        _filename: string,
        _passphrase: string | undefined,
        onProgress: (progress: Record<string, unknown>) => void
      ) => {
        onProgress({ phase: "truncate", message: "Truncating tables..." });
        onProgress({
          phase: "restore",
          message: "Restoring User table...",
          table: "User",
          tableIndex: 1,
          tableCount: 5,
        });
      }
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup-2024-01-01.json.gz" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const events = await readNdjsonStream(response);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "progress", phase: "truncate" });
    expect(events[1]).toMatchObject({
      type: "progress",
      phase: "restore",
      table: "User",
      tableIndex: 1,
      tableCount: 5,
    });
    expect(events[2]).toMatchObject({ type: "complete" });
  });

  it("passes passphrase to restoreBackup when provided", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockRestoreBackup.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup.json.gz.enc", passphrase: "my-secret-pass" },
    });

    expect(response.status).toBe(200);
    await readNdjsonStream(response); // consume the stream

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "backup.json.gz.enc",
      "my-secret-pass",
      expect.any(Function)
    );
  });

  it("calls restoreBackup without passphrase when not provided", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockRestoreBackup.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup.json.gz" },
    });

    expect(response.status).toBe(200);
    await readNdjsonStream(response);

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "backup.json.gz",
      undefined,
      expect.any(Function)
    );
  });

  it("streams error event when restore fails with Error", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockRestoreBackup.mockRejectedValue(
      new Error("Invalid backup file format")
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup.json.gz" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    const errorEvent = events.find(
      (e) => (e as { type: string }).type === "error"
    );
    expect(errorEvent).toMatchObject({
      type: "error",
      message: "Invalid backup file format",
    });
  });

  it("streams generic error when non-Error is thrown", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockRestoreBackup.mockRejectedValue("unexpected failure");

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup.json.gz" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    const errorEvent = events.find(
      (e) => (e as { type: string }).type === "error"
    );
    expect(errorEvent).toMatchObject({
      type: "error",
      message: "Restore failed",
    });
  });

  it("streams progress events before error when restore partially succeeds", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockRestoreBackup.mockImplementation(
      async (
        _filename: string,
        _passphrase: string | undefined,
        onProgress: (progress: { phase: string; message: string }) => void
      ) => {
        onProgress({ phase: "decrypt", message: "Decrypting backup..." });
        onProgress({ phase: "truncate", message: "Truncating tables..." });
        throw new Error("Failed to restore MediaServer table");
      }
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore",
      method: "POST",
      body: { filename: "backup.json.gz.enc", passphrase: "test-pass" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "progress", phase: "decrypt" });
    expect(events[1]).toMatchObject({ type: "progress", phase: "truncate" });
    expect(events[2]).toMatchObject({
      type: "error",
      message: "Failed to restore MediaServer table",
    });
  });
});
