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

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_k: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return {
    // A constructor mock needs `function`: Vitest 4 cannot `new` an arrow.
    MemoryCache: vi.fn(function () {
      return noopCache;
    }),
    appCache: noopCache,
  };
});

import { GET } from "@/app/api/media/music/albums/route";

interface AlbumRow {
  albumTitle: string;
  trackCount: number;
  totalSize: string;
  audioCodecCounts: Record<string, number>;
  mediaItemId: string;
  totalPlayCount: number;
  lastPlayed: string | null;
  addedAt: string | null;
  servers: { serverId: string; serverName: string; serverType: string }[];
  summary: string | null;
  genres: string[] | null;
  studio: string | null;
  contentRating: string | null;
  rating: number | null;
  ratingImage: string | null;
  audienceRating: number | null;
  audienceRatingImage: string | null;
  year: number | null;
}

async function getAlbums(searchParams: Record<string, string>) {
  const res = await callRoute(GET, { url: "/api/media/music/albums", searchParams });
  return (await expectJson<{ albums: AlbumRow[] }>(res, 200)).albums;
}

describe("GET /api/media/music/albums — album aggregation", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("merges album titles case-insensitively and folds the first non-null metadata", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id, { name: "Main" });
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    const older = new Date("2023-01-01T00:00:00Z");
    const newer = new Date("2024-01-01T00:00:00Z");

    const t1 = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "One", parentTitle: "Band", albumTitle: "Album",
      playCount: 1, lastPlayedAt: older, addedAt: newer, fileSize: BigInt(3), audioCodec: "flac",
    });
    const t2 = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Two", parentTitle: "Band", albumTitle: "album ",
      playCount: 4, lastPlayedAt: newer, addedAt: older, fileSize: BigInt(4), audioCodec: "mp3",
      summary: "About the album", genres: ["Rock"], studio: "Label", contentRating: "E",
    });
    const newest = new Date("2024-06-01T00:00:00Z");
    const t3 = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Three", parentTitle: "Band", albumTitle: "ALBUM", addedAt: newest,
    });
    await prisma.mediaItem.update({
      where: { id: t1.id },
      data: { year: null, studio: null, contentRating: null },
    });
    await prisma.mediaItem.update({
      where: { id: t2.id },
      data: {
        parentThumbUrl: "/album.jpg", year: 1999,
        rating: 7, ratingImage: "img:r", audienceRating: 6, audienceRatingImage: "img:a",
      },
    });
    await prisma.mediaItem.update({
      where: { id: t3.id },
      data: { audioCodec: null, fileSize: null, rating: 1, year: 2020 },
    });

    const albums = await getAlbums({ parentTitle: "Band" });
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({
      albumTitle: "Album",
      trackCount: 3,
      totalSize: "7",
      audioCodecCounts: { FLAC: 1, MP3: 1, Unknown: 1 },
      mediaItemId: t2.id,
      totalPlayCount: 5,
      lastPlayed: newer.toISOString(),
      summary: "About the album",
      genres: ["Rock"],
      studio: "Label",
      contentRating: "E",
      ratingImage: "img:r",
      audienceRating: 6,
      audienceRatingImage: "img:a",
      servers: [{ serverId: server.id, serverName: "Main", serverType: "PLEX" }],
    });
    // Two tracks carry a rating/year; the fold keeps the earlier track's (no
    // track numbers here, so the row id decides), not whichever row the UPDATEs
    // above left first on disk.
    expect(albums[0].rating).toBe(7);
    expect(albums[0].year).toBe(1999);
    // addedAt is the newest track's.
    expect(albums[0].addedAt).toBe(newest.toISOString());
  });

  it("sorts albums by title and lists only canonical copies across two servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const s1 = await createTestServer(user.id, { name: "A" });
    const s2 = await createTestServer(user.id, { name: "B" });
    const l1 = await createTestLibrary(s1.id, { type: "MUSIC" });
    const l2 = await createTestLibrary(s2.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    const canonical = await createTestMediaItem(l1.id, { type: "MUSIC", title: "x", parentTitle: "Band", albumTitle: "Zeta" });
    await createTestMediaItem(l1.id, { type: "MUSIC", title: "y", parentTitle: "Band", albumTitle: "Alpha" });
    const copy = await createTestMediaItem(l2.id, {
      type: "MUSIC", title: "x", parentTitle: "Band", albumTitle: "Zeta",
    });
    // The same track on both servers: one dedupKey, server A's copy canonical.
    await prisma.mediaItem.update({ where: { id: canonical.id }, data: { dedupKey: "music:band:x", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: copy.id }, data: { dedupKey: "music:band:x", dedupCanonical: false } });

    const albums = await getAlbums({ parentTitle: "Band" });
    expect(albums.map((a) => a.albumTitle)).toEqual(["Alpha", "Zeta"]);
    const zeta = albums.find((a) => a.albumTitle === "Zeta")!;
    expect(zeta.trackCount).toBe(1);
    expect(zeta.mediaItemId).toBe(canonical.id);
    expect(zeta.servers.map((s) => s.serverName)).toEqual(["A"]);
  });

  it("applies the common filters (play count and genre narrow the tracks counted)", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Keep me", parentTitle: "Band", albumTitle: "A", playCount: 2, genres: ["Jazz"],
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Also", parentTitle: "Band", albumTitle: "A", playCount: 0, genres: ["Jazz"],
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Drop", parentTitle: "Band", albumTitle: "B", playCount: 5, genres: ["Pop"],
    });

    const played = await getAlbums({ parentTitle: "Band", playCountConditions: "gte:1" });
    expect(played.map((a) => [a.albumTitle, a.trackCount])).toEqual([["A", 1], ["B", 1]]);

    // Genre matching is case-insensitive against the stored spelling.
    const jazz = await getAlbums({ parentTitle: "Band", genre: "jazz" });
    expect(jazz.map((a) => [a.albumTitle, a.trackCount])).toEqual([["A", 2]]);
  });

  it("takes the album's fields from its first track by track number", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    const t2 = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Two", parentTitle: "Band", albumTitle: "Album", episodeNumber: 2, summary: "from two",
    });
    const t1 = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "One", parentTitle: "Band", albumTitle: "Album", episodeNumber: 1, summary: "from one",
    });
    await prisma.mediaItem.update({ where: { id: t2.id }, data: { year: 2002 } });
    await prisma.mediaItem.update({ where: { id: t1.id }, data: { year: 2001 } });

    const albums = await getAlbums({ parentTitle: "Band" });
    expect(albums).toHaveLength(1);
    // Track 1 although it was stored second; with no album art it is also the linked track.
    expect(albums[0].mediaItemId).toBe(t1.id);
    expect(albums[0].summary).toBe("from one");
    expect(albums[0].year).toBe(2001);
  });

  // The artist listing groups by LOWER(TRIM(parentTitle)), so "Air" and
  // "air " are one artist there; this route matched the exact spelling it
  // was handed and dropped the other spelling's tracks from the artist page.
  it("lists every spelling the artist listing merges into the artist", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "La Femme d'Argent", parentTitle: "Air", albumTitle: "Moon Safari" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Sexy Boy", parentTitle: "air ", albumTitle: "Moon Safari" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Cherry Blossom Girl", parentTitle: " AIR", albumTitle: "Talkie Walkie" });
    // Not the same artist: the key is the whole trimmed name.
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Other", parentTitle: "Air Supply", albumTitle: "Lost in Love" });

    for (const parentTitle of ["Air", "air ", "AIR"]) {
      const albums = await getAlbums({ parentTitle });
      expect(albums.map((a) => [a.albumTitle, a.trackCount]), parentTitle).toEqual([
        ["Moon Safari", 2],
        ["Talkie Walkie", 1],
      ]);
    }
    // A LIKE wildcard in the name is a literal, not a pattern.
    expect(await getAlbums({ parentTitle: "A_r" })).toEqual([]);
  });

  // The fold reassigned the link on EVERY track with album art, so the album
  // opened its LAST such track; the album listing links the first.
  it("links the album to its first track with album art", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    const tracks = [];
    for (const n of [1, 2, 3]) {
      tracks.push(await createTestMediaItem(lib.id, {
        type: "MUSIC", title: `T${n}`, parentTitle: "Band", albumTitle: "Album", seasonNumber: 1, episodeNumber: n,
      }));
    }
    await prisma.mediaItem.updateMany({
      where: { id: { in: [tracks[1].id, tracks[2].id] } },
      data: { parentThumbUrl: "/album.jpg" },
    });

    const [album] = await getAlbums({ parentTitle: "Band" });
    expect(album.mediaItemId).toBe(tracks[1].id);
  });

  // Track order is disc (seasonNumber) then track number, as the album
  // listing reads it: ordering by track number alone put disc 2's first track
  // ahead of disc 1's second.
  it("reads tracks in disc order before track order", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "D2T1", parentTitle: "Band", albumTitle: "Double", seasonNumber: 2, episodeNumber: 1,
      summary: "from disc two", year: 2002,
    });
    const first = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "D1T2", parentTitle: "Band", albumTitle: "Double", seasonNumber: 1, episodeNumber: 2,
      summary: "from disc one", year: 2001,
    });

    const [album] = await getAlbums({ parentTitle: "Band" });
    expect(album).toMatchObject({ mediaItemId: first.id, summary: "from disc one", year: 2001 });
  });
});
