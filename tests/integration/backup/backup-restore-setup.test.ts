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

// Import route handler AFTER mocks
import { POST } from "@/app/api/backup/restore-setup/route";

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
      body: { filename: "backup.json.gz" },
    });
    const body = await expectJson<{ error: string }>(response, 403);
    expect(body.error).toBe("Setup already completed");
  });

  it("returns 400 when filename is missing", async () => {
    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when body is empty string filename", async () => {
    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("streams progress and complete events on successful restore", async () => {
    mockRestoreBackup.mockImplementation(
      async (
        _filename: string,
        _passphrase: string | undefined,
        onProgress: (progress: { phase: string; message: string }) => void
      ) => {
        onProgress({ phase: "truncate", message: "Truncating tables..." });
        onProgress({ phase: "restore", message: "Restoring User table..." });
      }
    );

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "backup-2024-01-01.json.gz" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");

    const events = await readNdjsonStream(response);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "progress", phase: "truncate" });
    expect(events[1]).toMatchObject({ type: "progress", phase: "restore" });
    expect(events[2]).toMatchObject({ type: "complete" });
  });

  it("passes passphrase to restoreBackup", async () => {
    mockRestoreBackup.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "backup.json.gz.enc", passphrase: "my-secret" },
    });

    expect(response.status).toBe(200);
    await readNdjsonStream(response); // consume the stream

    expect(mockRestoreBackup).toHaveBeenCalledWith(
      "backup.json.gz.enc",
      "my-secret",
      expect.any(Function)
    );
  });

  it("streams error event when restore fails", async () => {
    mockRestoreBackup.mockRejectedValue(new Error("Decryption failed"));

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "backup.json.gz.enc" },
    });

    expect(response.status).toBe(200);

    const events = await readNdjsonStream(response);
    const errorEvent = events.find(
      (e) => (e as { type: string }).type === "error"
    );
    expect(errorEvent).toMatchObject({
      type: "error",
      message: "Decryption failed",
    });
  });

  it("streams generic error when non-Error is thrown", async () => {
    mockRestoreBackup.mockRejectedValue("something went wrong");

    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
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

  it("does not require authentication (setup endpoint)", async () => {
    mockRestoreBackup.mockResolvedValue(undefined);

    // No session set - should still work when no users exist
    const response = await callRoute(POST, {
      url: "/api/backup/restore-setup",
      method: "POST",
      body: { filename: "backup.json.gz" },
    });

    expect(response.status).toBe(200);
  });
});
