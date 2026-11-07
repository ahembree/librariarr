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

// The real cache: the grouped listings keep their sorted rows between pages.
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { GET as moviesGet } from "@/app/api/media/movies/route";
import { GET as episodesGet } from "@/app/api/media/series/route";
import { GET as tracksGet } from "@/app/api/media/music/route";
import { GET as seriesGroupedGet } from "@/app/api/media/series/grouped/route";
import { GET as allSeasonsGet } from "@/app/api/media/series/all-seasons/route";
import { GET as artistsGet } from "@/app/api/media/music/grouped/route";
import { GET as albumsGet } from "@/app/api/media/music/albums/all/route";
import type { ListIndex } from "@/lib/media/list-index";

type Handler = Parameters<typeof callRoute>[0];

interface Paged<T> {
  pagination: { page: number; limit: number; hasMore: boolean };
  index?: ListIndex;
  items?: T[];
  series?: T[];
  seasons?: T[];
  artists?: T[];
  albums?: T[];
}

async function get<T>(handler: Handler, url: string, searchParams: Record<string, string>) {
  return expectJson<Paged<T>>(await callRoute(handler, { url, searchParams }), 200);
}

const rowsOf = <T>(body: Paged<T>): T[] => body.items ?? body.series ?? body.seasons ?? body.artists ?? body.albums ?? [];

/** Read a listing the way the library pages do: page by page, the index on the first. */
async function readPaged<T>(handler: Handler, url: string, params: Record<string, string>, limit: number) {
  const first = await get<T>(handler, url, { ...params, limit: String(limit), offset: "0", index: "1" });
  const rows = [...rowsOf(first)];
  let more = first.pagination.hasMore;
  while (more) {
    const next = await get<T>(handler, url, { ...params, limit: String(limit), offset: String(rows.length) });
    expect(rowsOf(next).length).toBeLessThanOrEqual(limit);
    expect(next.index).toBeUndefined();
    rows.push(...rowsOf(next));
    more = next.pagination.hasMore;
  }
  return { index: first.index!, rows };
}

async function seedUser() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  setMockSession({ userId: user.id, isLoggedIn: true });
  return { user, server };
}

beforeEach(async () => {
  await cleanDatabase();
  appCache.clear();
  clearMockSession();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("listing index (?index=1)", () => {
  it("answers no index unless asked", async () => {
    const { server } = await seedUser();
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "Alien" });
    for (const [handler, url] of [
      [moviesGet, "/api/media/movies"],
      [seriesGroupedGet, "/api/media/series/grouped"],
      [artistsGet, "/api/media/music/grouped"],
      [albumsGet, "/api/media/music/albums/all"],
      [allSeasonsGet, "/api/media/series/all-seasons"],
      [episodesGet, "/api/media/series"],
      [tracksGet, "/api/media/music"],
    ] as const) {
      const body = await get(handler, url, { limit: "10" });
      expect(body.index, url).toBeUndefined();
    }
  });

  it("answers an empty index for a user with no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    expect((await get(moviesGet, "/api/media/movies", { index: "1" })).index).toEqual({ total: 0, letters: {} });
    expect((await get(episodesGet, "/api/media/series", { index: "1" })).index).toEqual({ total: 0 });
    expect((await get(tracksGet, "/api/media/music", { index: "1" })).index).toEqual({ total: 0 });
    expect((await get(seriesGroupedGet, "/api/media/series/grouped", { index: "1" })).index).toEqual({
      total: 0,
      letters: {},
      sums: { seasons: 0, episodes: 0 },
    });
    expect((await get(artistsGet, "/api/media/music/grouped", { index: "1" })).index).toEqual({
      total: 0,
      letters: {},
      sums: { albums: 0, tracks: 0 },
    });
    expect((await get(albumsGet, "/api/media/music/albums/all", { index: "1" })).index).toEqual({ total: 0, letters: {} });
    expect((await get(allSeasonsGet, "/api/media/series/all-seasons", { index: "1" })).index).toEqual({ total: 0, letters: {} });
  });
});

