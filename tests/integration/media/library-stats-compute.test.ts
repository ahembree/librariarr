import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

import { computeLibraryStats } from "@/lib/media/library-stats";

async function setup() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const movies = await createTestLibrary(server.id, { type: "MOVIE", key: "m" });
  const shows = await createTestLibrary(server.id, { type: "SERIES", key: "s" });
  const music = await createTestLibrary(server.id, { type: "MUSIC", key: "mu" });
  return { user, server, movies, shows, music };
}

describe("computeLibraryStats", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("ranks top music artists by summed plays and attaches the most-played track's id and art", async () => {
    const { server, music } = await setup();
    const prisma = getTestPrisma();
    await createTestMediaItem(music.id, {
      type: "MUSIC", title: "Song A", parentTitle: "Artist A", albumTitle: "Album", playCount: 2,
    });
    const a2 = await createTestMediaItem(music.id, {
      type: "MUSIC", title: "Song B", parentTitle: "Artist A", albumTitle: "Album", playCount: 9,
    });
    await prisma.mediaItem.update({ where: { id: a2.id }, data: { parentThumbUrl: "/artist-a.jpg" } });
    const b1 = await createTestMediaItem(music.id, {
      type: "MUSIC", title: "Song C", parentTitle: "Artist B", albumTitle: "Other", playCount: 3,
    });
    // Unplayed artist never appears.
    await createTestMediaItem(music.id, {
      type: "MUSIC", title: "Song D", parentTitle: "Artist C", albumTitle: "X", playCount: 0,
    });

    const stats = await computeLibraryStats([server.id], false);

    // Artist A links to its most-played track (Song B), not its first one.
    expect(stats.topMusic).toEqual([
      { parentTitle: "Artist A", totalPlays: 11, mediaItemId: a2.id, thumbUrl: "/artist-a.jpg" },
      { parentTitle: "Artist B", totalPlays: 3, mediaItemId: b1.id, thumbUrl: null },
    ]);
    expect(stats.musicCount).toBe(4);
    expect(stats.artistCount).toBe(3);
    expect(stats.albumCount).toBe(3);
  });

  it("with dedup on counts only canonical copies and uses the canonical total size", async () => {
    const { server, movies } = await setup();
    const prisma = getTestPrisma();
    const canon = await createTestMediaItem(movies.id, { title: "A", fileSize: BigInt(100), resolution: "4K" });
    const dupe = await createTestMediaItem(movies.id, { title: "A", fileSize: BigInt(50), resolution: "1080p" });
    // Two copies of one film: same dedupKey, one canonical.
    await prisma.mediaItem.update({ where: { id: canon.id }, data: { dedupKey: "movie:title:a:2024", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: dupe.id }, data: { dedupKey: "movie:title:a:2024", dedupCanonical: false } });

    const deduped = await computeLibraryStats([server.id], true);
    expect(deduped.movieCount).toBe(1);
    expect(deduped.totalSize).toBe("100");
    expect(deduped.movieSize).toBe("100");
    expect(deduped.qualityBreakdown).toEqual([{ _count: 1, resolution: "4K", type: "MOVIE" }]);

    const all = await computeLibraryStats([server.id], false);
    expect(all.movieCount).toBe(2);
    expect(all.totalSize).toBe("150");
  });

  it("with dedup on but no canonical rows falls back to every copy's total size", async () => {
    const { server, movies } = await setup();
    const prisma = getTestPrisma();
    const m = await createTestMediaItem(movies.id, { fileSize: BigInt(70) });
    await prisma.mediaItem.update({ where: { id: m.id }, data: { dedupCanonical: false } });

    const stats = await computeLibraryStats([server.id], true);
    expect(stats.movieCount).toBe(0);
    expect(stats.totalSize).toBe("70");
    expect(stats.movieSize).toBe("0");
  });

  it("orders breakdown rows by value with nulls last, then by type", async () => {
    const { server, movies, shows } = await setup();
    const prisma = getTestPrisma();
    const noRating = await createTestMediaItem(movies.id, { title: "N" });
    await prisma.mediaItem.update({ where: { id: noRating.id }, data: { contentRating: null } });
    await createTestMediaItem(movies.id, { title: "R", contentRating: "R" });
    await createTestMediaItem(shows.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, contentRating: "R",
    });
    await createTestMediaItem(movies.id, { title: "G", contentRating: "G" });

    const stats = await computeLibraryStats([server.id], false);
    expect(stats.contentRatingBreakdown).toEqual([
      { _count: 1, contentRating: "G", type: "MOVIE" },
      { _count: 1, contentRating: "R", type: "MOVIE" },
      { _count: 1, contentRating: "R", type: "SERIES" },
      { _count: 1, contentRating: null, type: "MOVIE" },
    ]);
  });

  it("names a top series with no parent title as an empty string and keeps its representative id", async () => {
    const { server, shows } = await setup();
    const ep = await createTestMediaItem(shows.id, {
      type: "SERIES", title: "Pilot", parentTitle: null, seriesKey: "tvdb:42",
      seasonNumber: 1, episodeNumber: 1, playCount: 4,
    });

    const stats = await computeLibraryStats([server.id], false);
    expect(stats.topSeries).toEqual([
      { parentTitle: "", totalPlays: 4, thumbUrl: null, mediaItemId: ep.id },
    ]);
    expect(stats.seriesCount).toBe(1);
    expect(stats.seasonCount).toBe(1);
  });

  it("returns empty top lists and zero sizes for a server with no items", async () => {
    const { server } = await setup();
    const stats = await computeLibraryStats([server.id], false);
    expect(stats.topMusic).toEqual([]);
    expect(stats.topSeries).toEqual([]);
    expect(stats.totalSize).toBe("0");
    expect(stats.movieDuration).toBe(0);
  });
});
