import { NextRequest } from "next/server";
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
    setMockSession({ userId: user.id, isLoggedIn: true });

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

  it("enqueues a sync job and returns success message", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    setMockSession({ userId: user.id, isLoggedIn: true });

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
    const row = await getTestPrisma().syncJob.findFirstOrThrow({ where: { mediaServerId: server.id } });
    expect(mockEnqueueJob).toHaveBeenCalledExactlyOnceWith(
      TASK_SYNC_SERVER,
      {
        serverId: server.id,
        libraryKey: undefined,
        trigger: "manual sync request for this server",
        syncJobId: row.id,
      },
      // Ahead of background work already queued (Tracearr backfill slices,
      // watch-history refreshes): someone is waiting on this one.
      {
        jobKey: `sync:${server.id}`,
        queueName: MAIN_QUEUE,
        maxAttempts: 3,
        priority: REQUESTED_SYNC_PRIORITY,
      },
    );
  });

  it("returns the enqueue time, taken before the job is enqueued", async () => {
    // The settings page ends a Sync request only on a job stamped `startedAt`
    // at or after this time. It must come from the server clock the worker
    // stamps with, and precede the enqueue, or a fast job could read as older
    // than the request that started it.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

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
    const testPrisma = getTestPrisma();

    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Create an existing RUNNING sync job
    await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "RUNNING" },
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

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
    expect(await testPrisma.syncJob.count()).toBe(1);
  });

  it("returns 409 when a sync is pending for the server", async () => {
    const testPrisma = getTestPrisma();

    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Create an existing PENDING sync job (queued behind another sync)
    await testPrisma.syncJob.create({
      data: { mediaServerId: server.id, status: "PENDING" },
    });

    setMockSession({ userId: user.id, isLoggedIn: true });

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
    expect(await testPrisma.syncJob.count()).toBe(1);
  });

  it("scopes the enqueued job to a specific library when provided", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { key: "lib-key", title: "Movies" });

    setMockSession({ userId: user.id, isLoggedIn: true });

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
      {
        jobKey: `sync:${server.id}:lib-key`,
        queueName: MAIN_QUEUE,
        maxAttempts: 3,
        priority: REQUESTED_SYNC_PRIORITY,
      },
    );
  });

  it("refuses a library key that is not on this server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const other = await createTestServer(user.id, { name: "Other" });
    await createTestLibrary(other.id, { key: "lib-elsewhere", title: "Movies" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRouteWithParams(
      POST,
      { id: server.id },
      { url: `/api/servers/${server.id}/sync`, method: "POST", body: { libraryKey: "lib-elsewhere" } },
    );
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Library not found on this server");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    expect(await getTestPrisma().syncJob.count()).toBe(0);
  });

  it("refuses a malformed body instead of syncing every library", async () => {
    // `{ "libraryKey": 123 }` was read as "no library" and queued a sync of
    // the whole server.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "lib-key", title: "Movies" });
    setMockSession({ userId: user.id, isLoggedIn: true });

    for (const body of [
      { libraryKey: 123 },
      { libraryKey: "" },
      { libraryKey: "x".repeat(201) },
      "lib-key",
      // A misspelt key is refused, not stripped into "no library".
      { librarykey: "lib-key" },
      { libraryKey: "lib-key", all: true },
    ]) {
      const response = await callRouteWithParams(POST, { id: server.id }, {
        url: `/api/servers/${server.id}/sync`,
        method: "POST",
        body,
      });
      const refused = await expectJson<{ error: string }>(response, 400);
      expect(refused.error).toBe("Validation failed");
    }
    const invalidJson = await POST(
      new NextRequest(`http://localhost:3000/api/servers/${server.id}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{libraryKey:",
      }),
      { params: Promise.resolve({ id: server.id }) },
    );
    expect(await expectJson<{ error: string }>(invalidJson, 400)).toEqual({ error: "Invalid JSON in request body" });
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    expect(await getTestPrisma().syncJob.count()).toBe(0);

    // An empty object, like no body at all, still syncs every enabled library.
    await expectJson(await callRouteWithParams(POST, { id: server.id }, { url: `/api/servers/${server.id}/sync`, method: "POST", body: {} }), 200);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      expect.objectContaining({ serverId: server.id, libraryKey: undefined }),
      expect.anything(),
    );
  });

  it("creates the PENDING row at request time and hands it to the job", async () => {
    // MAIN_QUEUE is serial, so the job can wait minutes behind other work.
    // Without a row until the worker reached it, the page had nothing to show
    // and the click looked ignored for as long as the queue was busy.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

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
    setMockSession({ userId: user.id, isLoggedIn: true });
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
    setMockSession({ userId: user.id, isLoggedIn: true });

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

  // Three requests at once rarely overlap closely enough to show the race, so
  // the test above passes without the lock too. Here another request holds the
  // per-server `sync-request:` lock and creates its row only after this one has
  // had time to run its check: serialized, it sees that row and answers 409.
  it("checks for a queued sync under the per-server lock", async () => {
    const testPrisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const otherRequest = testPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('sync-request:' || $1))`, server.id);
      locked();
      await committed;
      await tx.syncJob.create({ data: { mediaServerId: server.id, status: "PENDING", startedAt: new Date() } });
    }, { timeout: 10_000 });
    await lockHeld;

    const request = callRouteWithParams(POST, { id: server.id }, { url: `/api/servers/${server.id}/sync`, method: "POST" });
    // Long enough for an unserialized request to run its check and insert.
    await new Promise((resolve) => setTimeout(resolve, 300));
    commit();
    await otherRequest;

    expect((await request).status).toBe(409);
    expect(await testPrisma.syncJob.count({ where: { mediaServerId: server.id } })).toBe(1);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });
});
