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

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/recently-added/route";

describe("GET /api/media/recently-added", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns empty items when user has no servers", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: unknown[];
      total: number;
    }>(response, 200);

    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns recently added items ordered by addedAt desc", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    const old = new Date("2024-01-01");
    const mid = new Date("2024-06-15");
    const recent = new Date("2024-12-25");

    await createTestMediaItem(lib.id, {
      title: "Old Movie",
      type: "MOVIE",
      addedAt: old,
    });
    await createTestMediaItem(lib.id, {
      title: "Mid Movie",
      type: "MOVIE",
      addedAt: mid,
    });
    await createTestMediaItem(lib.id, {
      title: "Recent Movie",
      type: "MOVIE",
      addedAt: recent,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: { title: string; addedAt: string }[];
      total: number;
    }>(response, 200);

    expect(body.items[0].title).toBe("Recent Movie");
    expect(body.items[1].title).toBe("Mid Movie");
    expect(body.items[2].title).toBe("Old Movie");
    expect(body.total).toBe(3);
  });

  it("respects the limit parameter", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    for (let i = 1; i <= 5; i++) {
      await createTestMediaItem(lib.id, {
        title: `Movie ${i}`,
        type: "MOVIE",
        addedAt: new Date(`2024-0${i}-01`),
        ratingKey: `rk-ra-${i}`,
      });
    }

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { limit: "2" },
    });
    const body = await expectJson<{
      items: { title: string }[];
      total: number;
    }>(response, 200);

    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("caps limit at 50", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    await createTestMediaItem(lib.id, {
      title: "Test",
      type: "MOVIE",
      addedAt: new Date(),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { limit: "999" },
    });
    // Should not fail; response limit capped at 50 internally
    expect(response.status).toBe(200);
  });

  it("filters by type when specified", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
    const seriesLib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(movieLib.id, {
      title: "Movie",
      type: "MOVIE",
      addedAt: new Date("2024-12-01"),
    });
    await createTestMediaItem(seriesLib.id, {
      title: "Episode",
      type: "SERIES",
      parentTitle: "Show",
      addedAt: new Date("2024-12-02"),
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { type: "MOVIE" },
    });
    const body = await expectJson<{
      items: { title: string; type: string }[];
      total: number;
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Movie");
    expect(body.total).toBe(1);
  });

  it("serializes addedAt as ISO string", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    const addedAt = new Date("2024-06-15T10:30:00.000Z");
    await createTestMediaItem(lib.id, {
      title: "Movie",
      type: "MOVIE",
      addedAt,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: { addedAt: string }[];
    }>(response, 200);

    expect(body.items[0].addedAt).toBe("2024-06-15T10:30:00.000Z");
    expect(typeof body.items[0].addedAt).toBe("string");
  });

  it("filters by serverId", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Server1" });
    const server2 = await createTestServer(user.id, { name: "Server2" });
    const lib1 = await createTestLibrary(server1.id);
    const lib2 = await createTestLibrary(server2.id);

    await createTestMediaItem(lib1.id, {
      title: "S1 Movie",
      type: "MOVIE",
      addedAt: new Date(),
    });
    await createTestMediaItem(lib2.id, {
      title: "S2 Movie",
      type: "MOVIE",
      addedAt: new Date(),
      ratingKey: "s2-m",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { serverId: server1.id },
    });
    const body = await expectJson<{
      items: { title: string }[];
      total: number;
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("S1 Movie");
  });

  it("returns 404 when serverId does not belong to user", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server = await createTestServer(user1.id);

    setMockSession({ userId: user2.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
      searchParams: { serverId: server.id },
    });
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Server not found");
  });

  it("does not return items from other users' servers", async () => {
    const user1 = await createTestUser({ plexId: "u1" });
    const user2 = await createTestUser({ plexId: "u2" });
    const server1 = await createTestServer(user1.id);
    const server2 = await createTestServer(user2.id);
    const lib1 = await createTestLibrary(server1.id);
    const lib2 = await createTestLibrary(server2.id);

    await createTestMediaItem(lib1.id, {
      title: "User1 Movie",
      type: "MOVIE",
      addedAt: new Date(),
    });
    await createTestMediaItem(lib2.id, {
      title: "User2 Movie",
      type: "MOVIE",
      addedAt: new Date(),
      ratingKey: "u2-m",
    });

    setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/media/recently-added",
    });
    const body = await expectJson<{
      items: { title: string }[];
    }>(response, 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("User1 Movie");
  });
  it("collapses a season's episodes into one entry", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    // A season pack: one addition, five rows. Un-collapsed this floods the
    // shelf with five identical posters.
    for (let i = 1; i <= 5; i++) {
      await createTestMediaItem(lib.id, {
        title: `Episode ${i}`,
        type: "SERIES",
        parentTitle: "Long Runner",
        seriesKey: "tvdb:1234",
        seasonNumber: 27,
        episodeNumber: i,
        addedAt: new Date(Date.now() - i * 1000),
        ratingKey: `bb-s27-e${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{
      items: { memberCount: number; parentTitle: string; seasonNumber: number }[];
      total: number;
    }>(await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].memberCount).toBe(5);
    expect(body.items[0].parentTitle).toBe("Long Runner");
    expect(body.items[0].seasonNumber).toBe(27);
    // `total` counts collapsed entries, matching what the shelf displays.
    expect(body.total).toBe(1);
  });

  it("keeps two seasons of the same show separate", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    for (const season of [26, 27]) {
      for (let i = 1; i <= 2; i++) {
        await createTestMediaItem(lib.id, {
          title: `S${season}E${i}`,
          type: "SERIES",
          parentTitle: "Long Runner",
          seriesKey: "tvdb:1234",
          seasonNumber: season,
          episodeNumber: i,
          addedAt: new Date(),
          ratingKey: `bb-s${season}-e${i}`,
        });
      }
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { seasonNumber: number; memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.seasonNumber).sort()).toEqual([26, 27]);
    expect(body.items.every((i) => i.memberCount === 2)).toBe(true);
  });

  it("keeps same-titled different shows separate (seriesKey, not parentTitle)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    // The Office UK vs US: identical parentTitle and season, different shows.
    for (const [key, rk] of [["tvdb:1111", "uk"], ["tvdb:2222", "us"]] as const) {
      await createTestMediaItem(lib.id, {
        title: "Pilot",
        type: "SERIES",
        parentTitle: "The Office",
        seriesKey: key,
        seasonNumber: 1,
        episodeNumber: 1,
        addedAt: new Date(),
        ratingKey: `office-${rk}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: unknown[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(2);
  });

  it("collapses an album's tracks into one entry", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    // For MUSIC, parentTitle is the ARTIST and albumTitle the album.
    for (let i = 1; i <= 4; i++) {
      await createTestMediaItem(lib.id, {
        title: `Track ${i}`,
        type: "MUSIC",
        parentTitle: "The Band",
        albumTitle: "The Album",
        addedAt: new Date(),
        ratingKey: `ir-${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{
      items: { memberCount: number; parentTitle: string; albumTitle: string }[];
    }>(await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].memberCount).toBe(4);
    expect(body.items[0].parentTitle).toBe("The Band");
    expect(body.items[0].albumTitle).toBe("The Album");
  });

  it("never collapses movies, and reports memberCount 1 for them", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    for (let i = 1; i <= 3; i++) {
      await createTestMediaItem(lib.id, {
        title: `Movie ${i}`,
        type: "MOVIE",
        addedAt: new Date(),
        ratingKey: `mv-${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.memberCount === 1)).toBe(true);
  });

  it("does not collapse episodes that have no seriesKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    // A legacy row predating the seriesKey column has no grouping identity, and
    // guessing one from parentTitle is exactly what seriesKey exists to avoid.
    for (let i = 1; i <= 3; i++) {
      await createTestMediaItem(lib.id, {
        title: `Episode ${i}`,
        type: "SERIES",
        parentTitle: "Legacy Show",
        seriesKey: null,
        seasonNumber: 1,
        episodeNumber: i,
        addedAt: new Date(),
        ratingKey: `legacy-${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.memberCount === 1)).toBe(true);
  });

  it("limits by collapsed entries, not by rows", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    // Three seasons of 10 episodes: 30 rows, 3 entries. A row-based limit of 2
    // would have returned two episodes of one season and hidden the rest.
    for (const season of [1, 2, 3]) {
      for (let i = 1; i <= 10; i++) {
        await createTestMediaItem(lib.id, {
          title: `S${season}E${i}`,
          type: "SERIES",
          parentTitle: "Show",
          seriesKey: "tvdb:9",
          seasonNumber: season,
          episodeNumber: i,
          addedAt: new Date(Date.now() - season * 100000),
          ratingKey: `s${season}e${i}`,
        });
      }
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { memberCount: number }[]; total: number }>(
      await callRoute(GET, { url: "/api/media/recently-added?limit=2" }), 200);

    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.memberCount === 10)).toBe(true);
    expect(body.total).toBe(3);
  });
  it("does not collapse a season whose seasonNumber is null", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    // Would render "S00" and open the Specials page, which lists different
    // episodes than the tile represented.
    for (let i = 1; i <= 3; i++) {
      await createTestMediaItem(lib.id, {
        title: `Ep ${i}`, type: "SERIES", parentTitle: "Show",
        seriesKey: "tvdb:5", seasonNumber: null, episodeNumber: i,
        addedAt: new Date(), ratingKey: `noseason-${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const body = await expectJson<{ items: { memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);
    expect(body.items).toHaveLength(3);
  });

  it("does not collapse an album with no artist", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });
    // The album page refuses to query without an artist and would render empty.
    for (let i = 1; i <= 3; i++) {
      await createTestMediaItem(lib.id, {
        title: `Track ${i}`, type: "MUSIC", parentTitle: null,
        albumTitle: "Greatest Hits", addedAt: new Date(), ratingKey: `noartist-${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const body = await expectJson<{ items: { memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);
    expect(body.items).toHaveLength(3);
  });

  it("counts only the members added in the same batch, not the whole season", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    // 7 episodes added a month ago, 1 tonight. The tile must say 1, not 8 —
    // otherwise a weekly show relabels its whole season every single week.
    for (let i = 1; i <= 7; i++) {
      await createTestMediaItem(lib.id, {
        title: `Ep ${i}`, type: "SERIES", parentTitle: "Weekly",
        seriesKey: "tvdb:7", seasonNumber: 3, episodeNumber: i,
        addedAt: old, ratingKey: `wk-${i}`,
      });
    }
    await createTestMediaItem(lib.id, {
      title: "Ep 8", type: "SERIES", parentTitle: "Weekly",
      seriesKey: "tvdb:7", seasonNumber: 3, episodeNumber: 8,
      addedAt: new Date(), ratingKey: "wk-8",
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    const body = await expectJson<{ items: { memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].memberCount).toBe(1);
  });

  it("ignores an unrecognized type instead of erroring", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { title: "M", type: "MOVIE", addedAt: new Date(), ratingKey: "t1" });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    // `type` reaches raw SQL; an unvalidated value was both an injection vector
    // and a 500. Anything unrecognized is treated as "no type filter".
    for (const bad of ["BOGUS", "MOVIE'; DROP TABLE \"MediaItem\"; --", ""]) {
      const body = await expectJson<{ items: unknown[] }>(
        await callRoute(GET, { url: `/api/media/recently-added?type=${encodeURIComponent(bad)}` }), 200);
      expect(Array.isArray(body.items)).toBe(true);
    }
    // The table is still there.
    expect(await getTestPrisma().mediaItem.count()).toBe(1);
  });
  it("counts a season present on two servers once when dedup is on", async () => {
    const user = await createTestUser();
    const s1 = await createTestServer(user.id, { name: "A" });
    const s2 = await createTestServer(user.id, { name: "B" });
    const l1 = await createTestLibrary(s1.id, { type: "SERIES" });
    const l2 = await createTestLibrary(s2.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    for (const [lib, canonical, tag] of [[l1, true, "a"], [l2, false, "b"]] as const) {
      for (let i = 1; i <= 3; i++) {
        const row = await createTestMediaItem(lib.id, {
          title: `Ep ${i}`, type: "SERIES", parentTitle: "Dup Show",
          seriesKey: "tvdb:42", seasonNumber: 1, episodeNumber: i,
          addedAt: new Date(), ratingKey: `${tag}-${i}`,
        });
        await prisma.mediaItem.update({
          where: { id: row.id }, data: { dedupCanonical: canonical, dedupKey: `dk-${i}` },
        });
      }
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { memberCount: number }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    // Grouping merges the two servers' copies by seriesKey, so without the
    // dedupCanonical filter the same season would read "6 episodes".
    expect(body.items).toHaveLength(1);
    expect(body.items[0].memberCount).toBe(3);
  });

  it("keeps a stable total order when addedAt ties (different page sizes agree)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    // A bulk import stamps one addedAt across everything. Without a unique
    // tiebreaker Postgres may return tied rows in any order — and a bounded
    // query (top-N heapsort) plans differently from a larger one (quicksort),
    // so the tie block straddling the boundary permutes between them. A shelf
    // stitched from two such reads shows some additions twice and never shows
    // others. Same total-order rule the paginated list routes follow.
    const stamp = new Date();
    for (let i = 0; i < 200; i++) {
      await createTestMediaItem(lib.id, {
        title: `Movie ${i}`, type: "MOVIE", addedAt: stamp, ratingKey: `tie-${i}`,
      });
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const read = async (limit: number) =>
      (await expectJson<{ items: { groupKey: string }[] }>(
        await callRoute(GET, { url: `/api/media/recently-added?limit=${limit}` }), 200)
      ).items.map((i) => i.groupKey);

    const small = await read(5);
    const large = await read(50);
    expect(small).toEqual(large.slice(0, 5));
  });

  it("reports total as the number of collapsed entries", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    for (const season of [1, 2, 3, 4]) {
      for (let i = 1; i <= 5; i++) {
        await createTestMediaItem(lib.id, {
          title: `S${season}E${i}`, type: "SERIES", parentTitle: "Show",
          seriesKey: "tvdb:11", seasonNumber: season, episodeNumber: i,
          addedAt: new Date(), ratingKey: `tot-${season}-${i}`,
        });
      }
    }
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: unknown[]; total: number }>(
      await callRoute(GET, { url: "/api/media/recently-added?limit=2" }), 200);

    // 20 rows, 4 seasons: the header reads "2 of 4", not "2 of 20".
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(4);
  });
  it("picks a representative that actually has season artwork", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    // Three episodes of one season; only the middle one carries season art.
    // The tile requests `?type=season`, so the representative must be that row —
    // otherwise the shelf falls back to the series poster (or the episode still)
    // for a season that does have a poster available.
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      rows.push(await createTestMediaItem(lib.id, {
        title: `Ep ${i}`, type: "SERIES", parentTitle: "Art Show",
        seriesKey: "tvdb:99", seasonNumber: 2, episodeNumber: i,
        addedAt: new Date(), ratingKey: `art-${i}`,
      }));
    }
    await prisma.mediaItem.update({
      where: { id: rows[1].id },
      data: { seasonThumbUrl: "/season/poster.jpg" },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { id: string; seasonThumbUrl: string | null }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(rows[1].id);
    expect(body.items[0].seasonThumbUrl).toBe("/season/poster.jpg");
  });

  it("prefers season art over series art when choosing the representative", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    // `parentThumbUrl` is the SERIES poster (written from grandparentThumb) and
    // `seasonThumbUrl` the SEASON poster (from parentThumb). A row carrying only
    // the series poster must lose to one carrying the season poster.
    const seriesOnly = await createTestMediaItem(lib.id, {
      title: "Ep 1", type: "SERIES", parentTitle: "Show", seriesKey: "tvdb:100",
      seasonNumber: 1, episodeNumber: 1, addedAt: new Date(), ratingKey: "pref-1",
    });
    const seasonArt = await createTestMediaItem(lib.id, {
      title: "Ep 2", type: "SERIES", parentTitle: "Show", seriesKey: "tvdb:100",
      seasonNumber: 1, episodeNumber: 2, addedAt: new Date(), ratingKey: "pref-2",
    });
    await prisma.mediaItem.update({
      where: { id: seriesOnly.id }, data: { parentThumbUrl: "/series.jpg" },
    });
    await prisma.mediaItem.update({
      where: { id: seasonArt.id }, data: { seasonThumbUrl: "/season.jpg" },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ items: { id: string }[] }>(
      await callRoute(GET, { url: "/api/media/recently-added" }), 200);

    expect(body.items[0].id).toBe(seasonArt.id);
  });
});
