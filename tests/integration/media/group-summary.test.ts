import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
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

import { GET } from "@/app/api/media/[id]/group-summary/route";
import { appCache } from "@/lib/cache/memory-cache";

type SeriesSummary = {
  title: string;
  year: number | null;
  summary: string | null;
  contentRating: string | null;
  studio: string | null;
  genres: string[] | null;
  playCount: number;
  fileSize: string;
  lastPlayedAt: string | null;
  addedAt: string | null;
  servers: Array<{ serverId: string }>;
  seasonCount: number;
  episodeCount: number;
  qualityCounts: Record<string, number>;
};

type MusicSummary = Omit<SeriesSummary, "seasonCount" | "episodeCount" | "qualityCounts"> & {
  albumCount: number;
  trackCount: number;
  audioCodecCounts: Record<string, number>;
};

function call(id: string, type?: string) {
  return callRouteWithParams(GET, { id }, {
    url: `/api/media/${id}/group-summary`,
    searchParams: type ? { type } : undefined,
  });
}

describe("GET /api/media/[id]/group-summary", () => {
  let userId: string;
  let serverId: string;

  beforeEach(async () => {
    await cleanDatabase();
    appCache.clear();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    serverId = (await createTestServer(userId)).id;
    setMockSession({ userId, isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    await expectJson(await call("x", "SERIES"), 401);
  });

  it.each([[undefined], ["MOVIE"], ["series"]])("returns 400 for type=%s", async (type) => {
    const body = await expectJson<{ error: string }>(await call("x", type), 400);
    expect(body.error).toMatch(/SERIES or MUSIC/);
  });

  it("returns 404 for an unknown id", async () => {
    await expectJson(await call("missing", "SERIES"), 404);
  });

  it("returns 404 when the type does not match the item", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Show" });
    await expectJson(await call(ep.id, "MUSIC"), 404);
  });

  it("returns 404 for an item with no parent title", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", title: "Orphan", parentTitle: null, seriesKey: null });
    await expectJson(await call(ep.id, "SERIES"), 404);
  });

  it("returns 404 for another user's item", async () => {
    const other = await createTestUser();
    const otherServer = await createTestServer(other.id);
    const lib = await createTestLibrary(otherServer.id, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Show" });
    await expectJson(await call(ep.id, "SERIES"), 404);
  });

  it("aggregates every episode of a series", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const e1 = await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "E1", seasonNumber: 1, episodeNumber: 1,
      resolution: "1080", fileSize: BigInt(100), playCount: 2,
      lastPlayedAt: new Date("2024-01-01T00:00:00Z"), addedAt: new Date("2023-01-01T00:00:00Z"),
      contentRating: "TV-14", genres: ["Drama"], year: 2010,
    });
    const e2 = await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "E2", seasonNumber: 1, episodeNumber: 2,
      resolution: "1080", fileSize: BigInt(200), playCount: 1,
      lastPlayedAt: new Date("2024-06-01T00:00:00Z"), addedAt: new Date("2023-02-01T00:00:00Z"),
      studio: "HBO",
    });
    const e3 = await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "E3", seasonNumber: 2, episodeNumber: 1,
      resolution: "4k", fileSize: BigInt(300), playCount: 0, addedAt: new Date("2023-03-01T00:00:00Z"),
    });
    // Only E1 carries a year, so the first non-null year is E1's whatever
    // order the episodes are read in.
    await getTestPrisma().mediaItem.updateMany({ where: { id: { in: [e2.id, e3.id] } }, data: { year: null } });
    // A different show must not leak in.
    await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Other", title: "X", fileSize: BigInt(999) });

    const body = await expectJson<SeriesSummary>(await call(e1.id, "SERIES"), 200);
    expect(body.title).toBe("Show");
    expect(body.episodeCount).toBe(3);
    expect(body.seasonCount).toBe(2);
    expect(body.fileSize).toBe("600");
    expect(body.playCount).toBe(3);
    expect(body.lastPlayedAt).toBe("2024-06-01T00:00:00.000Z");
    expect(body.addedAt).toBe("2023-03-01T00:00:00.000Z");
    expect(body.contentRating).toBe("TV-14");
    expect(body.studio).toBe("HBO");
    expect(body.genres).toEqual(["Drama"]);
    expect(body.year).toBe(2010);
    expect(body.qualityCounts).toEqual({ "1080P": 2, "4K": 1 });
    expect(body.servers.map((s) => s.serverId)).toEqual([serverId]);
  });

  // The fold keeps the FIRST row carrying each descriptive field, and the
  // rows were read with no ORDER BY — heap order, i.e. here insertion order —
  // so the summary showed whichever episode was stored first. Now: episode
  // order (season, episode, id), as the series listing picks them.
  it("takes descriptive fields from the first episode in episode order, not storage order", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const later = await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "S2E1", seasonNumber: 2, episodeNumber: 1,
      year: 2012, contentRating: "TV-MA", studio: "Late Studio", summary: "season two blurb", genres: ["Late"],
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "S1E2", seasonNumber: 1, episodeNumber: 2,
      year: 2011, contentRating: "TV-PG", studio: "Mid Studio", summary: "episode two blurb", genres: ["Mid"],
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "S1E1", seasonNumber: 1, episodeNumber: 1,
      year: 2010, contentRating: "TV-14", studio: "First Studio", summary: "pilot blurb", genres: ["First"],
    });

    const body = await expectJson<SeriesSummary>(await call(later.id, "SERIES"), 200);
    expect(body).toMatchObject({
      year: 2010, contentRating: "TV-14", studio: "First Studio", summary: "pilot blurb", genres: ["First"],
    });
  });

  it("takes an artist's descriptive fields from the first track in album and track order", async () => {
    const lib = await createTestLibrary(serverId, { type: "MUSIC" });
    const later = await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Artist", albumTitle: "B Album", title: "B1", seasonNumber: 1, episodeNumber: 1,
      year: 2005, studio: "Later Label",
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Artist", albumTitle: "A Album", title: "A2", seasonNumber: 1, episodeNumber: 2,
      year: 2001, studio: "Second Label",
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Artist", albumTitle: "A Album", title: "A1", seasonNumber: 1, episodeNumber: 1,
      year: 2000, studio: "First Label",
    });

    const body = await expectJson<MusicSummary>(await call(later.id, "MUSIC"), 200);
    expect(body).toMatchObject({ year: 2000, studio: "First Label" });
  });

  it("keeps two same-titled shows apart by seriesKey", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const uk = await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:1", title: "UK1", fileSize: BigInt(10),
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:2", title: "US1", fileSize: BigInt(20),
    });
    await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "The Office", seriesKey: "tvdb:2", title: "US2", fileSize: BigInt(20),
    });

    const body = await expectJson<SeriesSummary>(await call(uk.id, "SERIES"), 200);
    expect(body.title).toBe("The Office");
    expect(body.episodeCount).toBe(1);
    expect(body.fileSize).toBe("10");
  });

  it("prefers the parent-level summary", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, {
      type: "SERIES", parentTitle: "Show", title: "E1", summary: "episode blurb",
    });
    await getTestPrisma().mediaItem.update({ where: { id: ep.id }, data: { parentSummary: "show blurb" } });
    const body = await expectJson<SeriesSummary>(await call(ep.id, "SERIES"), 200);
    expect(body.summary).toBe("show blurb");
  });

  it("counts only canonical copies when several servers are connected", async () => {
    const server2 = await createTestServer(userId, { name: "Second" });
    const lib1 = await createTestLibrary(serverId, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    const a = await createTestMediaItem(lib1.id, {
      type: "SERIES", parentTitle: "Show", seriesKey: "tvdb:9", title: "E1", fileSize: BigInt(100),
    });
    const b = await createTestMediaItem(lib2.id, {
      type: "SERIES", parentTitle: "Show", seriesKey: "tvdb:9", title: "E1", fileSize: BigInt(100),
    });
    await prisma.mediaItem.update({ where: { id: a.id }, data: { dedupKey: "series:tvdb:9:s0e0", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: b.id }, data: { dedupKey: "series:tvdb:9:s0e0", dedupCanonical: false } });

    const body = await expectJson<SeriesSummary>(await call(a.id, "SERIES"), 200);
    expect(body.episodeCount).toBe(1);
    expect(body.fileSize).toBe("100");
    expect(body.servers.map((s) => s.serverId).sort()).toEqual([serverId, server2.id].sort());
  });

  it("aggregates an artist's tracks, albums and codecs", async () => {
    const lib = await createTestLibrary(serverId, { type: "MUSIC" });
    const t1 = await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Artist", albumTitle: "A1", title: "T1", audioCodec: "flac", fileSize: BigInt(5),
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Artist", albumTitle: "A1", title: "T2", audioCodec: "FLAC", fileSize: BigInt(5),
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Artist", albumTitle: "A2", title: "T3", audioCodec: "mp3", fileSize: BigInt(5),
    });

    const body = await expectJson<MusicSummary>(await call(t1.id, "MUSIC"), 200);
    expect(body.title).toBe("Artist");
    expect(body.trackCount).toBe(3);
    expect(body.albumCount).toBe(2);
    expect(body.audioCodecCounts).toEqual({ FLAC: 2, MP3: 1 });
    expect(body.fileSize).toBe("15");
    expect(body).not.toHaveProperty("episodeCount");
  });

  it("sums an artist across spellings that differ only in case and surrounding spaces", async () => {
    // The artist list groups by LOWER(TRIM(parentTitle)), so "Air" and "air "
    // are one artist there; the summary it opens must count both spellings.
    const lib = await createTestLibrary(serverId, { type: "MUSIC" });
    const t1 = await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Air", albumTitle: "Moon Safari", title: "La Femme d'Argent", fileSize: BigInt(7),
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "air ", albumTitle: "Talkie Walkie", title: "Venus", fileSize: BigInt(3),
    });
    await createTestMediaItem(lib.id, {
      type: "MUSIC", parentTitle: "Airiel", albumTitle: "Winks", title: "Sugar Cloud", fileSize: BigInt(100),
    });

    const body = await expectJson<MusicSummary>(await call(t1.id, "MUSIC"), 200);
    expect(body.trackCount).toBe(2);
    expect(body.albumCount).toBe(2);
    expect(body.fileSize).toBe("10");
  });

  it("serves a repeat request from cache", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const e1 = await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", title: "E1" });
    const first = await expectJson<SeriesSummary>(await call(e1.id, "SERIES"), 200);
    expect(first.episodeCount).toBe(1);
    await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: "Show", title: "E2" });
    const second = await expectJson<SeriesSummary>(await call(e1.id, "SERIES"), 200);
    expect(second.episodeCount).toBe(1);

    appCache.clear();
    const third = await expectJson<SeriesSummary>(await call(e1.id, "SERIES"), 200);
    expect(third.episodeCount).toBe(2);
  });
});
