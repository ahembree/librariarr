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
  return { MemoryCache: vi.fn(() => noopCache), appCache: noopCache };
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
    const t3 = await createTestMediaItem(lib.id, {
      type: "MUSIC", title: "Three", parentTitle: "Band", albumTitle: "ALBUM",
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
    // Two tracks carry a rating/year; the fold keeps whichever it saw first.
    expect(albums[0].rating).toBeOneOf([7, 1]);
    expect(albums[0].year).toBeOneOf([1999, 2020]);
    // addedAt is the newest track's.
    expect(new Date(albums[0].addedAt!).getTime()).toBeGreaterThanOrEqual(newer.getTime());
  });

  it("sorts albums by title and lists only canonical copies across two servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const s1 = await createTestServer(user.id, { name: "A" });
    const s2 = await createTestServer(user.id, { name: "B" });
    const l1 = await createTestLibrary(s1.id, { type: "MUSIC" });
    const l2 = await createTestLibrary(s2.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    await createTestMediaItem(l1.id, { type: "MUSIC", title: "x", parentTitle: "Band", albumTitle: "Zeta" });
    await createTestMediaItem(l1.id, { type: "MUSIC", title: "y", parentTitle: "Band", albumTitle: "Alpha" });
    const copy = await createTestMediaItem(l2.id, {
      type: "MUSIC", title: "x", parentTitle: "Band", albumTitle: "Zeta",
    });
    await prisma.mediaItem.update({ where: { id: copy.id }, data: { dedupCanonical: false } });

    const albums = await getAlbums({ parentTitle: "Band" });
    expect(albums.map((a) => a.albumTitle)).toEqual(["Alpha", "Zeta"]);
    expect(albums.find((a) => a.albumTitle === "Zeta")!.trackCount).toBe(1);
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
});
