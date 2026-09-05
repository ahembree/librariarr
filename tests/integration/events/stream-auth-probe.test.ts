import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { HEAD } from "@/app/api/events/stream/route";

/**
 * The client hook cannot see an HTTP status from `EventSource` — a 401 arrives
 * as a bare `error` with readyState CLOSED, identical to a dropped connection.
 * Without this probe the hook retried an expired session every 30s forever,
 * silently, and the page never updated or prompted a login.
 */
describe("GET /api/events/stream — auth probe (HEAD)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("answers 401 with no body for a signed-out caller", async () => {
    clearMockSession();

    const res = await HEAD();

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("answers 200 with no body for a valid session", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const res = await HEAD();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("returns immediately instead of opening an SSE stream", async () => {
    // Next.js derives HEAD from GET when no HEAD is exported, which would open
    // (and hold) a real event stream for every probe. This asserts the explicit
    // handler is the one answering: a streaming response would neither resolve
    // this fast nor carry an empty body.
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const started = Date.now();
    const res = await Promise.race([
      HEAD(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("HEAD did not resolve — it opened a stream")), 2000),
      ),
    ]);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
