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
  createTestMediaItem,
  createTestExternalId,
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

vi.mock("@/lib/db-retry", () => ({
  withDeadlockRetry: vi.fn().mockImplementation((_name: string, fn: () => Promise<void>) => fn()),
}));

// Import AFTER mocks
import {
  recomputeCanonical,
  backfillDedupKeys,
} from "@/lib/dedup/recompute-canonical";

const testPrisma = getTestPrisma();

// One teardown for the whole file: disconnecting at the end of the first
// describe would leave the second running on a closed client.
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("recomputeCanonical", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  it("marks exactly one item per dedupKey group as canonical", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server 1" });
    const server2 = await createTestServer(user.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    const item1 = await createTestMediaItem(lib1.id, {
      title: "The Matrix",
      type: "MOVIE",
    });
    const item2 = await createTestMediaItem(lib2.id, {
      title: "The Matrix",
      type: "MOVIE",
    });

    // Set same dedupKey on both items
    await testPrisma.mediaItem.update({
      where: { id: item1.id },
      data: { dedupKey: "movie:tmdb:603" },
    });
    await testPrisma.mediaItem.update({
      where: { id: item2.id },
      data: { dedupKey: "movie:tmdb:603" },
    });

    await recomputeCanonical(user.id);

    const updated1 = await testPrisma.mediaItem.findUnique({
      where: { id: item1.id },
      select: { dedupCanonical: true },
    });
    const updated2 = await testPrisma.mediaItem.findUnique({
      where: { id: item2.id },
      select: { dedupCanonical: true },
    });

    // Exactly one should be canonical
    const canonicalCount = [updated1!.dedupCanonical, updated2!.dedupCanonical].filter(Boolean).length;
    expect(canonicalCount).toBe(1);
  });

  it("preferred server item wins canonical status", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server 1" });
    const server2 = await createTestServer(user.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    // Create item on server1 first (oldest), then on server2
    const item1 = await createTestMediaItem(lib1.id, {
      title: "Inception",
      type: "MOVIE",
    });
    const item2 = await createTestMediaItem(lib2.id, {
      title: "Inception",
      type: "MOVIE",
    });

    await testPrisma.mediaItem.update({
      where: { id: item1.id },
      data: { dedupKey: "movie:tmdb:27205" },
    });
    await testPrisma.mediaItem.update({
      where: { id: item2.id },
      data: { dedupKey: "movie:tmdb:27205" },
    });

    // Set server2 as preferred — even though item1 is older, server2 should win
    await testPrisma.appSettings.create({
      data: { userId: user.id, preferredTitleServerId: server2.id },
    });

    await recomputeCanonical(user.id);

    const updated1 = await testPrisma.mediaItem.findUnique({
      where: { id: item1.id },
      select: { dedupCanonical: true },
    });
    const updated2 = await testPrisma.mediaItem.findUnique({
      where: { id: item2.id },
      select: { dedupCanonical: true },
    });

    expect(updated2!.dedupCanonical).toBe(true);
    expect(updated1!.dedupCanonical).toBe(false);
  });

  it("oldest item wins when no preference is set", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server 1" });
    const server2 = await createTestServer(user.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    // item1 created first — should be canonical
    const item1 = await createTestMediaItem(lib1.id, {
      title: "Old Movie",
      type: "MOVIE",
    });
    const item2 = await createTestMediaItem(lib2.id, {
      title: "Old Movie",
      type: "MOVIE",
    });
    // Ensure item2 has a later createdAt so item1 is canonical
    await testPrisma.mediaItem.update({
      where: { id: item2.id },
      data: { createdAt: new Date(Date.now() + 1000) },
    });

    await testPrisma.mediaItem.update({
      where: { id: item1.id },
      data: { dedupKey: "movie:tmdb:300" },
    });
    await testPrisma.mediaItem.update({
      where: { id: item2.id },
      data: { dedupKey: "movie:tmdb:300" },
    });

    // No AppSettings for preference
    await recomputeCanonical(user.id);

    const updated1 = await testPrisma.mediaItem.findUnique({
      where: { id: item1.id },
      select: { dedupCanonical: true },
    });
    const updated2 = await testPrisma.mediaItem.findUnique({
      where: { id: item2.id },
      select: { dedupCanonical: true },
    });

    expect(updated1!.dedupCanonical).toBe(true);
    expect(updated2!.dedupCanonical).toBe(false);
  });

  it("prefers a copy on an enabled server over an older or preferred copy on a disabled one", async () => {
    // A disabled server keeps its items; if one stayed canonical, every query
    // combining dedupCanonical with the enabled-server scope lost the title.
    const user = await createTestUser();
    const disabled = await createTestServer(user.id, { name: "Disabled" });
    const enabled = await createTestServer(user.id, { name: "Enabled" });
    const libOff = await createTestLibrary(disabled.id, { type: "MOVIE" });
    const libOn = await createTestLibrary(enabled.id, { type: "MOVIE" });
    const onDisabled = await createTestMediaItem(libOff.id, { title: "Dune", type: "MOVIE" });
    const onEnabled = await createTestMediaItem(libOn.id, { title: "Dune", type: "MOVIE" });
    await testPrisma.mediaItem.update({
      where: { id: onEnabled.id },
      data: { createdAt: new Date(Date.now() + 1000) },
    });
    for (const id of [onDisabled.id, onEnabled.id]) {
      await testPrisma.mediaItem.update({ where: { id }, data: { dedupKey: "movie:tmdb:438631" } });
    }
    await testPrisma.mediaServer.update({ where: { id: disabled.id }, data: { enabled: false } });

    for (const preferred of [null, disabled.id]) {
      await testPrisma.appSettings.deleteMany({ where: { userId: user.id } });
      if (preferred) {
        await testPrisma.appSettings.create({ data: { userId: user.id, preferredTitleServerId: preferred } });
      }
      await recomputeCanonical(user.id);

      const [a, b] = await Promise.all(
        [onDisabled.id, onEnabled.id].map((id) =>
          testPrisma.mediaItem.findUnique({ where: { id }, select: { dedupCanonical: true } })
        )
      );
      expect(b!.dedupCanonical).toBe(true);
      expect(a!.dedupCanonical).toBe(false);
    }
  });

  it("items without dedupKey remain canonical", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    const item = await createTestMediaItem(lib.id, {
      title: "No Key Movie",
      type: "MOVIE",
    });

    // Item has no dedupKey (null by default), dedupCanonical defaults to true
    await recomputeCanonical(user.id);

    const updated = await testPrisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { dedupCanonical: true },
    });
    expect(updated!.dedupCanonical).toBe(true);
  });

  it("non-canonical items with null dedupKey get set to true", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    const item = await createTestMediaItem(lib.id, {
      title: "Reset Movie",
      type: "MOVIE",
    });

    // Manually set dedupCanonical to false with null dedupKey
    await testPrisma.mediaItem.update({
      where: { id: item.id },
      data: { dedupCanonical: false, dedupKey: null },
    });

    await recomputeCanonical(user.id);

    const updated = await testPrisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { dedupCanonical: true },
    });
    expect(updated!.dedupCanonical).toBe(true);
  });

  it("handles multiple dedupKey groups independently", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server 1" });
    const server2 = await createTestServer(user.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    const movieA1 = await createTestMediaItem(lib1.id, {
      title: "Movie A",
      type: "MOVIE",
    });
    const movieA2 = await createTestMediaItem(lib2.id, {
      title: "Movie A",
      type: "MOVIE",
    });
    const movieB1 = await createTestMediaItem(lib1.id, {
      title: "Movie B",
      type: "MOVIE",
    });
    const movieB2 = await createTestMediaItem(lib2.id, {
      title: "Movie B",
      type: "MOVIE",
    });

    await testPrisma.mediaItem.update({
      where: { id: movieA1.id },
      data: { dedupKey: "movie:tmdb:1001" },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieA2.id },
      data: { dedupKey: "movie:tmdb:1001" },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieB1.id },
      data: { dedupKey: "movie:tmdb:1002" },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieB2.id },
      data: { dedupKey: "movie:tmdb:1002" },
    });

    // Group B's copy on server 2 is the older one, so each group picks a
    // different server — a pick made across groups could not satisfy both.
    await testPrisma.mediaItem.update({
      where: { id: movieA2.id },
      data: { createdAt: new Date(Date.now() + 1000) },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieB1.id },
      data: { createdAt: new Date(Date.now() + 1000) },
    });

    await recomputeCanonical(user.id);

    // Each group should have exactly one canonical
    const [a1, a2, b1, b2] = await Promise.all([
      testPrisma.mediaItem.findUnique({ where: { id: movieA1.id }, select: { dedupCanonical: true } }),
      testPrisma.mediaItem.findUnique({ where: { id: movieA2.id }, select: { dedupCanonical: true } }),
      testPrisma.mediaItem.findUnique({ where: { id: movieB1.id }, select: { dedupCanonical: true } }),
      testPrisma.mediaItem.findUnique({ where: { id: movieB2.id }, select: { dedupCanonical: true } }),
    ]);

    const groupACanonical = [a1!.dedupCanonical, a2!.dedupCanonical].filter(Boolean).length;
    const groupBCanonical = [b1!.dedupCanonical, b2!.dedupCanonical].filter(Boolean).length;
    expect(groupACanonical).toBe(1);
    expect(groupBCanonical).toBe(1);
    expect(a1!.dedupCanonical).toBe(true);
    expect(b2!.dedupCanonical).toBe(true);
  });
});

