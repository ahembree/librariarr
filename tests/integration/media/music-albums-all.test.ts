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

import { GET } from "@/app/api/media/music/albums/all/route";

interface Album {
  albumTitle: string;
  artistName: string;
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
  year: number | null;
}

interface AlbumsBody {
  albums: Album[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

async function list(query = "limit=0") {
  const response = await callRoute(GET, { url: `/api/media/music/albums/all?${query}` });
  return expectJson<AlbumsBody>(response, 200);
}

async function musicLibrary(serverName = "Home Plex") {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { name: serverName });
  const lib = await createTestLibrary(server.id, { type: "MUSIC" });
  setMockSession({ userId: user.id, isLoggedIn: true });
  return { user, server, lib };
}

describe("GET /api/media/music/albums/all", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/media/music/albums/all" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns no albums for a user without servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const body = await list();
    expect(body.albums).toEqual([]);
  });

  it("groups tracks by artist and album with their totals", async () => {
    const { server, lib } = await musicLibrary();
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Radiohead", albumTitle: "OK Computer", audioCodec: "flac", fileSize: BigInt(300), playCount: 2, lastPlayedAt: new Date("2024-02-01"), addedAt: new Date("2023-01-01") });
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Radiohead", albumTitle: "OK Computer", audioCodec: "mp3", fileSize: BigInt(200), playCount: 3, lastPlayedAt: new Date("2024-05-01"), addedAt: new Date("2023-06-01") });
    // Same album title by another artist is another album.
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Someone Else", albumTitle: "OK Computer", audioCodec: "flac" });

    const { albums } = await list();
    expect(albums.map((a) => `${a.artistName} / ${a.albumTitle}`).sort()).toEqual([
      "Radiohead / OK Computer",
      "Someone Else / OK Computer",
    ]);
    const ok = albums.find((a) => a.artistName === "Radiohead")!;
    expect(ok).toMatchObject({
      albumTitle: "OK Computer",
      trackCount: 2,
      totalSize: "500",
      totalPlayCount: 5,
      lastPlayed: new Date("2024-05-01").toISOString(),
      addedAt: new Date("2023-06-01").toISOString(),
      audioCodecCounts: { FLAC: 1, MP3: 1 },
      servers: [{ serverId: server.id, serverName: "Home Plex", serverType: "PLEX" }],
    });
  });

  it("files tracks without an artist or album under the placeholders", async () => {
    const { lib } = await musicLibrary();
    const track = await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: null });
    await getTestPrisma().mediaItem.update({ where: { id: track.id }, data: { albumTitle: null } });

    const { albums } = await list();
    expect(albums).toEqual([expect.objectContaining({ albumTitle: "Unknown Album", artistName: "Unknown Artist", trackCount: 1 })]);
  });

  it("merges spellings that differ only in case or surrounding spaces", async () => {
    const { lib } = await musicLibrary();
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Air", albumTitle: "Moon Safari", episodeNumber: 1 });
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "air ", albumTitle: " moon safari", episodeNumber: 2 });

    const { albums } = await list();
    expect(albums).toHaveLength(1);
    expect(albums[0].trackCount).toBe(2);
    // Displayed as the linked track spells it — track 1 here.
    expect(albums[0]).toMatchObject({ artistName: "Air", albumTitle: "Moon Safari" });
  });

  it("links the album to a track with album art and takes album-level fields from the first track that has them", async () => {
    const { lib } = await musicLibrary();
    const prisma = getTestPrisma();
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Portishead", albumTitle: "Dummy", episodeNumber: 1, studio: "Go! Beat", summary: "Trip hop." });
    const art = await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Portishead", albumTitle: "Dummy", episodeNumber: 2 });
    await prisma.mediaItem.update({ where: { id: art.id }, data: { parentThumbUrl: "/art/dummy" } });

    const [dummy] = (await list()).albums;
    expect(dummy.mediaItemId).toBe(art.id);
    expect(dummy.studio).toBe("Go! Beat");
    // The blurb is on a track that is not the art row.
    expect(dummy.summary).toBe("Trip hop.");
  });

  it("searches album and artist titles, with LIKE wildcards taken literally", async () => {
    const { lib } = await musicLibrary();
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Blur", albumTitle: "Parklife" });
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Pulp", albumTitle: "Different Class" });
    await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: "Oasis", albumTitle: "100%_Pure" });

    expect((await list("limit=0&search=blur")).albums.map((a) => a.albumTitle)).toEqual(["Parklife"]);
    expect((await list("limit=0&search=class")).albums.map((a) => a.artistName)).toEqual(["Pulp"]);
    expect((await list("limit=0&search=%25_")).albums.map((a) => a.albumTitle)).toEqual(["100%_Pure"]);
  });

  it("sorts, orders ties by artist and album, and pages", async () => {
    const { lib } = await musicLibrary();
    for (const [artist, album, tracks] of [["Cocteau Twins", "Heaven", 1], ["Beach House", "Bloom", 3], ["Air", "Talkie Walkie", 1]] as const) {
      for (let i = 0; i < tracks; i++) await createTestMediaItem(lib.id, { type: "MUSIC", parentTitle: artist, albumTitle: album });
    }

    expect((await list("limit=0&sortBy=albumTitle")).albums.map((a) => a.albumTitle)).toEqual(["Bloom", "Heaven", "Talkie Walkie"]);
    expect((await list("limit=0&sortBy=artistName&sortOrder=desc")).albums.map((a) => a.artistName)).toEqual(["Cocteau Twins", "Beach House", "Air"]);
    // Two albums tie on one track; the tie is in artist::album key order.
    expect((await list("limit=0&sortBy=trackCount&sortOrder=desc")).albums.map((a) => a.albumTitle)).toEqual(["Bloom", "Talkie Walkie", "Heaven"]);

    const first = await list("limit=2&page=1&sortBy=albumTitle");
    expect(first.albums.map((a) => a.albumTitle)).toEqual(["Bloom", "Heaven"]);
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });
    const second = await list("limit=2&page=2&sortBy=albumTitle");
    expect(second.albums.map((a) => a.albumTitle)).toEqual(["Talkie Walkie"]);
    expect(second.pagination.hasMore).toBe(false);
  });

  it("counts only the canonical copy across servers", async () => {
    const user = await createTestUser();
    const a = await createTestServer(user.id, { name: "Alpha" });
    const b = await createTestServer(user.id, { name: "Beta" });
    const libA = await createTestLibrary(a.id, { type: "MUSIC" });
    const libB = await createTestLibrary(b.id, { type: "MUSIC" });
    const prisma = getTestPrisma();
    const canonical = await createTestMediaItem(libA.id, { type: "MUSIC", title: "Smooth Operator", parentTitle: "Sade", albumTitle: "Diamond Life" });
    const copy = await createTestMediaItem(libB.id, { type: "MUSIC", title: "Smooth Operator", parentTitle: "Sade", albumTitle: "Diamond Life" });
    await prisma.mediaItem.update({ where: { id: canonical.id }, data: { dedupKey: "music:sade:smooth operator", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: copy.id }, data: { dedupKey: "music:sade:smooth operator", dedupCanonical: false } });
    setMockSession({ userId: user.id, isLoggedIn: true });

    const { albums } = await list();
    expect(albums).toHaveLength(1);
    expect(albums[0].trackCount).toBe(1);
    expect(albums[0].servers.map((s) => s.serverName)).toEqual(["Alpha"]);
  });

  it("does not list another user's albums", async () => {
    const other = await createTestUser();
    const otherServer = await createTestServer(other.id);
    const otherLib = await createTestLibrary(otherServer.id, { type: "MUSIC" });
    await createTestMediaItem(otherLib.id, { type: "MUSIC", parentTitle: "Hidden", albumTitle: "Hidden" });
    await musicLibrary();

    expect((await list()).albums).toEqual([]);
  });

  // The Albums tab forwards every library filter; this route used to read only
  // the search, so a Genre or codec filter changed nothing on screen.
  it("applies the library filters the page sends, as the artist listing does", async () => {
    const { lib } = await musicLibrary();
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Track 1", parentTitle: "Artist A", albumTitle: "Rock Album", genres: ["Rock"], audioCodec: "flac" });
    await createTestMediaItem(lib.id, { type: "MUSIC", title: "Track 2", parentTitle: "Artist B", albumTitle: "Jazz Album", genres: ["Jazz"], audioCodec: "mp3" });

    // Exactly what the page sends with the Genre chip set to Rock.
    const rock = await list("limit=0&sortBy=albumTitle&sortOrder=asc&genre=Rock");
    expect(rock.albums.map((a) => a.albumTitle)).toEqual(["Rock Album"]);

    const mp3 = await list("limit=0&audioCodec=mp3");
    expect(mp3.albums.map((a) => a.albumTitle)).toEqual(["Jazz Album"]);

    expect((await list("limit=0&genre=Blues")).albums).toEqual([]);
  });
});
