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

import { GET } from "@/app/api/media/series/seasons/route";

interface SeasonRow {
  seasonNumber: number;
  episodeCount: number;
  totalSize: string;
  qualityCounts: Record<string, number>;
  mediaItemId: string;
  lastPlayed: string | null;
  addedAt: string | null;
  totalPlayCount: number;
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

async function getSeasons(searchParams: Record<string, string>) {
  const res = await callRoute(GET, { url: "/api/media/series/seasons", searchParams });
  return (await expectJson<{ seasons: SeasonRow[] }>(res, 200)).seasons;
}

describe("GET /api/media/series/seasons — season aggregation", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("takes each metadata field from the first episode that has it and the art row's id", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id, { name: "Main" });
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();

    const older = new Date("2024-01-01T00:00:00Z");
    const newer = new Date("2024-06-01T00:00:00Z");
    const e1 = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
      addedAt: newer, lastPlayedAt: newer, playCount: 2, fileSize: BigInt(10), year: 2001,
    });
    const e2 = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E2", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2,
      addedAt: older, lastPlayedAt: older, playCount: 3, fileSize: BigInt(5),
      summary: "Episode blurb", genres: ["Drama"], studio: "HBO", contentRating: "TV-MA",
    });
    // A blank first episode and a second one that fills in the ratings.
    await prisma.mediaItem.update({
      where: { id: e1.id },
      data: { contentRating: null, studio: null, summary: null },
    });
    await prisma.mediaItem.update({
      where: { id: e2.id },
      data: {
        seasonThumbUrl: "/season.jpg", parentSummary: "Season blurb", year: null,
        rating: 8.5, ratingImage: "rt://ripe", audienceRating: 9.1, audienceRatingImage: "rt://upright",
      },
    });

    const [season] = await getSeasons({ parentTitle: "Show" });
    expect(season).toMatchObject({
      seasonNumber: 1,
      episodeCount: 2,
      totalSize: "15",
      totalPlayCount: 5,
      mediaItemId: e2.id,
      lastPlayed: newer.toISOString(),
      addedAt: newer.toISOString(),
      summary: "Season blurb",
      genres: ["Drama"],
      studio: "HBO",
      contentRating: "TV-MA",
      rating: 8.5,
      ratingImage: "rt://ripe",
      audienceRating: 9.1,
      audienceRatingImage: "rt://upright",
      year: 2001,
      servers: [{ serverId: server.id, serverName: "Main", serverType: "PLEX" }],
    });
  });

  it("counts an episode with no file size as zero bytes", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    const e1 = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 2, episodeNumber: 1, summary: "First",
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E2", parentTitle: "Show", seasonNumber: 2, episodeNumber: 2,
      summary: "Second", fileSize: BigInt(7),
    });
    await prisma.mediaItem.update({ where: { id: e1.id }, data: { fileSize: null, year: null } });

    const [season] = await getSeasons({ parentTitle: "Show" });
    expect(season.totalSize).toBe("7");
    expect(season.episodeCount).toBe(2);
    // Both episodes carry a summary and neither has season art: the fold keeps
    // the first episode's, whatever order the rows sit in on disk (the UPDATE
    // above moved E1's row after E2's).
    expect(season.summary).toBe("First");
    expect(season.year).toBe(2024);
  });

  it("lists only canonical copies when two servers hold the show", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const s1 = await createTestServer(user.id, { name: "A" });
    const s2 = await createTestServer(user.id, { name: "B" });
    const l1 = await createTestLibrary(s1.id, { type: "SERIES" });
    const l2 = await createTestLibrary(s2.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    await createTestMediaItem(l1.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
    });
    const copy = await createTestMediaItem(l2.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
    });
    await prisma.mediaItem.update({ where: { id: copy.id }, data: { dedupCanonical: false } });

    const seasons = await getSeasons({ parentTitle: "Show" });
    expect(seasons).toHaveLength(1);
    expect(seasons[0].episodeCount).toBe(1);
    expect(seasons[0].servers.map((s) => s.serverName)).toEqual(["A"]);

    // Narrowed to the second server, its own copy is listed even though it is not canonical.
    const onB = await getSeasons({ parentTitle: "Show", serverId: s2.id });
    expect(onB[0].servers.map((s) => s.serverName)).toEqual(["B"]);
  });

  it("answers no seasons for a serverId the user does not own", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
    });
    expect(await getSeasons({ parentTitle: "Show", serverId: "not-mine" })).toEqual([]);
  });

  it("prefers seriesKey over parentTitle when both are given", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Other", seriesKey: "tvdb:1", seasonNumber: 3, episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seriesKey: "tvdb:2", seasonNumber: 1, episodeNumber: 1,
    });
    const seasons = await getSeasons({ parentTitle: "Show", seriesKey: "tvdb:1" });
    expect(seasons.map((s) => s.seasonNumber)).toEqual([3]);
  });
});

describe("GET /api/media/series/seasons ordering", () => {
  it("takes the season's fields from its lowest-numbered episode however the rows are stored", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    // Created out of episode order, then rewritten so the heap order differs again.
    const e3 = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E3", parentTitle: "Show", seasonNumber: 1, episodeNumber: 3, summary: "Third",
    });
    const e1 = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, summary: "First",
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", title: "E2", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2, summary: "Second",
    });
    await prisma.mediaItem.update({ where: { id: e1.id }, data: { year: 2001, rating: 8 } });
    await prisma.mediaItem.update({ where: { id: e3.id }, data: { year: 2003, rating: 3 } });

    for (let i = 0; i < 3; i++) {
      const [season] = await getSeasons({ parentTitle: "Show" });
      expect(season.summary).toBe("First");
      expect(season.year).toBe(2001);
      expect(season.rating).toBe(8);
    }
  });
});
