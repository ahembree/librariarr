/**
 * The detail pages' child lists by the record's id (`?itemId=`): the seasons
 * of a show, the episodes of a season, the tracks of an album and the albums
 * of an artist answer exactly as the same list asked for by the fields the
 * page used to read off the record first.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";
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

import { GET as seasonsGet } from "@/app/api/media/series/seasons/route";
import { GET as seriesGet } from "@/app/api/media/series/route";
import { GET as musicGet } from "@/app/api/media/music/route";
import { GET as albumsGet } from "@/app/api/media/music/albums/route";

const prisma = getTestPrisma();
const read = async (handler: (request: NextRequest) => Promise<Response>, url: string, status = 200) =>
  expectJson<Record<string, unknown>>(await callRoute(handler, { url }), status);

describe("detail child lists by item id", () => {
  let userId: string;
  let seriesLib: string;
  let musicLib: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true });
    const server = await createTestServer(userId);
    seriesLib = (await createTestLibrary(server.id, { type: "SERIES" })).id;
    musicLib = (await createTestLibrary(server.id, { type: "MUSIC" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function show(seriesKey: string | null, title = "The Show") {
    const episodes = [];
    for (const [season, episode] of [[1, 1], [1, 2], [2, 1]] as const) {
      episodes.push(
        await createTestMediaItem(seriesLib, {
          type: "SERIES", title: `E${season}${episode}`, parentTitle: title, seasonNumber: season, episodeNumber: episode,
          ...(seriesKey !== null ? { seriesKey } : { seriesKey: null }), summary: `Episode ${season}x${episode}`,
        }),
      );
    }
    return episodes;
  }

  it("lists a show's seasons by one of its episodes, as by its series key", async () => {
    const [episode] = await show("tvdb:7");
    // A same-titled different show must stay out of it.
    await show("tvdb:8");
    const byKey = await read(seasonsGet, "/api/media/series/seasons?seriesKey=tvdb%3A7");
    const byItem = await read(seasonsGet, `/api/media/series/seasons?itemId=${episode.id}`);
    expect(byItem).toEqual(byKey);
    expect((byItem.seasons as { episodeCount: number }[]).map((s) => s.episodeCount)).toEqual([2, 1]);
  });

  it("falls back to the title for a show stored without a series key", async () => {
    const [episode] = await show(null, "Legacy Show");
    const byTitle = await read(seasonsGet, "/api/media/series/seasons?parentTitle=Legacy%20Show");
    expect(await read(seasonsGet, `/api/media/series/seasons?itemId=${episode.id}`)).toEqual(byTitle);
    expect((byTitle.seasons as unknown[]).length).toBe(2);
  });

  it("lists a season's episodes by one of them, as by its series and season", async () => {
    const episodes = await show("tvdb:7");
    const season2 = episodes[2];
    const query = "sortBy=episodeNumber&sortOrder=asc&limit=0";
    const byFields = await read(seriesGet, `/api/media/series?seriesKey=tvdb%3A7&seasonNumber=2&${query}`);
    const byItem = await read(seriesGet, `/api/media/series?itemId=${season2.id}&${query}`);
    expect(byItem).toEqual(byFields);
    expect((byItem.items as { id: string }[]).map((i) => i.id)).toEqual([season2.id]);
  });

  it("lists an album's tracks and an artist's albums by one of its tracks", async () => {
    const tracks = [];
    for (const [album, n] of [["Alpha", 1], ["Alpha", 2], ["Beta", 1]] as const) {
      tracks.push(await createTestMediaItem(musicLib, { type: "MUSIC", title: `${album} ${n}`, parentTitle: "Band", albumTitle: album, episodeNumber: n }));
    }
    await createTestMediaItem(musicLib, { type: "MUSIC", title: "Other", parentTitle: "Other Band", albumTitle: "Alpha" });

    const query = "sortBy=episodeNumber&sortOrder=asc&limit=0";
    const byFields = await read(musicGet, `/api/media/music?parentTitle=Band&albumTitle=Alpha&${query}`);
    const byItem = await read(musicGet, `/api/media/music?itemId=${tracks[1].id}&${query}`);
    expect(byItem).toEqual(byFields);
    expect((byItem.items as { id: string }[]).map((i) => i.id)).toEqual([tracks[0].id, tracks[1].id]);

    const albumsByName = await read(albumsGet, "/api/media/music/albums?parentTitle=Band");
    expect(await read(albumsGet, `/api/media/music/albums?itemId=${tracks[2].id}`)).toEqual(albumsByName);
    expect((albumsByName.albums as { albumTitle: string }[]).map((a) => a.albumTitle)).toEqual(["Alpha", "Beta"]);
  });

  it("answers 404 for an item that is missing or of the other type", async () => {
    const [episode] = await show("tvdb:7");
    const track = await createTestMediaItem(musicLib, { type: "MUSIC", parentTitle: "Band", albumTitle: "LP" });

    for (const id of ["missing", track.id]) {
      await read(seasonsGet, `/api/media/series/seasons?itemId=${id}`, 404);
      await read(seriesGet, `/api/media/series?itemId=${id}`, 404);
    }
    for (const id of ["missing", episode.id]) {
      await read(musicGet, `/api/media/music?itemId=${id}`, 404);
      await read(albumsGet, `/api/media/music/albums?itemId=${id}`, 404);
    }
  });

  it("answers an empty list for a record that names no season or album", async () => {
    const orphanEpisode = await createTestMediaItem(seriesLib, { type: "SERIES", title: "Lost", parentTitle: null, seriesKey: null });
    const looseTrack = await createTestMediaItem(musicLib, { type: "MUSIC", title: "Loose", parentTitle: "Band" });
    await prisma.mediaItem.update({ where: { id: looseTrack.id }, data: { albumTitle: null } });

    expect((await read(seriesGet, `/api/media/series?itemId=${orphanEpisode.id}`)).items).toEqual([]);
    expect((await read(musicGet, `/api/media/music?itemId=${looseTrack.id}`)).items).toEqual([]);
  });

  describe("season and album summaries", () => {
    it("takes a season's blurb from its first summarised episode, the show's text before the episode's", async () => {
      const first = await createTestMediaItem(seriesLib, { type: "SERIES", title: "A", parentTitle: "S", seriesKey: "tvdb:1", seasonNumber: 1, episodeNumber: 1 });
      const second = await createTestMediaItem(seriesLib, { type: "SERIES", title: "B", parentTitle: "S", seriesKey: "tvdb:1", seasonNumber: 1, episodeNumber: 2, summary: "Own text" });
      const third = await createTestMediaItem(seriesLib, { type: "SERIES", title: "C", parentTitle: "S", seriesKey: "tvdb:1", seasonNumber: 2, episodeNumber: 1, summary: "Season two episode" });
      // Blank text is no blurb; the show's text beats the episode's own.
      await prisma.mediaItem.update({ where: { id: first.id }, data: { summary: "", parentSummary: "" } });
      await prisma.mediaItem.update({ where: { id: second.id }, data: { parentSummary: "Show text" } });
      await prisma.mediaItem.update({ where: { id: third.id }, data: { parentSummary: null } });

      const { seasons } = (await read(seasonsGet, "/api/media/series/seasons?seriesKey=tvdb%3A1")) as {
        seasons: { seasonNumber: number; summary: string | null }[];
      };
      expect(seasons.map((s) => [s.seasonNumber, s.summary])).toEqual([[1, "Show text"], [2, "Season two episode"]]);
    });

    it("leaves a season with no summarised episode without a blurb", async () => {
      await createTestMediaItem(seriesLib, { type: "SERIES", title: "A", parentTitle: "S", seriesKey: "tvdb:1", seasonNumber: 1, episodeNumber: 1 });
      const { seasons } = (await read(seasonsGet, "/api/media/series/seasons?seriesKey=tvdb%3A1")) as {
        seasons: { summary: string | null }[];
      };
      expect(seasons[0].summary).toBeNull();
    });

    it("takes an album's blurb from its first track that has one, a blank one counting as none", async () => {
      const blank = await createTestMediaItem(musicLib, { type: "MUSIC", title: "1", parentTitle: "Band", albumTitle: "LP", episodeNumber: 1, summary: "" });
      await createTestMediaItem(musicLib, { type: "MUSIC", title: "2", parentTitle: "Band", albumTitle: "LP", episodeNumber: 2, summary: "Bio" });
      await createTestMediaItem(musicLib, { type: "MUSIC", title: "3", parentTitle: "Band", albumTitle: "LP", episodeNumber: 3, summary: "Later" });
      await createTestMediaItem(musicLib, { type: "MUSIC", title: "x", parentTitle: "Band", albumTitle: "EP", episodeNumber: 1 });
      expect(blank.summary).toBe("");

      const { albums } = (await read(albumsGet, "/api/media/music/albums?parentTitle=Band")) as {
        albums: { albumTitle: string; summary: string | null }[];
      };
      expect(albums.map((a) => [a.albumTitle, a.summary])).toEqual([["EP", null], ["LP", "Bio"]]);
    });
  });
});
