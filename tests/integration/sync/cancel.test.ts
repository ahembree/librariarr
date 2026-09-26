import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser, createTestServer } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/sync/cancel/route";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";

async function cancel(serverId: string) {
  return callRoute(POST, { url: "/api/sync/cancel", method: "POST", body: { serverId } });
}

describe("POST /api/sync/cancel", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await cancel("whatever");
    await expectJson(response, 401);
  });

  it("returns 404 when the server does not exist", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const response = await cancel("missing");
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("returns 404 when no sync is active", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.syncJob.create({ data: { mediaServerId: server.id, status: "COMPLETED" } });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await cancel(server.id);
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("No active sync to cancel");
  });

  it("ends a still-queued sync at once and announces it", async () => {
    // The queue may not reach the job for minutes; a flag nobody reads until
    // then left the Pending card up after Stop was pressed.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const job = await prisma.syncJob.create({ data: { mediaServerId: server.id, status: "PENDING" } });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const events: AppEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    try {
      const response = await cancel(server.id);
      await expectJson(response, 200);
    } finally {
      unsubscribe();
    }

    const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelRequested).toBe(true);
    expect(row.completedAt).not.toBeNull();
    expect(events.filter((e) => e.type === "sync:failed")).toEqual([
      expect.objectContaining({ userId: user.id, meta: { serverId: server.id } }),
    ]);
  });

  it("only flags a running sync, which stops itself at its next checkpoint", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const job = await prisma.syncJob.create({ data: { mediaServerId: server.id, status: "RUNNING" } });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await cancel(server.id);
    await expectJson(response, 200);

    const row = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("RUNNING");
    expect(row.cancelRequested).toBe(true);
  });
});
