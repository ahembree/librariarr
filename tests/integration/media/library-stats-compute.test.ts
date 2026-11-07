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

  describe("most played with dedup on", () => {
    /** Two servers, each with a library of `type`. */
    async function twoServers(type: "MOVIE" | "SERIES" | "MUSIC") {
      const user = await createTestUser();
      const a = await createTestServer(user.id, { name: "A" });
      const b = await createTestServer(user.id, { name: "B" });
      return {
        serverIds: [a.id, b.id],
        libA: (await createTestLibrary(a.id, { type })).id,
        libB: (await createTestLibrary(b.id, { type })).id,
      };
    }

    async function copy(
      lib: string,
      dedupKey: string,
      canonical: boolean,
      fields: Parameters<typeof createTestMediaItem>[1],
    ) {
      const row = await createTestMediaItem(lib, fields);
      await getTestPrisma().mediaItem.update({ where: { id: row.id }, data: { dedupKey, dedupCanonical: canonical } });
      return row;
    }

    it("lists a film canonical on one server and watched on another, once, under its canonical copy", async () => {
      const { serverIds, libA, libB } = await twoServers("MOVIE");
      const canonical = await copy(libA, "movie:tmdb:1", true, { title: "Heat", year: 1995, playCount: 0 });
      await copy(libB, "movie:tmdb:1", false, { title: "Heat", year: 1995, playCount: 10 });
      // Both copies played: the plays add up, the title still listed once.
      const both = await copy(libA, "movie:tmdb:2", true, { title: "Ronin", year: 1998, playCount: 3 });
      await copy(libB, "movie:tmdb:2", false, { title: "Ronin", year: 1998, playCount: 4 });
      // A film on one server only, with no dedup key.
      const alone = await createTestMediaItem(libB, { title: "Thief", year: 1981, playCount: 1 });
      await getTestPrisma().mediaItem.update({ where: { id: alone.id }, data: { dedupKey: null } });

      const stats = await computeLibraryStats(serverIds, true);
      expect(stats.topMovies).toEqual([
        { id: canonical.id, title: "Heat", year: 1995, playCount: 10, thumbUrl: null },
        { id: both.id, title: "Ronin", year: 1998, playCount: 7, thumbUrl: null },
        { id: alone.id, title: "Thief", year: 1981, playCount: 1, thumbUrl: null },
      ]);
    });

    it("sums a show's and an artist's plays over every copy and links a canonical copy", async () => {
      const show = await twoServers("SERIES");
      const canonicalEp = await copy(show.libA, "series:tvdb:7:s1e1", true, {
        type: "SERIES", title: "Pilot", parentTitle: "Lost", seriesKey: "tvdb:7", seasonNumber: 1, episodeNumber: 1, playCount: 1,
      });
      await copy(show.libB, "series:tvdb:7:s1e1", false, {
        type: "SERIES", title: "Pilot", parentTitle: "Lost", seriesKey: "tvdb:7", seasonNumber: 1, episodeNumber: 1, playCount: 5,
      });
      // An episode whose only plays are on its non-canonical copy.
      await copy(show.libA, "series:tvdb:7:s1e2", true, {
        type: "SERIES", title: "Two", parentTitle: "Lost", seriesKey: "tvdb:7", seasonNumber: 1, episodeNumber: 2, playCount: 0,
      });
      await copy(show.libB, "series:tvdb:7:s1e2", false, {
        type: "SERIES", title: "Two", parentTitle: "Lost", seriesKey: "tvdb:7", seasonNumber: 1, episodeNumber: 2, playCount: 2,
      });

      const showStats = await computeLibraryStats(show.serverIds, true);
      expect(showStats.topSeries).toEqual([
        { parentTitle: "Lost", totalPlays: 8, thumbUrl: null, mediaItemId: canonicalEp.id },
      ]);

      await cleanDatabase();
      const music = await twoServers("MUSIC");
      const canonicalTrack = await copy(music.libA, "track:air:moon safari:la femme", true, {
        type: "MUSIC", title: "La Femme d'Argent", parentTitle: "Air", albumTitle: "Moon Safari", playCount: 0,
      });
      await copy(music.libB, "track:air:moon safari:la femme", false, {
        type: "MUSIC", title: "La Femme d'Argent", parentTitle: "Air", albumTitle: "Moon Safari", playCount: 6,
      });

      const musicStats = await computeLibraryStats(music.serverIds, true);
      expect(musicStats.topMusic).toEqual([
        { parentTitle: "Air", totalPlays: 6, mediaItemId: canonicalTrack.id, thumbUrl: null },
      ]);
    });
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
