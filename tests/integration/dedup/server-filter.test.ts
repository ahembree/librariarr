import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  appCache: {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidatePrefix: vi.fn(),
    clear: vi.fn(),
  },
}));

// Import AFTER mocks
import { resolveServerFilter } from "@/lib/dedup/server-filter";

describe("resolveServerFilter", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("returns null when user has no enabled servers", async () => {
    const user = await createTestUser();
    const result = await resolveServerFilter(user.id, null);
    expect(result).toBeNull();
  });

  it("returns null when user has only disabled servers", async () => {
    const user = await createTestUser();
    await createTestServer(user.id, { name: "Disabled Server", enabled: false });
    const result = await resolveServerFilter(user.id, null);
    expect(result).toBeNull();
  });

  it("returns single-server result when only one server exists", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "My Plex" });
    await createTestLibrary(server.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.serverIds).toEqual([server.id]);
  });

  it("isSingleServer is true when only one server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "My Plex" });
    await createTestLibrary(server.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.isSingleServer).toBe(true);
  });

  it("returns all server IDs when multiple servers and no filter", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Plex 1" });
    const server2 = await createTestServer(user.id, { name: "Plex 2" });
    await createTestLibrary(server1.id, { type: "MOVIE" });
    await createTestLibrary(server2.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.serverIds).toHaveLength(2);
    expect(result!.serverIds).toContain(server1.id);
    expect(result!.serverIds).toContain(server2.id);
  });

  it("isSingleServer is false when multiple servers have libraries of the requested type", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Plex 1" });
    const server2 = await createTestServer(user.id, { name: "Plex 2" });
    await createTestLibrary(server1.id, { type: "MOVIE" });
    await createTestLibrary(server2.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.isSingleServer).toBe(false);
  });

  it("returns single server when serverId filter matches", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Plex 1" });
    const server2 = await createTestServer(user.id, { name: "Plex 2" });
    await createTestLibrary(server1.id, { type: "MOVIE" });
    await createTestLibrary(server2.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, server2.id, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.serverIds).toEqual([server2.id]);
    expect(result!.isSingleServer).toBe(true);
  });

  it("returns null when serverId does not match any enabled server", async () => {
    const user = await createTestUser();
    await createTestServer(user.id, { name: "Plex 1" });

    const result = await resolveServerFilter(user.id, "nonexistent-id", "MOVIE");
    expect(result).toBeNull();
  });

  it('serverId "all" returns all servers', async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Plex 1" });
    const server2 = await createTestServer(user.id, { name: "Plex 2" });
    await createTestLibrary(server1.id, { type: "MOVIE" });
    await createTestLibrary(server2.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, "all", "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.serverIds).toHaveLength(2);
    expect(result!.serverIds).toContain(server1.id);
    expect(result!.serverIds).toContain(server2.id);
  });

  it("isSingleServer true when multiple servers but only one has libraries of given type", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Plex 1" });
    const server2 = await createTestServer(user.id, { name: "Plex 2" });
    await createTestLibrary(server1.id, { type: "MOVIE" });
    await createTestLibrary(server2.id, { type: "SERIES" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.isSingleServer).toBe(true);
    expect(result!.serverIds).toEqual([server1.id]);
  });

  it("preferredTitleServerId from AppSettings", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Plex 1" });
    const server2 = await createTestServer(user.id, { name: "Plex 2" });
    await createTestLibrary(server1.id, { type: "MOVIE" });
    await createTestLibrary(server2.id, { type: "MOVIE" });

    const testPrisma = getTestPrisma();
    await testPrisma.appSettings.create({
      data: { userId: user.id, preferredTitleServerId: server2.id },
    });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.preferredTitleServerId).toBe(server2.id);
  });

  it("serverMap contains correct name and type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "My Plex Server" });
    await createTestLibrary(server.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    const entry = result!.serverMap.get(server.id);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("My Plex Server");
    expect(entry!.type).toBe("PLEX");
  });

  it("disabled servers are excluded", async () => {
    const user = await createTestUser();
    const enabledServer = await createTestServer(user.id, { name: "Enabled", enabled: true });
    await createTestServer(user.id, { name: "Disabled", enabled: false });
    await createTestLibrary(enabledServer.id, { type: "MOVIE" });

    const result = await resolveServerFilter(user.id, null, "MOVIE");
    expect(result).not.toBeNull();
    expect(result!.serverIds).toEqual([enabledServer.id]);
    expect(result!.serverMap.size).toBe(1);
  });
});
