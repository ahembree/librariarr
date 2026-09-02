import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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

import { GET } from "@/app/api/v1/sync/status/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedUser() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope: "READ_ONLY" });
  return { user, raw };
}

function status(key: string) {
  return callV1(GET, { url: "/api/v1/sync/status", key });
}

describe("GET /api/v1/sync/status", () => {
  it("returns an empty list when no server is configured", async () => {
    const { raw } = await seedUser();
    const body = await expectJson<{ servers: any[] }>(await status(raw));
    expect(body.servers).toEqual([]);
  });

  it("reports IDLE with no history for a server that never synced", async () => {
    const { user, raw } = await seedUser();
    const server = await createTestServer(user.id, { name: "Plex" });

    const body = await expectJson<{ servers: any[] }>(await status(raw));
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({
      id: server.id,
      name: "Plex",
      type: "PLEX",
      enabled: true,
      status: "IDLE",
      current: null,
      lastSync: null,
    });
  });

  it("pivots the running job and the newest finished job onto the server", async () => {
    const { user, raw } = await seedUser();
    const prisma = getTestPrisma();
    const server = await createTestServer(user.id, { name: "Plex" });

    await prisma.syncJob.create({
      data: {
        mediaServerId: server.id,
        status: "COMPLETED",
        startedAt: new Date("2024-01-01T00:00:00Z"),
        completedAt: new Date("2024-01-01T01:00:00Z"),
        itemsProcessed: 10,
        totalItems: 10,
      },
    });
    const lastFailed = await prisma.syncJob.create({
      data: {
        mediaServerId: server.id,
        status: "FAILED",
        startedAt: new Date("2024-02-01T00:00:00Z"),
        completedAt: new Date("2024-02-01T00:05:00Z"),
        error: "connection refused",
        itemsProcessed: 3,
        totalItems: 40,
      },
    });
    const running = await prisma.syncJob.create({
      data: {
        mediaServerId: server.id,
        status: "RUNNING",
        startedAt: new Date("2024-03-01T00:00:00Z"),
        currentLibrary: "Movies",
        itemsProcessed: 7,
        totalItems: 100,
      },
    });

    const body = await expectJson<{ servers: any[] }>(await status(raw));
    const entry = body.servers[0];
    expect(entry.status).toBe("RUNNING");
    expect(entry.current).toMatchObject({
      id: running.id,
      status: "RUNNING",
      currentLibrary: "Movies",
      itemsProcessed: 7,
      totalItems: 100,
    });
    // The in-flight job is not history: lastSync is the newest *finished* run.
    expect(entry.lastSync).toMatchObject({
      id: lastFailed.id,
      status: "FAILED",
      error: "connection refused",
      itemsProcessed: 3,
      totalItems: 40,
    });
    expect(typeof entry.lastSync.completedAt).toBe("string");
  });

  it("treats a PENDING job as the current one", async () => {
    const { user, raw } = await seedUser();
    const server = await createTestServer(user.id);
    await getTestPrisma().syncJob.create({
      data: { mediaServerId: server.id, status: "PENDING" },
    });

    const body = await expectJson<{ servers: any[] }>(await status(raw));
    expect(body.servers[0].status).toBe("PENDING");
    expect(body.servers[0].current.status).toBe("PENDING");
  });

  it("never exposes the server's access token", async () => {
    const { user, raw } = await seedUser();
    await createTestServer(user.id, { accessToken: "super-secret-token" });

    const response = await status(raw);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("accessToken");
  });

  it("orders servers by name and never shows another user's", async () => {
    const { user, raw } = await seedUser();
    await createTestServer(user.id, { name: "Zulu" });
    await createTestServer(user.id, { name: "Alpha" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    await createTestServer(stranger.id, { name: "Theirs" });

    const body = await expectJson<{ servers: any[] }>(await status(raw));
    expect(body.servers.map((s) => s.name)).toEqual(["Alpha", "Zulu"]);
  });
});
