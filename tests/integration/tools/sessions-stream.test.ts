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

// Mock the media server factory - stream route uses createMediaServerClient
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockImplementation(function () {
    return {
      getSessions: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/tools/sessions/stream/route";

describe("GET /api/tools/sessions/stream", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/tools/sessions/stream",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns correct content-type header (text/event-stream)", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/stream",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");

    // Cancel the stream to clean up
    if (response.body) {
      await response.body.cancel();
    }
  });

  it("returns a readable stream", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/stream",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
    expect(response.body).toBeInstanceOf(ReadableStream);

    // Read the initial data from the stream
    const reader = response.body!.getReader();
    const { value, done } = await reader.read();

    // Should receive an initial SSE event (sessions data)
    expect(done).toBe(false);
    expect(value).toBeDefined();

    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: sessions");
    expect(text).toContain("data:");

    // Cancel the reader to clean up
    await reader.cancel();
  });
});
