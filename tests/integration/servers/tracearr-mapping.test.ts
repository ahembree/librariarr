import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

const { mockInvalidateMediaCaches } = vi.hoisted(() => ({
  mockInvalidateMediaCaches: vi.fn(),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateMediaCaches: mockInvalidateMediaCaches,
}));

const { mockTestConnection } = vi.hoisted(() => ({
  mockTestConnection: vi.fn(),
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({ testConnection: mockTestConnection })),
}));

// Import route handlers AFTER mocks
import { PUT } from "@/app/api/servers/[id]/route";

const TRACEARR_SERVER_A = "3f6f0d1e-0000-4000-8000-00000000000a";
const TRACEARR_SERVER_B = "3f6f0d1e-0000-4000-8000-00000000000b";

describe("PUT /api/servers/[id] — Tracearr mapping", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, name: "Test Server" });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** Give a server one library, one item and `count` stored watch-history rows. */
  async function seedWatchHistory(mediaServerId: string, count = 2) {
    const library = await createTestLibrary(mediaServerId);
    const item = await createTestMediaItem(library.id);
    await prisma.watchHistory.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        mediaItemId: item.id,
        mediaServerId,
        serverUsername: `viewer-${i}`,
        watchedAt: new Date("2026-01-01T00:00:00Z"),
      })),
    });
    return item;
  }

  const countHistory = (mediaServerId: string) =>
    prisma.watchHistory.count({ where: { mediaServerId } });

  const putMapping = (serverId: string, body: Record<string, unknown>) =>
    callRouteWithParams(
      PUT,
      { id: serverId },
      { url: `/api/servers/${serverId}`, method: "PUT", body }
    );

  it("links a previously-native server and wipes its stored watch history", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await seedWatchHistory(server.id, 3);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBe(TRACEARR_SERVER_A);

    const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(updated!.tracearrServerId).toBe(TRACEARR_SERVER_A);
    expect(await countHistory(server.id)).toBe(0);
    expect(mockInvalidateMediaCaches).toHaveBeenCalled();
  });

  it("unlinking with null reverts to native history and wipes the Tracearr rows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: null });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBeNull();

    expect(await countHistory(server.id)).toBe(0);
    expect(mockInvalidateMediaCaches).toHaveBeenCalled();
  });

  it("re-pointing to a different Tracearr server wipes the previous server's rows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_B });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBe(TRACEARR_SERVER_B);
    expect(await countHistory(server.id)).toBe(0);
  });

  it("sending the same mapping again is a no-op that does not wipe history", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    await expectJson(response, 200);

    expect(await countHistory(server.id)).toBe(2);
    expect(mockInvalidateMediaCaches).not.toHaveBeenCalled();
  });

  it("sending an empty string normalises to null and unlinks", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: "" });
    const body = await expectJson<{ server: { tracearrServerId: string | null } }>(response, 200);
    expect(body.server.tracearrServerId).toBeNull();
    expect(await countHistory(server.id)).toBe(0);
  });

  it("sending an empty string on an already-native server is a no-op", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: "" });
    await expectJson(response, 200);

    expect(await countHistory(server.id)).toBe(2);
    expect(mockInvalidateMediaCaches).not.toHaveBeenCalled();
  });

  it("omitting the field leaves both the mapping and the history untouched", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { externalUrl: "https://plex.example.com" });
    await expectJson(response, 200);

    const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(updated!.tracearrServerId).toBe(TRACEARR_SERVER_A);
    expect(await countHistory(server.id)).toBe(2);
    expect(mockInvalidateMediaCaches).not.toHaveBeenCalled();
  });

  it("a url-only edit leaves the mapping and the history alone", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: TRACEARR_SERVER_A },
    });
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { url: "http://plex.test:32401" });
    await expectJson(response, 200);

    const updated = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(updated!.url).toBe("http://plex.test:32401");
    expect(updated!.tracearrServerId).toBe(TRACEARR_SERVER_A);
    expect(await countHistory(server.id)).toBe(2);
    expect(mockTestConnection).toHaveBeenCalled();
  });

  it("does not touch another server's watch history on a mapping change", async () => {
    const user = await createTestUser();
    const switched = await createTestServer(user.id, { name: "Switched" });
    const untouched = await createTestServer(user.id, { name: "Untouched" });
    await seedWatchHistory(switched.id, 2);
    await seedWatchHistory(untouched.id, 3);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(switched.id, { tracearrServerId: TRACEARR_SERVER_A });
    await expectJson(response, 200);

    expect(await countHistory(switched.id)).toBe(0);
    expect(await countHistory(untouched.id)).toBe(3);
  });

  it("returns 401 without auth", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await seedWatchHistory(server.id, 2);

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");

    // The wipe sits behind the ownership check, so nothing was deleted.
    expect(await countHistory(server.id)).toBe(2);
  });

  it("returns 404 for a server owned by another user and wipes nothing", async () => {
    const owner = await createTestUser({ plexId: "owner" });
    const other = await createTestUser({ plexId: "other" });
    const server = await createTestServer(owner.id);
    await seedWatchHistory(server.id, 2);
    setMockSession({ userId: other.id, plexToken: "tok", isLoggedIn: true });

    const response = await putMapping(server.id, { tracearrServerId: TRACEARR_SERVER_A });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");

    const untouched = await prisma.mediaServer.findUnique({ where: { id: server.id } });
    expect(untouched!.tracearrServerId).toBeNull();
    expect(await countHistory(server.id)).toBe(2);
  });
});
