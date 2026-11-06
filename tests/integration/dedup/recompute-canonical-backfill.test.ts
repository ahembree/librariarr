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
// The real retry, observed: the legacy re-key must retry a deadlocked batch.
vi.mock("@/lib/db-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-retry")>();
  return { withDeadlockRetry: vi.fn(actual.withDeadlockRetry) };
});
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

import {
  runBackfillIfNeeded,
  backfillSeriesKeys,
  backfillDedupKeys,
} from "@/lib/dedup/recompute-canonical";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";

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

  it("re-keys tracks whose dedupKey predates the album, then recomputes their canonical copies", async () => {
    const user = await createTestUser();
    const s1 = await createTestServer(user.id, { name: "One" });
    const s2 = await createTestServer(user.id, { name: "Two" });
    const lib1 = await createTestLibrary(s1.id, { type: "MUSIC" });
    const lib2 = await createTestLibrary(s2.id, { type: "MUSIC" });
    const movieLib = await createTestLibrary(s1.id, { type: "MOVIE" });
    const legacy = "music:queen:bohemian rhapsody";
    const track = async (libraryId: string, ratingKey: string, albumTitle: string, canonical: boolean, offsetMs: number) => {
      const row = await createTestMediaItem(libraryId, {
        ratingKey, type: "MUSIC", title: "Bohemian Rhapsody", parentTitle: "Queen", albumTitle,
      });
      return prisma.mediaItem.update({
        where: { id: row.id },
        data: { dedupKey: legacy, dedupCanonical: canonical, createdAt: new Date(Date.now() + offsetMs) },
      });
    };
    // One group under the old key: only the studio version on server One was
    // canonical, so the compilation was hidden even on its own server.
    const studio = await track(lib1.id, "a1", "A Night at the Opera", true, 0);
    const compilation = await track(lib1.id, "a2", "Greatest Hits", false, 1_000);
    const compilationCopy = await track(lib2.id, "b1", "Greatest Hits", false, 2_000);
    const movie = await createTestMediaItem(movieLib.id, { title: "Heat" });
    await prisma.mediaItem.update({ where: { id: movie.id }, data: { dedupKey: "movie:tmdb:949", dedupCanonical: false } });

    await runBackfillIfNeeded();

    const read = (id: string) => prisma.mediaItem.findUniqueOrThrow({ where: { id }, select: { dedupKey: true, dedupCanonical: true } });
    expect(await read(studio.id)).toEqual({ dedupKey: "track:queen:a night at the opera:bohemian rhapsody", dedupCanonical: true });
    // The compilation is its own track now, and its copy on server Two folds into it.
    expect(await read(compilation.id)).toEqual({ dedupKey: "track:queen:greatest hits:bohemian rhapsody", dedupCanonical: true });
    expect(await read(compilationCopy.id)).toEqual({ dedupKey: "track:queen:greatest hits:bohemian rhapsody", dedupCanonical: false });
    // Other keys are left as they were.
    expect((await read(movie.id)).dedupKey).toBe("movie:tmdb:949");
    expect(mockLogger.info).toHaveBeenCalledWith("Sync", "Re-keyed 3 track(s) whose dedupKey predates the album");
    expect(invalidateMediaCaches).toHaveBeenCalled();

    // Nothing is left in the old shape, so the next boot re-keys nothing.
    vi.clearAllMocks();
    await runBackfillIfNeeded();
    expect(mockLogger.info).not.toHaveBeenCalledWith("Sync", expect.stringContaining("Re-keyed"));
    expect(invalidateMediaCaches).not.toHaveBeenCalled();
  });

  describe("a re-key that fails part-way", () => {
    // More legacy groups than one batch takes (500), each a track with a copy
    // on two servers. Both copies start hidden (`dedupCanonical` false), so a
    // group whose flags were recomputed shows exactly one copy.
    const GROUPS = 600;

    async function seedLegacyGroups() {
      const user = await createTestUser();
      const libs = await Promise.all(
        ["One", "Two"].map(async (name) =>
          createTestLibrary((await createTestServer(user.id, { name })).id, { type: "MUSIC" }),
        ),
      );
      for (const [n, lib] of libs.entries()) {
        await prisma.mediaItem.createMany({
          data: Array.from({ length: GROUPS }, (_, i) => ({
            libraryId: lib.id,
            ratingKey: `rk-${i}`,
            title: `Song ${i}`,
            type: "MUSIC" as const,
            parentTitle: "Artist",
            albumTitle: "Album",
            dedupKey: `music:artist:song ${i}`,
            dedupCanonical: false,
            createdAt: new Date(Date.now() + n * 60_000),
          })),
        });
      }
    }

    /** Every legacy group's state: its keys and how many of its copies are shown. */
    async function groups() {
      const rows = await prisma.mediaItem.findMany({ select: { title: true, dedupKey: true, dedupCanonical: true } });
      const byTitle = new Map<string, { keys: Set<string | null>; shown: number }>();
      for (const row of rows) {
        const group = byTitle.get(row.title) ?? { keys: new Set(), shown: 0 };
        group.keys.add(row.dedupKey);
        if (row.dedupCanonical) group.shown++;
        byTitle.set(row.title, group);
      }
      return [...byTitle.values()];
    }

    /** `prisma.$transaction`, failing its `n`th call with `error`. */
    function failTransaction(n: number, error: unknown) {
      const real = prisma.$transaction.bind(prisma);
      let calls = 0;
      return vi.spyOn(prisma, "$transaction").mockImplementation(((...args: Parameters<typeof real>) => {
        calls++;
        return calls === n ? Promise.reject(error) : real(...args);
      }) as typeof prisma.$transaction);
    }

    it("leaves no track without a key, settles what it did, and the next run finishes the rest", async () => {
      await seedLegacyGroups();
      const spy = failTransaction(2, new Error("connection lost"));
      try {
        await runBackfillIfNeeded();
      } finally {
        spy.mockRestore();
      }

      // Never cleared first: every row still has a key, old or new.
      expect(await prisma.mediaItem.count({ where: { dedupKey: null } })).toBe(0);
      const partial = await groups();
      const rekeyed = partial.filter((g) => [...g.keys].every((k) => k?.startsWith("track:")));
      const legacy = partial.filter((g) => [...g.keys].every((k) => k?.startsWith("music:")));
      // Whole groups only: no track has one copy in each shape.
      expect(rekeyed).toHaveLength(500);
      expect(legacy).toHaveLength(GROUPS - 500);
      expect(rekeyed.every((g) => g.keys.size === 1)).toBe(true);
      // The batch that committed brought its canonical flags with it.
      expect(rekeyed.every((g) => g.shown === 1)).toBe(true);
      expect(legacy.every((g) => g.shown === 0)).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Sync",
        "Re-keying tracks whose dedupKey predates the album stopped after 1000 track(s) — " +
          "the rest keep their old key until the next start or restore re-keys them",
        { error: "Error: connection lost" },
      );
      // The listings built on the old keys are dropped for what was done.
      expect(invalidateMediaCaches).toHaveBeenCalled();

      vi.clearAllMocks();
      await runBackfillIfNeeded();

      const finished = await groups();
      expect(finished).toHaveLength(GROUPS);
      expect(finished.every((g) => g.keys.size === 1 && [...g.keys][0]!.startsWith("track:artist:album:song "))).toBe(true);
      expect(finished.every((g) => g.shown === 1)).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith("Sync", "Re-keyed 200 track(s) whose dedupKey predates the album");
      expect(invalidateMediaCaches).toHaveBeenCalled();
    });

    it("retries a deadlocked batch", async () => {
      await seedLegacyGroups();
      const spy = failTransaction(1, Object.assign(new Error("deadlock detected"), { code: "P2034" }));
      try {
        await runBackfillIfNeeded();
      } finally {
        spy.mockRestore();
      }

      const all = await groups();
      expect(all.every((g) => g.keys.size === 1 && [...g.keys][0]!.startsWith("track:"))).toBe(true);
      expect(all.every((g) => g.shown === 1)).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "DB",
        expect.stringContaining("Deadlock detected in rekeyLegacyTrackKeys, retrying"),
      );
      expect(mockLogger.info).toHaveBeenCalledWith("Sync", `Re-keyed ${2 * GROUPS} track(s) whose dedupKey predates the album`);
    });

    it("leaves a row a sync re-keyed in between to the sync", async () => {
      const user = await createTestUser();
      const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "MUSIC" });
      const row = await createTestMediaItem(lib.id, {
        type: "MUSIC", title: "Intro", parentTitle: "Artist", albumTitle: "Live",
      });
      await prisma.mediaItem.update({ where: { id: row.id }, data: { dedupKey: "music:artist:intro" } });
      // A sync writes the row — its album renamed meanwhile — between the
      // batch's read and its write.
      const synced = { albumTitle: "Live at Wembley", dedupKey: "track:artist:live at wembley:intro" };
      const realTransaction = prisma.$transaction.bind(prisma);
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
        realTransaction(async (tx) => {
          const proxy = new Proxy(tx, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (prop !== "$queryRaw") return value;
              return async (...args: unknown[]) => {
                const rows = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
                await prisma.mediaItem.update({ where: { id: row.id }, data: synced });
                return rows;
              };
            },
          });
          return fn(proxy);
        }, opts as never)) as unknown as typeof prisma.$transaction);
      try {
        await runBackfillIfNeeded();
      } finally {
        spy.mockRestore();
      }

      // Not the key computed from the album it read before the sync wrote.
      expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: row.id } })).dedupKey).toBe(synced.dedupKey);
    });
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
