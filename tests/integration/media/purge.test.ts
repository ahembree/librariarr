import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { DELETE } from "@/app/api/media/purge/route";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";

describe("DELETE /api/media/purge", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 with missing type parameter", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type. Must be MOVIE, SERIES, or MUSIC");
  });

  it("returns 400 with invalid type parameter", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "INVALID" },
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid type. Must be MOVIE, SERIES, or MUSIC");
  });

  it("deletes items of specified type and returns count", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

    // Create 3 movies and 2 episodes
    await createTestMediaItem(movieLib.id, { title: "Movie 1", type: "MOVIE" });
    await createTestMediaItem(movieLib.id, { title: "Movie 2", type: "MOVIE" });
    await createTestMediaItem(movieLib.id, { title: "Movie 3", type: "MOVIE" });
    await createTestMediaItem(seriesLib.id, { title: "Pilot", type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 });
    await createTestMediaItem(seriesLib.id, { title: "Second", type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2 });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const events: AppEvent[] = [];
    const unsubscribe = eventBus.subscribe((e) => events.push(e));
    let body: { deleted: number };
    try {
      const response = await callRoute(DELETE, {
        url: "/api/media/purge",
        method: "DELETE",
        searchParams: { type: "MOVIE" },
      });
      body = await expectJson<{ deleted: number }>(response, 200);
    } finally {
      unsubscribe();
    }
    expect(body.deleted).toBe(3);
    // Open listings are told to refetch.
    expect(events).toEqual([
      expect.objectContaining({ type: "sync:completed", userId: user.id, meta: { purged: 3 } }),
    ]);
    // The plays went with the items, so the server's history is no longer established.
    const serverAfter = await prisma.mediaServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(serverAfter.watchHistorySyncedAt).toBeNull();

    // Verify movies are deleted but series items remain
    const remainingMovies = await prisma.mediaItem.count({
      where: { library: { type: "MOVIE" } },
    });
    expect(remainingMovies).toBe(0);

    const remainingSeries = await prisma.mediaItem.count({
      where: { library: { type: "SERIES" } },
    });
    expect(remainingSeries).toBe(2);
  });

  it("recomputes canonical so the surviving duplicate stays visible after a per-library purge", async () => {
    const prisma = getTestPrisma();
    const { recomputeCanonical } = await import("@/lib/dedup/recompute-canonical");
    const user = await createTestUser();

    // Two servers with the SAME movie, sharing the dedupKey the sync would give it.
    const serverA = await createTestServer(user.id, { name: "Server A" });
    const serverB = await createTestServer(user.id, { name: "Server B" });
    const libA = await createTestLibrary(serverA.id, { type: "MOVIE" });
    const libB = await createTestLibrary(serverB.id, { type: "MOVIE" });
    const a = await createTestMediaItem(libA.id, { title: "Dup Movie", year: 2020, type: "MOVIE" });
    const b = await createTestMediaItem(libB.id, { title: "Dup Movie", year: 2020, type: "MOVIE" });
    await prisma.mediaItem.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { dedupKey: "movie:title:dup movie:2020" } });

    // Establish canonical selection, then purge whichever library holds it.
    await recomputeCanonical(user.id);
    const flags = await prisma.mediaItem.findMany({ select: { libraryId: true, dedupCanonical: true } });
    // Exactly one copy is canonical, so the survivor starts out NOT canonical.
    expect(flags.filter((f) => f.dedupCanonical)).toHaveLength(1);
    const canonical = flags.find((f) => f.dedupCanonical)!;

    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { libraryId: canonical.libraryId },
    });
    expect(await expectJson<{ deleted: number }>(response, 200)).toEqual({ deleted: 1 });

    // The surviving copy must now be canonical (otherwise it vanishes from
    // multi-server listings, which filter dedupCanonical = true).
    const survivors = await prisma.mediaItem.findMany();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].libraryId).not.toBe(canonical.libraryId);
    expect(survivors[0].dedupCanonical).toBe(true);
  });

  it("returns 404 for a library that does not exist and deletes nothing", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Keep", type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { libraryId: "no-such-library" },
    });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Library not found");
    expect(await prisma.mediaItem.count()).toBe(1);
  });

  it("restarts the Tracearr archive walk for a mapped server, leaving others alone", async () => {
    // The purge cascades the items' plays away, and a "complete" backfill only
    // ever runs the one-hour forward pass — so those plays, which Tracearr
    // still holds, were never imported again.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const mapped = await createTestServer(user.id, {
      name: "Mapped",
      tracearrServerId: "11111111-2222-3333-4444-555555555555",
      tracearrBackfillComplete: true,
    });
    const native = await createTestServer(user.id, { name: "Native" });
    const mappedLib = await createTestLibrary(mapped.id, { type: "MOVIE" });
    const nativeLib = await createTestLibrary(native.id, { type: "MOVIE" });
    await createTestMediaItem(mappedLib.id, { title: "A", type: "MOVIE" });
    await createTestMediaItem(nativeLib.id, { title: "B", type: "MOVIE" });

    setMockSession({ isLoggedIn: true, userId: user.id });
    const before = Date.now();
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { type: "MOVIE" },
    });
    await expectJson<{ deleted: number }>(response, 200);

    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: mapped.id } });
    expect(after.tracearrBackfillComplete).toBe(false);
    // Moved to now so the walk starts from the newest play again.
    expect(after.tracearrBackfillCursorAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const untouched = await prisma.mediaServer.findUniqueOrThrow({ where: { id: native.id } });
    expect(untouched.tracearrBackfillCursorAt).toBeNull();
  });

  it("restarts the Tracearr archive walk on a per-library purge", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const mapped = await createTestServer(user.id, {
      tracearrServerId: "11111111-2222-3333-4444-555555555555",
      tracearrBackfillComplete: true,
    });
    const lib = await createTestLibrary(mapped.id, { type: "SERIES" });
    await createTestMediaItem(lib.id, { title: "Pilot", type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 });

    setMockSession({ isLoggedIn: true, userId: user.id });
    const before = Date.now();
    const response = await callRoute(DELETE, {
      url: "/api/media/purge",
      method: "DELETE",
      searchParams: { libraryId: lib.id },
    });
    expect(await expectJson<{ deleted: number }>(response, 200)).toEqual({ deleted: 1 });

    const after = await prisma.mediaServer.findUniqueOrThrow({ where: { id: mapped.id } });
    expect(after.tracearrBackfillComplete).toBe(false);
    expect(after.tracearrBackfillCursorAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The cascade took this server's plays: history is un-established until a sync.
    expect(after.watchHistorySyncedAt).toBeNull();
  });
});
