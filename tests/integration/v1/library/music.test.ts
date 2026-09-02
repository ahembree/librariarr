import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../../setup/test-db";
import { clearMockSession } from "../../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  expectJson,
} from "../../../setup/test-helpers";
import { callV1 } from "../v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/library/music/route";
import { appCache } from "@/lib/cache/memory-cache";

interface V1Track {
  id: string;
  title: string;
  type: string;
  parentTitle: string | null;
  albumTitle: string | null;
  trackNumber: number | null;
  fileSize: string | null;
  library: { id: string; title: string };
  server: { id: string; name: string; type: string };
}

interface TrackList {
  items: V1Track[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

const URL_MUSIC = "/api/v1/library/music";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  appCache.clear();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedOwner() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id);
  const server = await createTestServer(user.id, { name: "Main" });
  const library = await createTestLibrary(server.id, { title: "Music", type: "MUSIC" });
  return { user, raw, server, library };
}

function addTrack(
  libraryId: string,
  artist: string,
  album: string,
  track: number,
  title = `${album} ${track}`,
) {
  return createTestMediaItem(libraryId, {
    title,
    type: "MUSIC",
    parentTitle: artist,
    albumTitle: album,
    episodeNumber: track,
  });
}

describe("GET /api/v1/library/music", () => {
  it("returns an empty list when the user has no servers", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<TrackList>(await callV1(GET, { url: URL_MUSIC, key: raw }));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("renames episodeNumber to trackNumber and drops the raw column", async () => {
    const { raw, library } = await seedOwner();
    await addTrack(library.id, "Radiohead", "OK Computer", 3, "Subterranean Homesick Alien");

    const body = await expectJson<TrackList>(await callV1(GET, { url: URL_MUSIC, key: raw }));
    const [track] = body.items;
    expect(track.trackNumber).toBe(3);
    // The shared column name must not leak into the music contract.
    expect(track).not.toHaveProperty("episodeNumber");
    expect(track).not.toHaveProperty("seasonNumber");
  });

  it("returns the stored MUSIC type with artist, album and a serialized fileSize", async () => {
    const { raw, server, library } = await seedOwner();
    await createTestMediaItem(library.id, {
      title: "Paranoid Android",
      type: "MUSIC",
      parentTitle: "Radiohead",
      albumTitle: "OK Computer",
      episodeNumber: 2,
      fileSize: BigInt("12345678901"),
    });

    const body = await expectJson<TrackList>(await callV1(GET, { url: URL_MUSIC, key: raw }));
    const [track] = body.items;
    expect(track.type).toBe("MUSIC");
    expect(track.parentTitle).toBe("Radiohead");
    expect(track.albumTitle).toBe("OK Computer");
    expect(typeof track.fileSize).toBe("string");
    expect(track.fileSize).toBe("12345678901");
    expect(track.library).toEqual({ id: library.id, title: "Music" });
    expect(track.server).toEqual({ id: server.id, name: "Main", type: "PLEX" });
  });

  it("excludes movies and episodes", async () => {
    const { raw, server, library } = await seedOwner();
    const movies = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    const tv = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });
    await addTrack(library.id, "Artist", "Album", 1, "A Track");
    await createTestMediaItem(movies.id, { title: "A Movie" });
    await createTestMediaItem(tv.id, {
      title: "An Episode",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const body = await expectJson<TrackList>(await callV1(GET, { url: URL_MUSIC, key: raw }));
    expect(body.items.map((i) => i.title)).toEqual(["A Track"]);
  });

  it("orders by artist, then album, then track number", async () => {
    const { raw, library } = await seedOwner();
    await addTrack(library.id, "Zappa", "Apostrophe", 1, "Z-A-1");
    await addTrack(library.id, "Air", "Moon Safari", 2, "A-M-2");
    await addTrack(library.id, "Air", "Moon Safari", 1, "A-M-1");
    await addTrack(library.id, "Air", "Amazonia", 1, "A-A-1");

    const body = await expectJson<TrackList>(await callV1(GET, { url: URL_MUSIC, key: raw }));
    expect(body.items.map((i) => i.title)).toEqual(["A-A-1", "A-M-1", "A-M-2", "Z-A-1"]);
  });

  it("filters by artist and album exactly", async () => {
    const { raw, library } = await seedOwner();
    await addTrack(library.id, "Air", "Moon Safari", 1, "Sexy Boy");
    await addTrack(library.id, "Air", "Talkie Walkie", 1, "Alpha Beta Gaga");
    await addTrack(library.id, "Airbag", "Other", 1, "Elsewhere");

    const byArtist = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { artist: "Air" } }),
    );
    expect(byArtist.items).toHaveLength(2);

    const byAlbum = await expectJson<TrackList>(
      await callV1(GET, {
        url: URL_MUSIC,
        key: raw,
        searchParams: { artist: "Air", album: "Talkie Walkie" },
      }),
    );
    expect(byAlbum.items.map((i) => i.title)).toEqual(["Alpha Beta Gaga"]);
  });

  it("searches across track, artist and album titles", async () => {
    const { raw, library } = await seedOwner();
    await addTrack(library.id, "Portishead", "Dummy", 1, "Mysterons");
    await addTrack(library.id, "Massive Attack", "Mezzanine", 1, "Angel");

    const byTrack = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { search: "mysterons" } }),
    );
    expect(byTrack.items).toHaveLength(1);

    const byArtist = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { search: "massive" } }),
    );
    expect(byArtist.items.map((i) => i.title)).toEqual(["Angel"]);

    const byAlbum = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { search: "dummy" } }),
    );
    expect(byAlbum.items.map((i) => i.title)).toEqual(["Mysterons"]);
  });

  it("paginates and clamps limit to 200", async () => {
    const { raw, library } = await seedOwner();
    for (let i = 1; i <= 3; i++) await addTrack(library.id, "Artist", "Album", i, `T${i}`);

    const first = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { limit: "2" } }),
    );
    expect(first.items.map((i) => i.title)).toEqual(["T1", "T2"]);
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });

    const second = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { limit: "2", page: "2" } }),
    );
    expect(second.items.map((i) => i.title)).toEqual(["T3"]);
    expect(second.pagination.hasMore).toBe(false);

    const capped = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { limit: "1000" } }),
    );
    expect(capped.pagination.limit).toBe(200);
  });

  it("returns nothing for an unknown serverId", async () => {
    const { raw, library } = await seedOwner();
    await addTrack(library.id, "Artist", "Album", 1);

    const body = await expectJson<TrackList>(
      await callV1(GET, { url: URL_MUSIC, key: raw, searchParams: { serverId: "nope" } }),
    );
    expect(body.items).toEqual([]);
  });

  it("never returns another user's tracks", async () => {
    const { raw, library } = await seedOwner();
    await addTrack(library.id, "Mine", "Album", 1, "Mine");

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "Music", type: "MUSIC" });
    await addTrack(theirLib.id, "Theirs", "Album", 1, "Theirs");

    const body = await expectJson<TrackList>(await callV1(GET, { url: URL_MUSIC, key: raw }));
    expect(body.items.map((i) => i.title)).toEqual(["Mine"]);

    const pointed = await expectJson<TrackList>(
      await callV1(GET, {
        url: URL_MUSIC,
        key: raw,
        searchParams: { serverId: theirServer.id },
      }),
    );
    expect(pointed.items).toEqual([]);
  });
});
