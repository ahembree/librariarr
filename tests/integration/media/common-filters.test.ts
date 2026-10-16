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
  });
});
