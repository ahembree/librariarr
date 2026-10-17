import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { appCache } from "@/lib/cache/memory-cache";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestMediaStream,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handlers AFTER mocks
import { GET as moviesGET } from "@/app/api/media/movies/route";
import { GET as distinctGET } from "@/app/api/media/distinct-values/route";
import { GET as seriesGET } from "@/app/api/media/series/route";
import { GET as seriesGroupedGET } from "@/app/api/media/series/grouped/route";
import { GET as allSeasonsGET } from "@/app/api/media/series/all-seasons/route";
import { GET as musicGET } from "@/app/api/media/music/route";
import { GET as musicGroupedGET } from "@/app/api/media/music/grouped/route";
import { GET as albumsGET } from "@/app/api/media/music/albums/route";
import { GET as allAlbumsGET } from "@/app/api/media/music/albums/all/route";

/** `applyCommonFilters` (build-where.ts), exercised through the movies list. */
describe("common media filters", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    // The distinct-values and genre-spelling lookups are cached in-process.
    appCache.clear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function movieLibrary() {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    return createTestLibrary(server.id, { type: "MOVIE" });
  }

  async function titles(url: string) {
    const body = await expectJson<{ items: { title: string }[] }>(await callRoute(moviesGET, { url }), 200);
    return body.items.map((i) => i.title).sort();
  }

  describe("audio/subtitle language", () => {
    // An insensitive `equals` compiles to ILIKE, so `%` and `_` in the value
    // were wildcards: `audioLanguage=%` matched every item with a language.
    it("treats LIKE metacharacters in the value literally", async () => {
      const lib = await movieLibrary();
      const en = await createTestMediaItem(lib.id, { title: "English Film" });
      const es = await createTestMediaItem(lib.id, { title: "Spanish Film" });
      await createTestMediaStream(en.id, { streamType: 2, language: "English" });
      await createTestMediaStream(es.id, { streamType: 2, language: "Spanish" });
      await createTestMediaStream(en.id, { streamType: 3, language: "English" });

      // The real values match, so an empty answer below is the escaping.
      expect(await titles("/api/media/movies?audioLanguage=English")).toEqual(["English Film"]);
      expect(await titles("/api/media/movies?subtitleLanguage=English")).toEqual(["English Film"]);

      expect(await titles("/api/media/movies?audioLanguage=%25")).toEqual([]);
      expect(await titles("/api/media/movies?subtitleLanguage=Engl_sh")).toEqual([]);
      expect(await titles("/api/media/movies?audioLanguage=%25|Engl_sh")).toEqual([]);
    });

    it("still matches a language case-insensitively", async () => {
      const lib = await movieLibrary();
      const en = await createTestMediaItem(lib.id, { title: "English Film" });
      await createTestMediaStream(en.id, { streamType: 2, language: "English" });

      expect(await titles("/api/media/movies?audioLanguage=english")).toEqual(["English Film"]);
    });
  });

  describe("genre", () => {
    // The dropdown offers one entry per genre whatever its case, but
    // `array_contains` is case-sensitive: the movie carrying the spelling the
    // dropdown did not offer could never be selected.
    it("matches every stored spelling of the genre the dropdown offers", async () => {
      const lib = await movieLibrary();
      await createTestMediaItem(lib.id, { title: "Alien", genres: ["Sci-Fi"] });
      await createTestMediaItem(lib.id, { title: "Dune", genres: ["sci-fi", "Drama"] });
      await createTestMediaItem(lib.id, { title: "Heat", genres: ["Crime"] });

      const dv = await expectJson<{ genre: string[] }>(
        await callRoute(distinctGET, { url: "/api/media/distinct-values" }),
        200,
      );
      const offered = dv.genre.filter((g) => g.toLowerCase() === "sci-fi");
      expect(offered).toHaveLength(1);

      expect(await titles(`/api/media/movies?genre=${encodeURIComponent(offered[0])}`)).toEqual(["Alien", "Dune"]);
      expect(await titles("/api/media/movies?genre=SCI-FI")).toEqual(["Alien", "Dune"]);
    });

    it("still requires every selected genre", async () => {
      const lib = await movieLibrary();
      await createTestMediaItem(lib.id, { title: "Alien", genres: ["Sci-Fi"] });
      await createTestMediaItem(lib.id, { title: "Dune", genres: ["sci-fi", "Drama"] });

      expect(await titles("/api/media/movies?genre=Sci-Fi|drama")).toEqual(["Dune"]);
      expect(await titles("/api/media/movies?genre=Western")).toEqual([]);
    });

    // Every listing builds its genre clause through applyCommonFilters, and
    // each has to hand it the stored spellings — one that forgets matches only
    // the exact spelling again, and only the movies list checked it.
    it("matches every stored spelling on the series and music listings too", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const server = await createTestServer(user.id);
      const shows = await createTestLibrary(server.id, { type: "SERIES" });
      const music = await createTestLibrary(server.id, { type: "MUSIC" });
      for (const [show, genres] of [["Alpha", ["Sci-Fi"]], ["Beta", ["sci-fi"]], ["Gamma", ["Drama"]]] as const) {
        await createTestMediaItem(shows.id, {
          type: "SERIES", title: `${show} Pilot`, parentTitle: show, seasonNumber: 1, episodeNumber: 1, genres: [...genres],
        });
      }
      for (const [artist, album, genres] of [
        ["Ann", "First", ["Sci-Fi"]],
        ["Ann", "Second", ["sci-fi"]],
        ["Bob", "Third", ["sci-fi"]],
        ["Cid", "Fourth", ["Drama"]],
      ] as const) {
        await createTestMediaItem(music.id, {
          type: "MUSIC", title: `${album} Track`, parentTitle: artist, albumTitle: album, genres: [...genres],
        });
      }

      const genre = "genre=SCI-FI";
      // The names each listing returned, sorted: a count alone would pass a
      // listing that returned the wrong rows.
      const names = async (
        handler: Parameters<typeof callRoute>[0],
        url: string,
        key: string,
        field: string,
      ) =>
        (await expectJson<Record<string, Record<string, unknown>[]>>(await callRoute(handler, { url }), 200))[key]
          .map((row) => String(row[field]))
          .sort();

      expect(await names(seriesGET, `/api/media/series?${genre}`, "items", "parentTitle")).toEqual(["Alpha", "Beta"]);
      expect(await names(seriesGroupedGET, `/api/media/series/grouped?${genre}`, "series", "parentTitle")).toEqual([
        "Alpha",
        "Beta",
      ]);
      expect(await names(allSeasonsGET, `/api/media/series/all-seasons?${genre}`, "seasons", "parentTitle")).toEqual([
        "Alpha",
        "Beta",
      ]);
      expect(await names(musicGET, `/api/media/music?${genre}`, "items", "albumTitle")).toEqual([
        "First",
        "Second",
        "Third",
      ]);
      expect(await names(musicGroupedGET, `/api/media/music/grouped?${genre}`, "artists", "parentTitle")).toEqual([
        "Ann",
        "Bob",
      ]);
      expect(
        await names(albumsGET, `/api/media/music/albums?parentTitle=Ann&${genre}`, "albums", "albumTitle"),
      ).toEqual(["First", "Second"]);
      expect(
        await names(allAlbumsGET, `/api/media/music/albums/all?limit=0&${genre}`, "albums", "albumTitle"),
      ).toEqual(["First", "Second", "Third"]);
    });
  });
});
