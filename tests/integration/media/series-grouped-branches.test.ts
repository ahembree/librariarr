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

import { GET } from "@/app/api/media/series/grouped/route";
import { appCache } from "@/lib/cache/memory-cache";

type Series = {
  parentTitle: string;
  seriesKey: string;
  episodeCount: number;
  seasonCount: number;
  watchedEpisodeCount: number;
  summary: string | null;
  thumbUrl: string | null;
  isWatchlisted: boolean;
};

const DAY = 86_400_000;

describe("GET /api/media/series/grouped — sorts and show-level filters", () => {
  let libraryId: string;

  async function list(searchParams: Record<string, string> = {}) {
    const body = await expectJson<{ series: Series[]; pagination: { hasMore: boolean } }>(
      await callRoute(GET, { url: "/api/media/series/grouped", searchParams }),
    );
    return body.series;
  }
  const names = async (sp: Record<string, string> = {}) => (await list(sp)).map((s) => s.parentTitle);

  async function episode(
    show: string,
    season: number,
    ep: number,
    extra: Parameters<typeof createTestMediaItem>[1] = {},
    raw: Record<string, unknown> = {},
  ) {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: `${show} ${season}x${ep}`,
      parentTitle: show,
      seasonNumber: season,
      episodeNumber: ep,
      ...extra,
    });
    if (Object.keys(raw).length > 0) {
      await getTestPrisma().mediaItem.update({ where: { id: item.id }, data: raw });
    }
    return item;
  }

  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    libraryId = (await createTestLibrary(server.id, { type: "SERIES" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seed() {
    const now = Date.now();
    // Alpha: 3 episodes, 2 seasons, 1 watched, old, aired long ago, watchlisted
    await episode("Alpha", 1, 1, {
      playCount: 1,
      lastPlayedAt: new Date(now - 400 * DAY),
      addedAt: new Date(now - 500 * DAY),
    }, { originallyAvailableAt: new Date("2010-01-01T00:00:00Z"), isWatchlisted: true });
    await episode("Alpha", 1, 2, { addedAt: new Date(now - 500 * DAY) });
    await episode("Alpha", 2, 1, { addedAt: new Date(now - 500 * DAY) });
    // Bravo: 1 episode, played recently, fully watched, recently added and aired
    await episode("Bravo", 1, 1, {
      playCount: 2,
      lastPlayedAt: new Date(now - 2 * DAY),
      addedAt: new Date(now - 3 * DAY),
    }, { originallyAvailableAt: new Date(now - 5 * DAY) });
    // Charlie: 2 episodes, never played, no dates beyond addedAt
    await episode("Charlie", 1, 1, { addedAt: new Date(now - 50 * DAY) });
    await episode("Charlie", 1, 2, { addedAt: new Date(now - 50 * DAY) });
  }

  it("returns an empty list when the user has no servers", async () => {
    await getTestPrisma().mediaServer.deleteMany();
    const body = await expectJson<{ series: unknown[]; pagination: { hasMore: boolean } }>(
      await callRoute(GET, { url: "/api/media/series/grouped" }),
    );
    expect(body.series).toEqual([]);
    expect(body.pagination.hasMore).toBe(false);
  });

  it("sorts by every aggregate column in both directions", async () => {
    await seed();
    expect((await names({ sortBy: "seasonCount", sortOrder: "desc" }))[0]).toBe("Alpha");
    expect(await names({ sortBy: "lastPlayed", sortOrder: "desc" })).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(await names({ sortBy: "lastPlayed", sortOrder: "asc" })).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(await names({ sortBy: "addedAt", sortOrder: "desc" })).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect((await names({ sortBy: "watchedEpisodeCount", sortOrder: "asc" }))[0]).toBe("Charlie");
    const byWatched = await list({ sortBy: "watchedEpisodeCount", sortOrder: "desc" });
    expect(byWatched[byWatched.length - 1].parentTitle).toBe("Charlie");
    expect(await names({ sortBy: "lastEpisodeAiredAt", sortOrder: "desc" })).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(await names({ sortBy: "lastEpisodeAiredAt", sortOrder: "asc" })).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("applies the comparison operators and OR logic to episode counts", async () => {
    await seed();
    expect(await names({ episodeCountConditions: "gt:2" })).toEqual(["Alpha"]);
    expect(await names({ episodeCountConditions: "lt:2" })).toEqual(["Bravo"]);
    expect(await names({ episodeCountConditions: "lte:2" })).toEqual(["Bravo", "Charlie"]);
    // A bare number is an equality test.
    expect(await names({ episodeCountConditions: "2" })).toEqual(["Charlie"]);
    expect(await names({ episodeCountConditions: "eq:3" })).toEqual(["Alpha"]);
    expect(
      await names({ episodeCountConditions: "eq:1|eq:3", episodeCountLogic: "or" }),
    ).toEqual(["Alpha", "Bravo"]);
    // Every part unparseable → no filter at all.
    expect(await names({ episodeCountConditions: "gt:abc" })).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("filters on watched-episode count", async () => {
    await seed();
    expect(await names({ watchedEpisodeCountConditions: "gte:1" })).toEqual(["Alpha", "Bravo"]);
    expect(await names({ watchedEpisodeCountConditions: "eq:0" })).toEqual(["Charlie"]);
  });

  it("filters dates by a last-N-days window, ignoring a non-positive one", async () => {
    await seed();
    expect(await names({ lastPlayedAtDays: "7" })).toEqual(["Bravo"]);
    expect(await names({ addedAtDays: "60" })).toEqual(["Bravo", "Charlie"]);
    expect(await names({ lastEpisodeAiredAtDays: "30" })).toEqual(["Bravo"]);
    expect(await names({ lastPlayedAtDays: "0" })).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(await names({ lastPlayedAtDays: "nope" })).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("filters by a lower date bound alone, excluding shows with no date", async () => {
    await seed();
    expect(await names({ lastEpisodeAiredAtMin: "2000-01-01" })).toEqual(["Alpha", "Bravo"]);
    expect(await names({ lastEpisodeAiredAtMax: "2015-01-01" })).toEqual(["Alpha"]);
  });

  it("filters by watchlist status in both directions", async () => {
    await seed();
    expect(await names({ isWatchlisted: "true" })).toEqual(["Alpha"]);
    expect(await names({ isWatchlisted: "false" })).toEqual(["Bravo", "Charlie"]);
  });

  it("takes the show's summary from another episode when the artwork row has none", async () => {
    await episode("Delta", 1, 1, { thumbUrl: "/thumb/1" });
    await episode("Delta", 1, 2, { summary: "A show about deltas." });
    const [delta] = await list();
    expect(delta.thumbUrl).toBe("/thumb/1");
    expect(delta.summary).toBe("A show about deltas.");
  });

  it("returns everything after an offset with limit=0", async () => {
    await seed();
    const body = await expectJson<{ series: Series[]; pagination: { hasMore: boolean } }>(
      await callRoute(GET, { url: "/api/media/series/grouped", searchParams: { limit: "0", offset: "1" } }),
    );
    expect(body.series.map((s) => s.parentTitle)).toEqual(["Bravo", "Charlie"]);
    expect(body.pagination.hasMore).toBe(false);
  });
});
