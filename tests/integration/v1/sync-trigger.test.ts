import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  expectJson,
  createTestUser,
  createTestApiKey,
  createTestServer,
} from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

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
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));

import { POST } from "@/app/api/v1/sync/route";
import { MAIN_QUEUE, TASK_SYNC_SERVER } from "@/lib/jobs/constants";

interface SyncResponse {
  enqueued: number;
  skipped: number;
  servers: { id: string; name: string; status: "enqueued" | "skipped" }[];
}

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
  mockEnqueueJob.mockResolvedValue(true);
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedUser(scope: "READ_ONLY" | "READ_WRITE" = "READ_WRITE") {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope });
  return { user, raw };
}

function trigger(key: string, body: unknown = {}) {
  return callV1(POST, { url: "/api/v1/sync", method: "POST", key, body });
}

describe("POST /api/v1/sync", () => {
  it("enqueues one durable job per enabled server, ordered by name", async () => {
    const { user, raw } = await seedUser();
    const beta = await createTestServer(user.id, { name: "Beta" });
    const alpha = await createTestServer(user.id, { name: "Alpha" });
    await createTestServer(user.id, { name: "Disabled", enabled: false });

    const body = await expectJson<SyncResponse>(await trigger(raw));
    expect(body.enqueued).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.servers).toEqual([
      { id: alpha.id, name: "Alpha", status: "enqueued" },
      { id: beta.id, name: "Beta", status: "enqueued" },
    ]);

    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: alpha.id },
      { jobKey: `sync:${alpha.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: beta.id },
      { jobKey: `sync:${beta.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
  });

  it("returns an empty result when no server is enabled", async () => {
    const { user, raw } = await seedUser();
    await createTestServer(user.id, { name: "Off", enabled: false });

    const body = await expectJson<SyncResponse>(await trigger(raw));
    expect(body).toEqual({ enqueued: 0, skipped: 0, servers: [] });
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("honours an explicit serverId even when that server is disabled", async () => {
    const { user, raw } = await seedUser();
    const off = await createTestServer(user.id, { name: "Off", enabled: false });
    await createTestServer(user.id, { name: "On" });

    const body = await expectJson<SyncResponse>(await trigger(raw, { serverId: off.id }));
    expect(body.servers).toEqual([{ id: off.id, name: "Off", status: "enqueued" }]);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(
      TASK_SYNC_SERVER,
      { serverId: off.id },
      { jobKey: `sync:${off.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
    );
  });

  it.each(["RUNNING", "PENDING"] as const)(
    "skips a server that already has a %s sync job",
    async (status) => {
      const { user, raw } = await seedUser();
      const server = await createTestServer(user.id, { name: "Busy" });
      await getTestPrisma().syncJob.create({
        data: { mediaServerId: server.id, status },
      });

      const body = await expectJson<SyncResponse>(await trigger(raw));
      expect(body).toEqual({
        enqueued: 0,
        skipped: 1,
        servers: [{ id: server.id, name: "Busy", status: "skipped" }],
      });
      expect(mockEnqueueJob).not.toHaveBeenCalled();
    },
  );

  it("does not treat a finished sync job as still running", async () => {
    const { user, raw } = await seedUser();
    const server = await createTestServer(user.id, { name: "Idle" });
    await getTestPrisma().syncJob.create({
      data: { mediaServerId: server.id, status: "COMPLETED", completedAt: new Date() },
    });

    const body = await expectJson<SyncResponse>(await trigger(raw));
    expect(body.enqueued).toBe(1);
    expect(body.skipped).toBe(0);
  });

  it("404s for an unknown serverId", async () => {
    const { user, raw } = await seedUser();
    await createTestServer(user.id);

    const body = await expectJson<{ error: string }>(
      await trigger(raw, { serverId: "does-not-exist" }),
      404,
    );
    expect(body.error).toBe("Server not found");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("404s for another user's serverId and enqueues nothing", async () => {
    const { raw } = await seedUser();
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const strangerServer = await createTestServer(stranger.id, { name: "Theirs" });

    await expectJson(await trigger(raw, { serverId: strangerServer.id }), 404);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("never sweeps another user's enabled servers", async () => {
    const { user, raw } = await seedUser();
    const mine = await createTestServer(user.id, { name: "Mine" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    await createTestServer(stranger.id, { name: "Theirs" });

    const body = await expectJson<SyncResponse>(await trigger(raw));
    expect(body.servers).toEqual([{ id: mine.id, name: "Mine", status: "enqueued" }]);
  });

  // A broken queue is a hard failure, not a "skipped" server — folding it into
  // `skipped` would read as "already running" to the caller.
  it("500s when the enqueue fails", async () => {
    const { user, raw } = await seedUser();
    await createTestServer(user.id);
    mockEnqueueJob.mockResolvedValue(false);

    const body = await expectJson<{ error: string }>(await trigger(raw), 500);
    expect(body.error).toBe("Failed to enqueue sync job");
  });

  it("400s on malformed JSON", async () => {
    const { raw } = await seedUser();
    const request = new NextRequest("http://localhost:3000/api/v1/sync", {
      method: "POST",
      headers: { "X-Api-Key": raw, "Content-Type": "application/json" },
      body: "{ not json",
    });
    const body = await expectJson<{ error: string }>(await POST(request), 400);
    expect(body.error).toBe("Invalid JSON in request body");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("400s on a serverId of the wrong shape", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<{ error: string; details: string[] }>(
      await trigger(raw, { serverId: "" }),
      400,
    );
    expect(body.error).toBe("Validation failed");
    expect(body.details.join(" ")).toContain("serverId");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("403s for a READ_ONLY key and enqueues nothing", async () => {
    const { user, raw } = await seedUser("READ_ONLY");
    await createTestServer(user.id);

    await expectJson(await trigger(raw), 403);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });
});
