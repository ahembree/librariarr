import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
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

// Import AFTER mocks
import { backfillSeriesKeys } from "@/lib/dedup/recompute-canonical";
import { computeSeriesKey } from "@/lib/media/series-key";

/**
 * The startup backfill (`backfillSeriesKeys`, and the identical SQL in
 * migration 0015) is the SQL twin of `computeSeriesKey`. This asserts the two
 * agree on seeded rows, so the column a legacy row gets is what a freshly-synced
 * row would get.
 */
describe("backfillSeriesKeys", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seedSeriesLibrary() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    return { user, lib };
  }

  /** Create a SERIES row with seriesKey explicitly NULL (a pre-0015 row). */
  async function legacyEpisode(
    libId: string,
    parentTitle: string | null,
    externalIds: Array<{ source: string; id: string }> = [],
  ) {
    const ep = await createTestMediaItem(libId, {
      type: "SERIES",
      title: "Episode",
      parentTitle: parentTitle ?? undefined,
      seriesKey: null,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    for (const e of externalIds) await createTestExternalId(ep.id, e.source, e.id);
    return ep.id;
  }

  it("computes the same key the TS helper does (TVDB > TMDB > title)", async () => {
    const { lib } = await seedSeriesLibrary();

    const tvdbId = await legacyEpisode(lib.id, "The Office", [
      { source: "TVDB", id: "73244" },
      { source: "TMDB", id: "2316" },
    ]);
    const tmdbId = await legacyEpisode(lib.id, "Some Show", [{ source: "TMDB", id: "555" }]);
    const titleId = await legacyEpisode(lib.id, "Untracked Show", []);

    const updated = await backfillSeriesKeys();
    expect(updated).toBe(3);

    const prisma = getTestPrisma();
    const rows = await prisma.mediaItem.findMany({
      where: { id: { in: [tvdbId, tmdbId, titleId] } },
      select: { id: true, seriesKey: true },
    });
    const keyOf = (id: string) => rows.find((r) => r.id === id)!.seriesKey;

    expect(keyOf(tvdbId)).toBe("tvdb:73244");
    expect(keyOf(tvdbId)).toBe(
      computeSeriesKey({ parentTitle: "The Office", externalIds: [{ source: "TVDB", id: "73244" }] }),
    );
    expect(keyOf(tmdbId)).toBe("tmdb:555");
    expect(keyOf(titleId)).toBe("title:untracked show");
  });

  it("leaves movies untouched (seriesKey stays null)", async () => {
    const { user } = await seedSeriesLibrary();
    const server = await createTestServer(user.id, { name: "Movies" });
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(movieLib.id, { type: "MOVIE", title: "Heat" });

    await backfillSeriesKeys();

    const after = await getTestPrisma().mediaItem.findFirstOrThrow({ where: { id: movie.id } });
    expect(after.seriesKey).toBeNull();
  });

  it("does not overwrite a row that already has a seriesKey", async () => {
    const { lib } = await seedSeriesLibrary();
    const ep = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "Ep", parentTitle: "Kept", seriesKey: "tvdb:1",
      seasonNumber: 1, episodeNumber: 1,
    });

    const updated = await backfillSeriesKeys();
    expect(updated).toBe(0);
    const after = await getTestPrisma().mediaItem.findFirstOrThrow({ where: { id: ep.id } });
    expect(after.seriesKey).toBe("tvdb:1");
  });
});
