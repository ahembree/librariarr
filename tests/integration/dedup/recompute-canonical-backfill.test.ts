import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
} from "../../setup/test-helpers";

const mockLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({ logger: mockLogger, apiLogger: mockLogger, dbLogger: mockLogger }));
vi.mock("@/lib/db-retry", () => ({
  withDeadlockRetry: vi.fn().mockImplementation((_name: string, fn: () => Promise<void>) => fn()),
}));

import {
  runBackfillIfNeeded,
  backfillSeriesKeys,
  backfillDedupKeys,
} from "@/lib/dedup/recompute-canonical";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("backfillSeriesKeys(userId)", () => {
  it("fills only SERIES rows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    const episode = await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Mine", seriesKey: null, seasonNumber: 1, episodeNumber: 1 });
    // Movies never carry a series key.
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(movieLib.id, { title: "Heat", seriesKey: null });

    expect(await backfillSeriesKeys(user.id)).toBe(1);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: episode.id } })).seriesKey).toBe("title:mine");
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: movie.id } })).seriesKey).toBeNull();
  });
});

describe("backfillDedupKeys", () => {
  it("handles a batch with no movies (no external-id lookup) and pages past one batch", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "MUSIC" });
    await prisma.mediaItem.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        libraryId: lib.id, ratingKey: `rk-${i}`, title: `Track ${i}`, type: "MUSIC" as const,
        parentTitle: "Artist", albumTitle: "Album",
      })),
    });

    expect(await backfillDedupKeys(user.id)).toBe(1001);
    expect(await prisma.mediaItem.count({ where: { dedupKey: null } })).toBe(0);
  });
});

describe("runBackfillIfNeeded", () => {
  it("does nothing when every row already has its keys", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" });
    const m = await createTestMediaItem(lib.id, { title: "Heat" });
    await prisma.mediaItem.update({ where: { id: m.id }, data: { dedupKey: "k", dedupCanonical: false } });

    await runBackfillIfNeeded();

    // No recompute ran: the non-canonical flag stayed as set.
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: m.id } })).dedupCanonical).toBe(false);
    expect(mockLogger.info).not.toHaveBeenCalledWith("Sync", expect.stringContaining("Backfilling"));
  });

  it("backfills series keys and dedup keys, then recomputes canonical copies across servers", async () => {
    const user = await createTestUser();
    const s1 = await createTestServer(user.id, { name: "One" });
    const s2 = await createTestServer(user.id, { name: "Two" });
    const lib1 = await createTestLibrary(s1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(s2.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(s1.id, { type: "SERIES" });

    const older = await createTestMediaItem(lib1.id, { title: "Heat", year: 1995 });
    const newer = await createTestMediaItem(lib2.id, { title: "Heat", year: 1995 });
    await createTestExternalId(older.id, "TMDB", "949");
    await createTestExternalId(newer.id, "TMDB", "949");
    await prisma.mediaItem.update({ where: { id: newer.id }, data: { createdAt: new Date(Date.now() + 60_000) } });
    const ep = await createTestMediaItem(seriesLib.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Lost", seriesKey: null, seasonNumber: 1, episodeNumber: 1,
    });

    await runBackfillIfNeeded();

    const [o, n, e] = await Promise.all([older, newer, ep].map((r) => prisma.mediaItem.findUniqueOrThrow({ where: { id: r.id } })));
    expect(e.seriesKey).toBe("title:lost");
    expect(o.dedupKey).toBe("movie:tmdb:949");
    expect(n.dedupKey).toBe("movie:tmdb:949");
    expect(o.dedupCanonical).toBe(true);
    expect(n.dedupCanonical).toBe(false);
    expect(e.dedupKey).toBe("series:lost:s1e1");
    expect(e.dedupCanonical).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith("Sync", "Backfilled 1 seriesKey(s)");
    expect(mockLogger.info).toHaveBeenCalledWith("Sync", "Backfilled 3 dedupKey(s)");
  });

  it("logs and swallows a failure rather than crashing startup", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("db down"));
    try {
      await expect(runBackfillIfNeeded()).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith("Sync", "Dedup backfill failed", { error: "Error: db down" });
    } finally {
      spy.mockRestore();
    }
  });
});