describe("backfillDedupKeys", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  it("returns 0 when no items are missing dedupKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    const item = await createTestMediaItem(lib.id, {
      title: "Already Keyed",
      type: "MOVIE",
      year: 2024,
    });
    await testPrisma.mediaItem.update({
      where: { id: item.id },
      data: { dedupKey: "movie:title:already keyed:2024" },
    });

    const updated = await backfillDedupKeys(user.id);
    expect(updated).toBe(0);
  });

  it("computes and updates dedupKeys for items with dedupKey=null", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    const item = await createTestMediaItem(lib.id, {
      title: "Missing Key",
      type: "MOVIE",
      year: 2023,
    });
    // dedupKey is null by default, no need to update

    const updated = await backfillDedupKeys(user.id);
    expect(updated).toBe(1);

    const refreshed = await testPrisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { dedupKey: true },
    });
    // Title-based key for movies without external IDs
    expect(refreshed!.dedupKey).toBe("movie:title:missing key:2023");
  });

  it("uses external IDs for movies when available", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    const item = await createTestMediaItem(lib.id, {
      title: "Movie With TMDB",
      type: "MOVIE",
      year: 2024,
    });
    await createTestExternalId(item.id, "TMDB", "12345");

    const updated = await backfillDedupKeys(user.id);
    expect(updated).toBe(1);

    const refreshed = await testPrisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { dedupKey: true },
    });
    expect(refreshed!.dedupKey).toBe("movie:tmdb:12345");
  });

  it("backfills series items correctly", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const updated = await backfillDedupKeys(user.id);
    expect(updated).toBe(1);

    const items = await testPrisma.mediaItem.findMany({
      where: { libraryId: lib.id },
      select: { dedupKey: true },
    });
    expect(items[0].dedupKey).toBe("series:breaking bad:s1e1");
  });

  // The sync keys an episode on its stored series-level TVDB id
  // (`computeDedupKey` in buildRowParams); a backfill that read external ids
  // for movies only wrote the title form instead, so a backfilled copy and a
  // synced copy of the same episode never deduped.
  it("keys a series episode on its stored TVDB id, as the sync does", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server 1" });
    const server2 = await createTestServer(user.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

    // Synced copy: the key the sync wrote for an episode of TVDB show 81189.
    const synced = await createTestMediaItem(lib1.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestExternalId(synced.id, "TVDB", "81189");
    await testPrisma.mediaItem.update({
      where: { id: synced.id },
      data: { dedupKey: "series:tvdb:81189:s1e1" },
    });

    // Legacy copy on the other server, titled differently, same stored id.
    const legacy = await createTestMediaItem(lib2.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad (2008)",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestExternalId(legacy.id, "TVDB", "81189");
    await createTestExternalId(legacy.id, "TMDB", "1396");

    expect(await backfillDedupKeys(user.id)).toBe(1);

    const refreshed = await testPrisma.mediaItem.findUniqueOrThrow({
      where: { id: legacy.id },
      select: { dedupKey: true },
    });
    expect(refreshed.dedupKey).toBe("series:tvdb:81189:s1e1");

    await recomputeCanonical(user.id);
    const canonical = await testPrisma.mediaItem.count({
      where: { id: { in: [synced.id, legacy.id] }, dedupCanonical: true },
    });
    expect(canonical).toBe(1);
  });

  it("keys a track on artist and title whatever external ids it stores, as the sync does", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Server 1" });
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });

    const track = await createTestMediaItem(lib.id, {
      title: "Paranoid Android",
      type: "MUSIC",
      parentTitle: "Radiohead",
    });
    await createTestExternalId(track.id, "MUSICBRAINZ", "a74b1b7f-71a5-4011-9441-d0b5e4122711");

    expect(await backfillDedupKeys(user.id)).toBe(1);

    const refreshed = await testPrisma.mediaItem.findUniqueOrThrow({
      where: { id: track.id },
      select: { dedupKey: true },
    });
    expect(refreshed.dedupKey).toBe("music:radiohead:paranoid android");
  });

  it("backfills all items when userId is not provided", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server 1" });
    const server2 = await createTestServer(user.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createTestMediaItem(lib1.id, { title: "Movie A", type: "MOVIE", year: 2024 });
    await createTestMediaItem(lib2.id, { title: "Movie B", type: "MOVIE", year: 2024 });

    const updated = await backfillDedupKeys();
    expect(updated).toBe(2);

    // Both items should now have dedupKeys
    const allItems = await testPrisma.mediaItem.findMany({
      select: { dedupKey: true },
    });
    expect(allItems.map((i) => i.dedupKey).sort()).toEqual([
      "movie:title:movie a:2024",
      "movie:title:movie b:2024",
    ]);
  });
});