describe("GET /api/media/movies paged", () => {
  it("counts the whole filtered listing and places each letter's first row, by sort title, in list order", async () => {
    const { server } = await seedUser();
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const titles = ["Alien", "Arrival", "Blade Runner", "12 Monkeys", "Zodiac", "Brazil", "Amélie"];
    for (const [i, title] of titles.entries()) await createTestMediaItem(lib.id, { title, year: 2000 + i });
    // The rail reads the sort title: "The Thing" files under T, as the server's sort does.
    const thing = await createTestMediaItem(lib.id, { title: "The Thing", year: 1982 });
    await getTestPrisma().mediaItem.update({ where: { id: thing.id }, data: { titleSort: "Thing" } });

    const { index, rows } = await readPaged<{ title: string }>(moviesGet, "/api/media/movies", { sortBy: "title" }, 3);
    expect(index.total).toBe(8);
    expect(rows.map((r) => r.title)).toEqual(["12 Monkeys", "Alien", "Amélie", "Arrival", "Blade Runner", "Brazil", "The Thing", "Zodiac"]);
    expect(index.letters).toEqual({ "#": 0, A: 1, B: 4, T: 6, Z: 7 });

    // Another sort: each letter's first row in that order.
    const byYear = await get(moviesGet, "/api/media/movies", { sortBy: "year", limit: "2", index: "1" });
    expect(byYear.index).toEqual({ total: 8, letters: { T: 0, A: 1, B: 3, "#": 4, Z: 5 } });
  });

  it("indexes the listing a filter narrows, track-count filters included", async () => {
    const { server } = await seedUser();
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const prisma = getTestPrisma();
    for (const [title, tracks] of [["Alpha", 2], ["Bravo", 1], ["Charlie", 3]] as const) {
      const m = await createTestMediaItem(lib.id, { title });
      for (let i = 0; i < tracks; i++) {
        await prisma.mediaStream.create({ data: { mediaItemId: m.id, streamType: 2, index: i, codec: "aac" } });
      }
    }
    const body = await get<{ title: string }>(moviesGet, "/api/media/movies", {
      audioStreamCountConditions: "gte:2",
      limit: "1",
      index: "1",
    });
    expect(body.index).toEqual({ total: 2, letters: { A: 0, C: 1 } });
    expect(rowsOf(body).map((r) => r.title)).toEqual(["Alpha"]);
    expect(body.pagination.hasMore).toBe(true);

    const searched = await get(moviesGet, "/api/media/movies", { search: "char", limit: "5", index: "1" });
    expect(searched.index).toEqual({ total: 1, letters: { C: 0 } });
  });
});

describe("flat listings' counts", () => {
  it("counts every episode and track, whatever page is read", async () => {
    const { server } = await seedUser();
    const tv = await createTestLibrary(server.id, { type: "SERIES" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });
    for (let i = 1; i <= 5; i++) {
      await createTestMediaItem(tv.id, { type: "SERIES", title: `E${i}`, parentTitle: "Show", seasonNumber: 1, episodeNumber: i });
      await createTestMediaItem(music.id, { type: "MUSIC", title: `T${i}`, parentTitle: "Artist", albumTitle: "Album", episodeNumber: i });
    }
    const episodes = await readPaged<{ title: string }>(episodesGet, "/api/media/series", { sortBy: "parentTitle" }, 2);
    expect(episodes.index).toEqual({ total: 5 });
    expect(episodes.rows.map((r) => r.title)).toEqual(["E1", "E2", "E3", "E4", "E5"]);

    const tracks = await readPaged<{ title: string }>(tracksGet, "/api/media/music", { sortBy: "title" }, 2);
    expect(tracks.index).toEqual({ total: 5 });
    expect(tracks.rows).toHaveLength(5);
  });
});

