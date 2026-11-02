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

// The live connection states the route reads — the manager itself is
// unit-tested; here only what the route does with its answer matters.
const { getStatuses } = vi.hoisted(() => ({ getStatuses: vi.fn() }));
vi.mock("@/lib/media-server/realtime", () => ({
  getRealtimeManager: () => ({ getStatuses }),
}));

import { GET } from "@/app/api/tools/realtime/status/route";

interface StatusResponse {
  enabled: boolean;
  servers: Array<{ serverId: string; name: string; type: string; status: string }>;
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  getStatuses.mockReset();
  getStatuses.mockReturnValue([]);
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("GET /api/tools/realtime/status", () => {
  it("returns 401 when not authenticated", async () => {
    expect(await expectJson(await callRoute(GET), 401)).toEqual({ error: "Unauthorized" });
    expect(getStatuses).not.toHaveBeenCalled();
  });

  it("lists every enabled server with its live connection state", async () => {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { name: "Plex Home", type: "PLEX" });
    const jelly = await createTestServer(user.id, { name: "Jellyfin", type: "JELLYFIN" });
    getStatuses.mockReturnValue([
      { serverId: plex.id, name: "stale name", type: "PLEX", status: "connected" },
      { serverId: jelly.id, name: "Jellyfin", type: "JELLYFIN", status: "disconnected" },
    ]);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<StatusResponse>(await callRoute(GET), 200);
    expect(body.enabled).toBe(true);
    expect(body.servers).toHaveLength(2);
    expect(body.servers).toEqual(expect.arrayContaining([
      // The name comes from the server row, so a rename shows at once.
      { serverId: plex.id, name: "Plex Home", type: "PLEX", status: "connected" },
      { serverId: jelly.id, name: "Jellyfin", type: "JELLYFIN", status: "disconnected" },
    ]));
  });

  it("reports a server the manager has not opened yet as connecting, not missing", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Just Added" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<StatusResponse>(await callRoute(GET), 200);
    expect(body.servers).toEqual([
      { serverId: server.id, name: "Just Added", type: server.type, status: "connecting" },
    ]);
  });

  it("leaves out a disabled server, which never gets a connection", async () => {
    const user = await createTestUser();
    const kept = await createTestServer(user.id, { name: "On" });
    await createTestServer(user.id, { name: "Off", enabled: false });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<StatusResponse>(await callRoute(GET), 200);
    expect(body.servers.map((s) => s.serverId)).toEqual([kept.id]);
  });

  it("lists nothing while real-time sync is turned off", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await getTestPrisma().appSettings.create({ data: { userId: user.id, realtimeSync: false } });
    getStatuses.mockReturnValue([{ serverId: server.id, name: "x", type: "PLEX", status: "connected" }]);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<StatusResponse>(await callRoute(GET), 200);
    expect(body).toEqual({ enabled: false, servers: [] });
  });

  it("never returns the server's URL or token", async () => {
    const user = await createTestUser();
    await createTestServer(user.id, { url: "http://10.0.0.5:32400", accessToken: "secret-token" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const text = await (await callRoute(GET)).text();
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toContain("secret-token");
  });
});
