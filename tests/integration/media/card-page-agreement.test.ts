/**
 * A grouped card and the detail page it opens describe the same group. The
 * album listings (All Albums tab, artist page) group tracks by artist and
 * album lower-cased and trimmed, tracks with no album under "Unknown Album";
 * the season listings put episodes with no season under season 0. The album
 * and season pages matched the record's exact fields instead, so an "Unknown
 * Album · 12 tracks" or a Specials card of unnumbered episodes opened an empty
 * page, an album merged from two spellings listed fewer tracks than its card,
 * and the artist card's album count disagreed with the albums its page shows.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
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

import { GET as allAlbumsGet } from "@/app/api/media/music/albums/all/route";
import { GET as artistAlbumsGet } from "@/app/api/media/music/albums/route";
import { GET as tracksGet } from "@/app/api/media/music/route";
import { GET as artistsGet } from "@/app/api/media/music/grouped/route";
import { GET as groupSummaryGet } from "@/app/api/media/[id]/group-summary/route";
import { GET as seasonsGet } from "@/app/api/media/series/seasons/route";
import { GET as allSeasonsGet } from "@/app/api/media/series/all-seasons/route";
import { GET as episodesGet } from "@/app/api/media/series/route";
import { GET as watchHistoryGet } from "@/app/api/media/series/watch-history/route";
import { appCache } from "@/lib/cache/memory-cache";

const prisma = getTestPrisma();

const read = async <T,>(handler: (request: NextRequest) => Promise<Response>, url: string) =>
  expectJson<T>(await callRoute(handler, { url }), 200);

interface AlbumCard {
  albumTitle: string;
  trackCount: number;
  mediaItemId: string;
}

/** The track ids the album page opened from a card lists (`detailChildrenUrl("tracks", …)`). */
async function albumPageTracks(mediaItemId: string): Promise<string[]> {
  const body = await read<{ items: { id: string }[] }>(
    tracksGet,
    `/api/media/music?itemId=${mediaItemId}&sortBy=episodeNumber&sortOrder=asc&limit=0`,
  );
  return body.items.map((i) => i.id);
}

/** The episode ids the season page opened from a card lists (`detailChildrenUrl("episodes", …)`). */
async function seasonPageEpisodes(mediaItemId: string): Promise<string[]> {
  const body = await read<{ items: { id: string }[] }>(
    episodesGet,
    `/api/media/series?itemId=${mediaItemId}&sortBy=episodeNumber&sortOrder=asc&limit=0`,
  );
  return body.items.map((i) => i.id);
}

