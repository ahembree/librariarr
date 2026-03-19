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

describe("recomputeCanonical", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
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
      data: { dedupKey: "movie:tmdb:100" },
    });
    await testPrisma.mediaItem.update({
      where: { id: item2.id },
      data: { dedupKey: "movie:tmdb:100" },
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
      data: { dedupKey: "movie:tmdb:200" },
    });
    await testPrisma.mediaItem.update({
      where: { id: item2.id },
      data: { dedupKey: "movie:tmdb:200" },
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
      data: { dedupKey: "movie:tmdb:aaa" },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieA2.id },
      data: { dedupKey: "movie:tmdb:aaa" },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieB1.id },
      data: { dedupKey: "movie:tmdb:bbb" },
    });
    await testPrisma.mediaItem.update({
      where: { id: movieB2.id },
      data: { dedupKey: "movie:tmdb:bbb" },
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
  });
});

describe("backfillDedupKeys", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
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
    expect(refreshed!.dedupKey).not.toBeNull();
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
    await createTestExternalId(item.id, "tmdb", "12345");

    const updated = await backfillDedupKeys(user.id);
    expect(updated).toBe(1);

    const refreshed = await testPrisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { dedupKey: true },
    });
    expect(refreshed!.dedupKey).toBe("movie:tmdb:12345");
  });

  it("filters by userId when provided", async () => {
    const user1 = await createTestUser({ username: "user1" });
    const user2 = await createTestUser({ username: "user2" });
    const server1 = await createTestServer(user1.id, { name: "Server 1" });
    const server2 = await createTestServer(user2.id, { name: "Server 2" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    // Both users have items missing dedupKey
    await createTestMediaItem(lib1.id, { title: "User1 Movie", type: "MOVIE", year: 2024 });
    await createTestMediaItem(lib2.id, { title: "User2 Movie", type: "MOVIE", year: 2024 });

    // Only backfill for user1
    const updated = await backfillDedupKeys(user1.id);
    expect(updated).toBe(1);

    // User2's item should still have null dedupKey
    const user2Items = await testPrisma.mediaItem.findMany({
      where: { libraryId: lib2.id },
      select: { dedupKey: true },
    });
    expect(user2Items[0].dedupKey).toBeNull();
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

  it("backfills all items when userId is not provided", async () => {
    const user1 = await createTestUser({ username: "user1" });
    const user2 = await createTestUser({ username: "user2" });
    const server1 = await createTestServer(user1.id, { name: "Server 1" });
    const server2 = await createTestServer(user2.id, { name: "Server 2" });
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
    expect(allItems.every((i) => i.dedupKey !== null)).toBe(true);
  });
});
