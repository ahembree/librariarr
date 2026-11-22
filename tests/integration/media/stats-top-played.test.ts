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

// Import AFTER mocks
import { GET } from "@/app/api/media/stats/top-played/route";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";

const prisma = getTestPrisma();
const BASE = "/api/media/stats/top-played";
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

interface Body {
  topMovies: { id: string; title: string; playCount: number }[];
  topSeries: { parentTitle: string; totalPlays: number; mediaItemId: string | null }[];
  topMusic: { parentTitle: string; totalPlays: number; mediaItemId: string | null }[];
}

async function plays(
  mediaItemId: string,
  mediaServerId: string,
  ages: number[],
  watched: boolean | null = null,
) {
  await prisma.watchHistory.createMany({
    data: ages.map((age) => ({ mediaItemId, mediaServerId, serverUsername: "u", watchedAt: daysAgo(age), watched })),
  });
}

describe("GET /api/media/stats/top-played", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    await expectJson(await callRoute(GET, { url: `${BASE}?range=week` }), 401);
  });

  it("rejects a missing or unknown range", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await expectJson(await callRoute(GET, { url: BASE }), 400);
    await expectJson(await callRoute(GET, { url: `${BASE}?range=decade` }), 400);
  });

  it("returns 404 for a server that is not the admin's", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await expectJson(await callRoute(GET, { url: `${BASE}?range=week&serverId=missing` }), 404);
  });

  it("answers empty lists when no server is enabled", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const body = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=year` }));
    expect(body).toEqual({ topMovies: [], topSeries: [], topMusic: [] });
  });

  it("ranks movies, series and artists by the completed plays inside the window", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const shows = await createTestLibrary(server.id, { type: "SERIES" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });

    const recent = await createTestMediaItem(movies.id, { title: "Recent", playCount: 2 });
    const old = await createTestMediaItem(movies.id, { title: "Old Favourite", playCount: 50 });
    await plays(recent.id, server.id, [1, 2]);
    await plays(recent.id, server.id, [3], false); // started, not finished: not a play
    await plays(old.id, server.id, [20, 40, 50, 200, 300]);

    const ep1 = await createTestMediaItem(shows.id, { type: "SERIES", title: "Pilot", parentTitle: "Show A", seasonNumber: 1, episodeNumber: 1 });
    const ep2 = await createTestMediaItem(shows.id, { type: "SERIES", title: "Two", parentTitle: "Show A", seasonNumber: 1, episodeNumber: 2 });
    const other = await createTestMediaItem(shows.id, { type: "SERIES", title: "Pilot", parentTitle: "Show B", seasonNumber: 1, episodeNumber: 1 });
    await plays(ep1.id, server.id, [1]);
    await plays(ep2.id, server.id, [2]);
    await plays(other.id, server.id, [60, 61, 62]);

    const track = await createTestMediaItem(music.id, { type: "MUSIC", title: "Song", parentTitle: "Artist", albumTitle: "LP" });
    await plays(track.id, server.id, [5, 6, 400]);

    const week = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=week` }));
    expect(week.topMovies.map((m) => [m.title, m.playCount])).toEqual([["Recent", 2]]);
    expect(week.topSeries.map((s) => [s.parentTitle, s.totalPlays])).toEqual([["Show A", 2]]);
    expect(week.topSeries[0].mediaItemId).not.toBeNull();
    expect(week.topMusic.map((a) => [a.parentTitle, a.totalPlays])).toEqual([["Artist", 2]]);

    const quarter = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=3months` }));
    expect(quarter.topMovies.map((m) => [m.title, m.playCount])).toEqual([["Old Favourite", 3], ["Recent", 2]]);
    expect(quarter.topSeries.map((s) => [s.parentTitle, s.totalPlays])).toEqual([["Show B", 3], ["Show A", 2]]);

    const year = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=year&serverId=${server.id}` }));
    expect(year.topMovies[0]).toMatchObject({ title: "Old Favourite", playCount: 5 });
    expect(year.topMusic[0].totalPlays).toBe(2);
  });

  it("with dedup on, adds up a film's plays on every server under its canonical copy", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const a = await createTestServer(user.id, { name: "A" });
    const b = await createTestServer(user.id, { name: "B" });
    const libA = await createTestLibrary(a.id, { type: "MOVIE" });
    const libB = await createTestLibrary(b.id, { type: "MOVIE" });
    const copyA = await createTestMediaItem(libA.id, { title: "Shared" });
    const copyB = await createTestMediaItem(libB.id, { title: "Shared" });
    await prisma.mediaItem.update({ where: { id: copyA.id }, data: { dedupKey: "k", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: copyB.id }, data: { dedupKey: "k", dedupCanonical: false } });
    await plays(copyA.id, a.id, [1]);
    await plays(copyB.id, b.id, [2, 3]);

    const body = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=week` }));
    expect(body.topMovies).toEqual([expect.objectContaining({ id: copyA.id, playCount: 3 })]);

    // One server: that server's copy and plays only.
    const onB = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=week&serverId=${b.id}` }));
    expect(onB.topMovies).toEqual([expect.objectContaining({ id: copyB.id, playCount: 2 })]);
  });

  it("is cached under stats: and dropped by invalidateMediaCaches", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(movies.id, { title: "M" });
    await plays(movie.id, server.id, [1]);

    const first = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=month` }));
    expect(first.topMovies[0].playCount).toBe(1);
    await plays(movie.id, server.id, [2]);
    const cached = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=month` }));
    expect(cached.topMovies[0].playCount).toBe(1);
    invalidateMediaCaches();
    const fresh = await expectJson<Body>(await callRoute(GET, { url: `${BASE}?range=month` }));
    expect(fresh.topMovies[0].playCount).toBe(2);
  });
});
