import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
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

const { mockEnqueueJob } = vi.hoisted(() => ({
  mockEnqueueJob: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: mockEnqueueJob,
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/servers/[id]/sync/route";
import { TASK_SYNC_SERVER, MAIN_QUEUE, REQUESTED_SYNC_PRIORITY } from "@/lib/jobs/constants";
import { getTestPrisma } from "../../setup/test-db";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";

describe("POST /api/servers/[id]/sync", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockEnqueueJob.mockResolvedValue(true);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRouteWithParams(
      POST,
      { id: "nonexistent" },
      {
        url: "/api/servers/nonexistent/sync",
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 when server does not exist", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: "00000000-0000-0000-0000-000000000000" },
      {
        url: "/api/servers/00000000-0000-0000-0000-000000000000/sync",
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("returns 404 when server belongs to another user", async () => {
    const user1 = await createTestUser({ plexId: "owner" });
    const user2 = await createTestUser({ plexId: "other" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("enqueues a sync job and returns success message", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ message: string }>(response, 200);

    expect(body.message).toBe("Sync started");
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      {
        serverId: server.id,
        libraryKey: undefined,
        trigger: "manual sync request for this server",
        syncJobId: expect.any(String),
      },
      // Ahead of background work already queued (Tracearr backfill slices,
      // watch-history refreshes): someone is waiting on this one.
      expect.objectContaining({
        jobKey: `sync:${server.id}`,
        queueName: MAIN_QUEUE,
        priority: REQUESTED_SYNC_PRIORITY,
      }),
    );
  });

  it("returns the enqueue time, taken before the job is enqueued", async () => {
    // The settings page ends a Sync request only on a job stamped `startedAt`
    // at or after this time. It must come from the server clock the worker
    // stamps with, and precede the enqueue, or a fast job could read as older
    // than the request that started it.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    let enqueuedAt = 0;
    mockEnqueueJob.mockImplementationOnce(async () => {
      enqueuedAt = Date.now();
      return true;
    });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      { url: `/api/servers/${server.id}/sync`, method: "POST" },
    );
    const body = await expectJson<{ requestedAt: string }>(response, 200);

    expect(typeof body.requestedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.requestedAt))).toBe(false);
    expect(Date.parse(body.requestedAt)).toBeLessThanOrEqual(enqueuedAt);
  });

  it("returns 409 when a sync is already running for the server", async () => {
    const { getTestPrisma } = await import("../../setup/test-db");
    const testPrisma = getTestPrisma();

    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Create an existing RUNNING sync job
    await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "RUNNING" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe("A sync is already running for this server");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("returns 409 when a sync is pending for the server", async () => {
    const { getTestPrisma } = await import("../../setup/test-db");
    const testPrisma = getTestPrisma();

    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Create an existing PENDING sync job (queued behind another sync)
    await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "PENDING" },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
      }
    );
    const body = await expectJson<{ error: string }>(response, 409);
    expect(body.error).toBe("A sync is already running for this server");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("scopes the enqueued job to a specific library when provided", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { key: "lib-key", title: "Movies" });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
        body: { libraryKey: library.key },
      }
    );
    await expectJson<{ message: string }>(response, 200);

    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      {
        serverId: server.id,
        libraryKey: "lib-key",
        trigger: "manual sync request for this server",
        syncJobId: expect.any(String),
      },
      expect.objectContaining({ jobKey: `sync:${server.id}:lib-key`, queueName: MAIN_QUEUE }),
    );
  });

  it("creates the PENDING row at request time and hands it to the job", async () => {
    // MAIN_QUEUE is serial, so the job can wait minutes behind other work.
    // Without a row until the worker reached it, the page had nothing to show
    // and the click looked ignored for as long as the queue was busy.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const events: AppEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    try {
      const response = await callRouteWithParams(
        POST,
        { id: server.id },
        { url: `/api/servers/${server.id}/sync`, method: "POST" },
      );
      const body = await expectJson<{ requestedAt: string }>(response, 200);

      const rows = await getTestPrisma().syncJob.findMany({ where: { mediaServerId: server.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("PENDING");
      // Equal to requestedAt, so the page treats it as this request's run.
      expect(rows[0].startedAt.toISOString()).toBe(body.requestedAt);

      const payload = mockEnqueueJob.mock.calls[0][1] as { syncJobId: string };
      expect(payload.syncJobId).toBe(rows[0].id);

      // Every open tab refetches and shows the sync as queued straight away.
      expect(events.filter((e) => e.type === "sync:started")).toEqual([
        expect.objectContaining({ type: "sync:started", userId: user.id, meta: { serverId: server.id } }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("closes the row and reports an error when the job could not be queued", async () => {
    // Nothing would ever claim the row, and a PENDING row makes this route
    // answer 409 until a restart.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockEnqueueJob.mockResolvedValueOnce(false);

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      { url: `/api/servers/${server.id}/sync`, method: "POST" },
    );
    const body = await expectJson<{ error: string }>(response, 500);
    expect(body.error).toBe("Could not queue the sync job");

    const rows = await getTestPrisma().syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("FAILED");

    // ...so the next request is accepted rather than refused as a duplicate.
    const retry = await callRouteWithParams(
      POST,
      { id: server.id },
      { url: `/api/servers/${server.id}/sync`, method: "POST" },
    );
    expect(retry.status).toBe(200);
  });

  it("accepts only one of two requests that arrive together", async () => {
    // Both used to pass the duplicate check before either created its row, so
    // each created one; the second enqueue replaced the first job's payload,
    // and the first row sat PENDING with nothing to claim it.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const post = () =>
      callRouteWithParams(
        POST,
        { id: server.id },
        { url: `/api/servers/${server.id}/sync`, method: "POST" },
      );
    const statuses = (await Promise.all([post(), post(), post()])).map((r) => r.status).sort();

    expect(statuses).toEqual([200, 409, 409]);
    const rows = await getTestPrisma().syncJob.findMany({ where: { mediaServerId: server.id } });
    expect(rows).toHaveLength(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });
});
