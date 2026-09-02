import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import {
  expectJson,
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

import { GET } from "@/app/api/v1/system/info/route";

interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  stats: { mediaItems: number; servers: number; enabledLibraries: number };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

function info(key: string) {
  return callV1(GET, { url: "/api/v1/system/info", key });
}

describe("GET /api/v1/system/info", () => {
  it("returns version, uptime and zeroed counts on an empty install", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<SystemInfo>(await info(raw));
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.stats).toEqual({ mediaItems: 0, servers: 0, enabledLibraries: 0 });
  });

  it("counts only enabled libraries", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    const enabled = await createTestLibrary(server.id, { key: "on" });
    await createTestLibrary(server.id, { key: "off", enabled: false });
    await createTestMediaItem(enabled.id);
    await createTestMediaItem(enabled.id);

    const body = await expectJson<SystemInfo>(await info(raw));
    expect(body.stats).toEqual({ mediaItems: 2, servers: 1, enabledLibraries: 1 });
  });

  it("counts only the key owner's data", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { key: "mine" });
    await createTestMediaItem(library.id);

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const strangerServer = await createTestServer(stranger.id, { name: "Theirs" });
    const strangerLib = await createTestLibrary(strangerServer.id, { key: "theirs" });
    await createTestMediaItem(strangerLib.id);
    await createTestMediaItem(strangerLib.id);

    const body = await expectJson<SystemInfo>(await info(raw));
    expect(body.stats).toEqual({ mediaItems: 1, servers: 1, enabledLibraries: 1 });
  });

  // The internal /api/system/info reports database size and the latest applied
  // migration; both are reconnaissance for a stolen key, so v1 must not carry them.
  it("omits the infrastructure fields the internal route exposes", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<Record<string, unknown>>(await info(raw));
    expect(body).not.toHaveProperty("databaseSize");
    expect(body).not.toHaveProperty("latestMigration");
    expect(Object.keys(body).sort()).toEqual(["stats", "uptimeSeconds", "version"]);
  });
});