describe("grouped listings paged", () => {
  async function seedShows() {
    const { server } = await seedUser();
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    // Episodes per show: Andor 3 (2 seasons), Bluey 1, Columbo 2, 1923 1.
    const shows: [string, number, number][] = [["Andor", 1, 2], ["Andor", 2, 1], ["Bluey", 1, 1], ["Columbo", 1, 2], ["1923", 1, 1]];
    for (const [show, season, count] of shows) {
      for (let e = 1; e <= count; e++) {
        await createTestMediaItem(lib.id, {
          type: "SERIES",
          title: `${show} ${season}x${e}`,
          parentTitle: show,
          seasonNumber: season,
          episodeNumber: e,
          playCount: show === "Columbo" ? 4 : 0,
        });
      }
    }
    return lib;
  }

  it("Series: pages that join into the whole sorted listing, with the count, letters and header sums", async () => {
    await seedShows();
    const whole = rowsOf(await get<{ parentTitle: string }>(seriesGroupedGet, "/api/media/series/grouped", { limit: "0" }));
    const { index, rows } = await readPaged<{ parentTitle: string }>(seriesGroupedGet, "/api/media/series/grouped", {}, 2);
    expect(rows).toEqual(whole);
    expect(rows.map((r) => r.parentTitle)).toEqual(["1923", "Andor", "Bluey", "Columbo"]);
    expect(index).toEqual({ total: 4, letters: { "#": 0, A: 1, B: 2, C: 3 }, sums: { seasons: 5, episodes: 7 } });

    // By episode count, descending: the letters follow that order.
    const byCount = await get<{ parentTitle: string }>(seriesGroupedGet, "/api/media/series/grouped", {
      sortBy: "episodeCount",
      sortOrder: "desc",
      limit: "1",
      index: "1",
    });
    expect(rowsOf(byCount).map((r) => r.parentTitle)).toEqual(["Andor"]);
    expect(byCount.index!.letters).toEqual({ A: 0, C: 1, "#": 2, B: 3 });
  });

  it("Series: aggregates once for every page of a listing, and again after the media changes", async () => {
    const lib = await seedShows();
    const prisma = getTestPrisma();
    const spy = vi.spyOn(prisma, "$queryRawUnsafe");
    try {
      await get(seriesGroupedGet, "/api/media/series/grouped", { limit: "2", offset: "0", index: "1" });
      const aggregates = spy.mock.calls.length;
      await get(seriesGroupedGet, "/api/media/series/grouped", { limit: "2", offset: "2" });
      expect(spy.mock.calls.length).toBe(aggregates);

      await createTestMediaItem(lib.id, { type: "SERIES", title: "D1", parentTitle: "Dexter", seasonNumber: 1, episodeNumber: 1 });
      invalidateMediaCaches();
      const after = await get<{ parentTitle: string }>(seriesGroupedGet, "/api/media/series/grouped", { limit: "2", offset: "4", index: "1" });
      expect(rowsOf(after).map((r) => r.parentTitle)).toEqual(["Dexter"]);
      expect(after.index!.total).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("Series: each page reads the presence of its own shows on several servers, on rows of its own", async () => {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { name: "Plex" });
    const jelly = await createTestServer(user.id, { name: "Jellyfin" });
    const libP = await createTestLibrary(plex.id, { type: "SERIES" });
    const libJ = await createTestLibrary(jelly.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    for (const [title, libs] of [["Alpha", [libP, libJ]], ["Beta", [libP]], ["Gamma", [libJ]]] as const) {
      for (const lib of libs) {
        const item = await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: title, seriesKey: `k:${title}`, seasonNumber: 1, episodeNumber: 1 });
        await prisma.mediaItem.update({ where: { id: item.id }, data: { dedupKey: `${title}:s1e1`, dedupCanonical: lib === libs[0] } });
      }
    }
    setMockSession({ userId: user.id, isLoggedIn: true });
    const { rows } = await readPaged<{ parentTitle: string; servers: { serverName: string }[] }>(
      seriesGroupedGet,
      "/api/media/series/grouped",
      {},
      1,
    );
    expect(rows.map((r) => [r.parentTitle, r.servers.map((s) => s.serverName).sort()])).toEqual([
      ["Alpha", ["Jellyfin", "Plex"]],
      ["Beta", ["Plex"]],
      ["Gamma", ["Jellyfin"]],
    ]);
    // Read again from the kept rows: the same presence (the kept rows were not written to).
    const again = await get<{ servers: unknown[] }>(seriesGroupedGet, "/api/media/series/grouped", { limit: "1", offset: "0" });
    expect(rowsOf(again)[0].servers).toHaveLength(2);
  });

  it("All Seasons: pages by limit and offset, sorts by plays, and still answers everything without a limit", async () => {
    await seedShows();
    const whole = await get<{ parentTitle: string; seasonNumber: number }>(allSeasonsGet, "/api/media/series/all-seasons", {});
    expect(rowsOf(whole)).toHaveLength(5);
    expect(whole.pagination).toEqual({ page: 1, limit: 0, hasMore: false });

    const { index, rows } = await readPaged<{ parentTitle: string; seasonNumber: number }>(
      allSeasonsGet,
      "/api/media/series/all-seasons",
      {},
      2,
    );
    expect(rows).toEqual(rowsOf(whole));
    expect(index).toEqual({ total: 5, letters: { "#": 0, A: 1, B: 3, C: 4 } });

    const byPlays = await get<{ parentTitle: string; totalPlayCount: number }>(allSeasonsGet, "/api/media/series/all-seasons", {
      sortBy: "totalPlayCount",
      sortOrder: "desc",
      limit: "1",
    });
    expect(rowsOf(byPlays)).toEqual([expect.objectContaining({ parentTitle: "Columbo", totalPlayCount: 8 })]);
    expect(byPlays.pagination.hasMore).toBe(true);
  });

  async function seedMusic() {
    const { server } = await seedUser();
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    const tracks: [string, string, number][] = [["ABBA", "Arrival", 2], ["ABBA", "Voulez-Vous", 1], ["Bjork", "Debut", 3], ["2Pac", "Me Against", 1]];
    for (const [artist, album, count] of tracks) {
      for (let t = 1; t <= count; t++) {
        await createTestMediaItem(lib.id, { type: "MUSIC", title: `${album} ${t}`, parentTitle: artist, albumTitle: album, episodeNumber: t });
      }
    }
  }

  it("Music: artist pages that join into the whole listing, with the album and track sums", async () => {
    await seedMusic();
    const whole = rowsOf(await get(artistsGet, "/api/media/music/grouped", { limit: "0" }));
    const { index, rows } = await readPaged<{ parentTitle: string }>(artistsGet, "/api/media/music/grouped", {}, 2);
    expect(rows).toEqual(whole);
    expect(rows.map((r) => r.parentTitle)).toEqual(["2Pac", "ABBA", "Bjork"]);
    expect(index).toEqual({ total: 3, letters: { "#": 0, A: 1, B: 2 }, sums: { albums: 4, tracks: 7 } });
  });

  it("Albums: pages that join into the whole listing, sorted on the server", async () => {
    await seedMusic();
    const { index, rows } = await readPaged<{ albumTitle: string }>(albumsGet, "/api/media/music/albums/all", {}, 3);
    expect(rows.map((r) => r.albumTitle)).toEqual(["Arrival", "Debut", "Me Against", "Voulez-Vous"]);
    expect(index).toEqual({ total: 4, letters: { A: 0, D: 1, M: 2, V: 3 } });

    const byTracks = await get<{ albumTitle: string }>(albumsGet, "/api/media/music/albums/all", {
      sortBy: "trackCount",
      sortOrder: "desc",
      limit: "1",
      offset: "1",
    });
    expect(rowsOf(byTracks).map((r) => r.albumTitle)).toEqual(["Arrival"]);
  });
});