describe("cards and the detail pages they open", () => {
  let musicLib: string;
  let seriesLib: string;
  let serverId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    serverId = (await createTestServer(user.id)).id;
    musicLib = (await createTestLibrary(serverId, { type: "MUSIC" })).id;
    seriesLib = (await createTestLibrary(serverId, { type: "SERIES" })).id;
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  const track = async (artist: string | null, album: string | null, n: number) => {
    const row = await createTestMediaItem(musicLib, { type: "MUSIC", title: `Track ${n}`, parentTitle: artist, episodeNumber: n });
    // The factory has no way to store a NULL album; set it as the sync would.
    await prisma.mediaItem.update({ where: { id: row.id }, data: { albumTitle: album } });
    return row;
  };

  describe("album pages", () => {
    it("opens an Unknown Album card onto the tracks it counts", async () => {
      const loose = [await track("Band", null, 1), await track("Band", null, 2), await track("Band", null, 3)];
      await track("Band", "Real Album", 4);

      for (const cards of [
        (await read<{ albums: AlbumCard[] }>(allAlbumsGet, "/api/media/music/albums/all")).albums,
        (await read<{ albums: AlbumCard[] }>(artistAlbumsGet, `/api/media/music/albums?itemId=${loose[0].id}`)).albums,
      ]) {
        const unknown = cards.find((a) => a.albumTitle === "Unknown Album")!;
        expect(unknown.trackCount).toBe(3);
        expect((await albumPageTracks(unknown.mediaItemId)).sort()).toEqual(loose.map((t) => t.id).sort());
      }
    });

    it("puts a blank album title in the Unknown Album card, on every album view", async () => {
      const loose = [await track("Band", null, 1), await track("Band", "", 2), await track("Band", "  ", 3)];

      const allCards = (await read<{ albums: AlbumCard[] }>(allAlbumsGet, "/api/media/music/albums/all")).albums;
      const artistCards = (await read<{ albums: AlbumCard[] }>(artistAlbumsGet, `/api/media/music/albums?itemId=${loose[1].id}`)).albums;
      for (const cards of [allCards, artistCards]) {
        expect(cards.map((c) => [c.albumTitle, c.trackCount])).toEqual([["Unknown Album", 3]]);
        expect(await albumPageTracks(cards[0].mediaItemId)).toEqual(loose.map((t) => t.id));
      }
    });

    it("lists every track of an album merged from spellings that differ in case or surrounding spaces", async () => {
      const tracks = [
        await track("Air", "Moon Safari", 1),
        await track("air ", " moon safari", 2),
        await track("AIR", "MOON SAFARI ", 3),
      ];
      // Another artist's album of the same name stays out.
      await track("Other", "Moon Safari", 4);

      const allCards = (await read<{ albums: AlbumCard[] }>(allAlbumsGet, "/api/media/music/albums/all")).albums;
      const artistCards = (await read<{ albums: AlbumCard[] }>(artistAlbumsGet, `/api/media/music/albums?itemId=${tracks[0].id}`)).albums;
      expect(artistCards).toHaveLength(1);
      for (const card of [allCards.find((a) => a.trackCount === 3)!, artistCards[0]]) {
        expect(card.trackCount).toBe(3);
        expect(await albumPageTracks(card.mediaItemId)).toEqual(tracks.map((t) => t.id));
      }
      // Opened from any of the album's tracks, not only the card's.
      expect(await albumPageTracks(tracks[1].id)).toEqual(tracks.map((t) => t.id));
    });

    it("keeps an album whose title ends in a tab apart on the artist page, as the album page and All Albums do", async () => {
      // SQL TRIM strips spaces only; the artist page's fold used JS trim(),
      // which strips the tab too and merged the two into one card.
      const plain = await track("Band", "Album", 1);
      await track("Band", "Album\t", 2);

      const cards = (await read<{ albums: AlbumCard[] }>(artistAlbumsGet, `/api/media/music/albums?itemId=${plain.id}`)).albums;
      const allCards = (await read<{ albums: AlbumCard[] }>(allAlbumsGet, "/api/media/music/albums/all")).albums;
      expect(cards.map((c) => c.trackCount)).toEqual([1, 1]);
      expect(allCards.map((c) => c.trackCount)).toEqual([1, 1]);
      for (const card of cards) {
        expect((await albumPageTracks(card.mediaItemId)).length).toBe(card.trackCount);
      }
    });

    it("opens an Unknown Artist card onto its tracks", async () => {
      const anon = [await track(null, "Bootleg", 1), await track(null, "Bootleg", 2)];

      const [card] = (await read<{ albums: (AlbumCard & { artistName: string })[] }>(allAlbumsGet, "/api/media/music/albums/all")).albums;
      expect(card).toMatchObject({ artistName: "Unknown Artist", trackCount: 2 });
      expect(await albumPageTracks(card.mediaItemId)).toEqual(anon.map((t) => t.id));
    });

    it("counts on the artist card and its summary the album cards the artist page shows", async () => {
      // Three spellings of one album (counted as three before), and a track
      // with no album (counted as none).
      const first = await track("Queen", "A Night at the Opera", 1);
      await track("queen ", "a night at the opera ", 2);
      await track("Queen", "A NIGHT AT THE OPERA", 3);
      await track("Queen", "News of the World", 4);
      await track("Queen", null, 5);

      const albums = (await read<{ albums: AlbumCard[] }>(artistAlbumsGet, `/api/media/music/albums?itemId=${first.id}`)).albums;
      expect(albums.map((a) => [a.albumTitle, a.trackCount])).toEqual([
        ["A Night at the Opera", 3],
        ["News of the World", 1],
        ["Unknown Album", 1],
      ]);

      const { artists } = await read<{ artists: { albumCount: number; trackCount: number }[] }>(artistsGet, "/api/media/music/grouped");
      const summary = await expectJson<{ albumCount: number }>(
        await callRouteWithParams(groupSummaryGet, { id: first.id }, { url: `/api/media/${first.id}/group-summary?type=MUSIC` }),
        200,
      );
      expect(artists).toHaveLength(1);
      expect(artists[0].trackCount).toBe(5);
      expect({ card: artists[0].albumCount, summary: summary.albumCount }).toEqual({ card: albums.length, summary: albums.length });
    });
  });

  describe("season pages", () => {
    const episode = (season: number | null, n: number, title = "The Show") =>
      createTestMediaItem(seriesLib, { type: "SERIES", title: `E${n}`, parentTitle: title, seasonNumber: season, episodeNumber: n });

    interface SeasonCard {
      seasonNumber: number;
      episodeCount: number;
      mediaItemId: string;
    }

    it("opens a season card made of episodes with no season onto those episodes", async () => {
      const unnumbered = [await episode(null, 1), await episode(null, 2)];
      await episode(1, 1);

      const seasons = (await read<{ seasons: SeasonCard[] }>(seasonsGet, `/api/media/series/seasons?itemId=${unnumbered[0].id}`)).seasons;
      const allSeasons = (await read<{ seasons: SeasonCard[] }>(allSeasonsGet, "/api/media/series/all-seasons")).seasons;
      for (const card of [seasons.find((s) => s.seasonNumber === 0)!, allSeasons.find((s) => s.seasonNumber === 0)!]) {
        expect(card.episodeCount).toBe(2);
        expect(await seasonPageEpisodes(card.mediaItemId)).toEqual(unnumbered.map((e) => e.id));
      }
    });

    it("lists season 0 and the unnumbered episodes together, as the card counts them", async () => {
      const special = await episode(0, 1);
      const unnumbered = await episode(null, 2);
      const season1 = await episode(1, 1);

      const seasons = (await read<{ seasons: SeasonCard[] }>(seasonsGet, `/api/media/series/seasons?itemId=${special.id}`)).seasons;
      expect(seasons.map((s) => [s.seasonNumber, s.episodeCount])).toEqual([[0, 2], [1, 1]]);
      expect(await seasonPageEpisodes(special.id)).toEqual([special.id, unnumbered.id]);
      expect(await seasonPageEpisodes(unnumbered.id)).toEqual([special.id, unnumbered.id]);
      expect(await seasonPageEpisodes(season1.id)).toEqual([season1.id]);
    });

    it("shows the plays of the season's unnumbered episodes in its watch history, an episode's alone in its own", async () => {
      const special = await episode(0, 1);
      const unnumbered = await episode(null, 1);
      await episode(1, 1);
      await prisma.watchHistory.createMany({
        data: [special.id, unnumbered.id].map((mediaItemId, i) => ({
          mediaItemId,
          mediaServerId: serverId,
          serverUsername: "alice",
          watchedAt: new Date(Date.UTC(2024, 0, i + 1)),
        })),
      });
      const history = async (query: string) =>
        (await read<{ items: { mediaItem: { id: string } }[] }>(watchHistoryGet, `/api/media/series/watch-history?parentTitle=The%20Show&${query}`)).items
          .map((r) => r.mediaItem.id)
          .sort();

      expect(await history("seasonNumber=0")).toEqual([special.id, unnumbered.id].sort());
      expect(await history("seasonNumber=0&episodeNumber=1")).toEqual([special.id]);
    });
  });
});
