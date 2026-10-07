import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { HISTORY_COLUMN_SORT_KEY } from "@/lib/media/history-sort";

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

import { GET } from "@/app/api/media/history/route";

type Row = {
  serverUsername: string;
  mediaItem: {
    type: string;
    title: string;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    dynamicRange: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
  };
  server: { name: string };
};

describe("GET /api/media/history — sorting", () => {
  let userId: string;
  // Plays are stamped in creation order, one minute apart, so a sort that
  // silently fell back to Watched At (the old behaviour for HDR/codecs) gives
  // a visibly different order from the one asserted.
  let clock: number;

  async function play(mediaItemId: string, mediaServerId: string, serverUsername = "alice") {
    clock += 60_000;
    await getTestPrisma().watchHistory.create({
      data: { mediaItemId, mediaServerId, serverUsername, watchedAt: new Date(clock) },
    });
  }

  async function list(sortBy: string, sortOrder: "asc" | "desc" = "asc") {
    const body = await expectJson<{ items: Row[] }>(
      await callRoute(GET, { url: "/api/media/history", searchParams: { sortBy, sortOrder } }),
      200,
    );
    return body.items;
  }

  /** The Title column's text, as the page renders it (`getItemTitle`). */
  function displayed(r: Row): string {
    const mi = r.mediaItem;
    if (mi.type === "SERIES" && mi.parentTitle) {
      const code = `S${String(mi.seasonNumber).padStart(2, "0")}E${String(mi.episodeNumber).padStart(2, "0")}`;
      return `${mi.parentTitle} - ${code} - ${mi.title}`;
    }
    return mi.type === "MUSIC" && mi.parentTitle ? `${mi.parentTitle} - ${mi.title}` : mi.title;
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    clock = Date.parse("2024-01-01T00:00:00Z");
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("sorts Title by the displayed text: show, season, episode, then title", async () => {
    const server = await createTestServer(userId);
    const tv = await createTestLibrary(server.id, { type: "SERIES" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const prisma = getTestPrisma();

    // Each row's `titleSort` is its OWN sort title, as the sync stores it —
    // which is what the old ORDER BY used, scattering a show's episodes by
    // episode name and a film by its article-stripped title.
    const seed: Array<[string, Parameters<typeof createTestMediaItem>[1], string]> = [
      [tv.id, { type: "SERIES", parentTitle: "Zeta Show", title: "Aardvark", seasonNumber: 1, episodeNumber: 2 }, "Aardvark"],
      [tv.id, { type: "SERIES", parentTitle: "Alpha Show", title: "Zulu", seasonNumber: 2, episodeNumber: 1 }, "Zulu"],
      [tv.id, { type: "SERIES", parentTitle: "Alpha Show", title: "Middle", seasonNumber: 1, episodeNumber: 10 }, "Middle"],
      [tv.id, { type: "SERIES", parentTitle: "Alpha Show", title: "Yankee", seasonNumber: 1, episodeNumber: 2 }, "Yankee"],
      // Tracks carry disc/track numbers in season/episode; the display shows
      // neither, so they must not decide the order.
      [music.id, { type: "MUSIC", parentTitle: "Beta Artist", title: "Zebra", seasonNumber: 1, episodeNumber: 1 }, "Zebra"],
      [music.id, { type: "MUSIC", parentTitle: "Beta Artist", title: "Aardvark Song", seasonNumber: 1, episodeNumber: 9 }, "Aardvark Song"],
      [movies.id, { type: "MOVIE", title: "Charlie Movie" }, "Aaa sorts first by titleSort"],
    ];
    for (const [libraryId, overrides, titleSort] of seed) {
      const item = await createTestMediaItem(libraryId, overrides);
      await prisma.mediaItem.update({ where: { id: item.id }, data: { titleSort } });
      await play(item.id, server.id);
    }

    const expected = [
      "Alpha Show - S01E02 - Yankee",
      "Alpha Show - S01E10 - Middle",
      "Alpha Show - S02E01 - Zulu",
      "Beta Artist - Aardvark Song",
      "Beta Artist - Zebra",
      "Charlie Movie",
      "Zeta Show - S01E02 - Aardvark",
    ];

    expect((await list("title", "asc")).map(displayed)).toEqual(expected);
    expect((await list("title", "desc")).map(displayed)).toEqual([...expected].reverse());
  });

  it("sorts the Server column by server name, not by username", async () => {
    const attic = await createTestServer(userId, { name: "Attic" });
    const basement = await createTestServer(userId, { name: "Basement" });
    const atticLib = await createTestLibrary(attic.id);
    const basementLib = await createTestLibrary(basement.id);
    // Username order is the opposite of server-name order.
    await play((await createTestMediaItem(basementLib.id, { title: "B1" })).id, basement.id, "amy");
    await play((await createTestMediaItem(atticLib.id, { title: "A1" })).id, attic.id, "zed");

    const byServer = await list(HISTORY_COLUMN_SORT_KEY.server, "asc");
    expect(byServer.map((r) => r.server.name)).toEqual(["Attic", "Basement"]);
    const byServerDesc = await list(HISTORY_COLUMN_SORT_KEY.server, "desc");
    expect(byServerDesc.map((r) => r.server.name)).toEqual(["Basement", "Attic"]);

    const byUser = await list(HISTORY_COLUMN_SORT_KEY.serverUsername, "asc");
    expect(byUser.map((r) => r.serverUsername)).toEqual(["amy", "zed"]);
  });

  it("sorts by dynamic range, video codec and audio codec + channels", async () => {
    const server = await createTestServer(userId);
    const lib = await createTestLibrary(server.id);
    const prisma = getTestPrisma();
    const specs: Array<{ title: string; dynamicRange: string | null; videoCodec: string; audioCodec: string; audioChannels: number }> = [
      { title: "one", dynamicRange: "SDR", videoCodec: "hevc", audioCodec: "eac3", audioChannels: 6 },
      { title: "two", dynamicRange: null, videoCodec: "av1", audioCodec: "aac", audioChannels: 6 },
      { title: "three", dynamicRange: "HDR10", videoCodec: "h264", audioCodec: "aac", audioChannels: 2 },
      { title: "four", dynamicRange: "Dolby Vision", videoCodec: "mpeg2", audioCodec: "truehd", audioChannels: 8 },
    ];
    for (const spec of specs) {
      const item = await createTestMediaItem(lib.id, {
        title: spec.title,
        videoCodec: spec.videoCodec,
        audioCodec: spec.audioCodec,
      });
      await prisma.mediaItem.update({
        where: { id: item.id },
        data: { dynamicRange: spec.dynamicRange, audioChannels: spec.audioChannels },
      });
      await play(item.id, server.id);
    }

    const titles = (rows: Row[]) => rows.map((r) => r.mediaItem.title);
    expect(titles(await list(HISTORY_COLUMN_SORT_KEY.dynamicRange, "asc"))).toEqual(["four", "three", "one", "two"]);
    // NULLS LAST in both directions.
    expect(titles(await list(HISTORY_COLUMN_SORT_KEY.dynamicRange, "desc"))).toEqual(["one", "three", "four", "two"]);
    expect(titles(await list(HISTORY_COLUMN_SORT_KEY.videoCodec, "asc"))).toEqual(["two", "three", "one", "four"]);
    expect(titles(await list(HISTORY_COLUMN_SORT_KEY.audioCodec, "asc"))).toEqual(["three", "two", "one", "four"]);
    expect(titles(await list(HISTORY_COLUMN_SORT_KEY.audioCodec, "desc"))).toEqual(["four", "one", "two", "three"]);
  });

  // The Resolution columns show the normalized label, so their sort follows
  // the label's rank. Sorting the raw text ordered "1080, 2160, 480, 4k, 720,
  // sd" and split "2160" and "4k" — both shown as 4K — to opposite ends.
  const RAW_RESOLUTIONS: Array<[string, string | null]> = [
    ["r720", "720"],
    ["rNull", null],
    ["r4k", "4k"],
    ["r1080", "1080"],
    ["rSd", "sd"],
    ["r2160", "2160"],
    ["r480", "480"],
    ["rOdd", "weird"],
  ];
  const LABEL_RANK: Record<string, number> = { SD: 1, "480P": 2, "720P": 3, "1080P": 4, "4K": 5 };
  const RAW_LABEL: Record<string, string> = { sd: "SD", "480": "480P", "720": "720P", "1080": "1080P", "2160": "4K", "4k": "4K" };

  /** Each row's resolution label rank, or null for an unknown/absent value. */
  function ranks(raws: Array<string | null>): Array<number | null> {
    return raws.map((raw) => (raw != null && RAW_LABEL[raw] ? LABEL_RANK[RAW_LABEL[raw]] : null));
  }

  it("sorts the file Resolution column by the displayed label, lowest first", async () => {
    const server = await createTestServer(userId);
    const lib = await createTestLibrary(server.id);
    const prisma = getTestPrisma();
    for (const [title, resolution] of RAW_RESOLUTIONS) {
      const item = await createTestMediaItem(lib.id, { title });
      await prisma.mediaItem.update({ where: { id: item.id }, data: { resolution } });
      await play(item.id, server.id);
    }

    const resolutionsOf = (rows: Row[]) => rows.map((r) => (r as unknown as { mediaItem: { resolution: string | null } }).mediaItem.resolution);
    const asc = resolutionsOf(await list(HISTORY_COLUMN_SORT_KEY.resolution, "asc"));
    const desc = resolutionsOf(await list(HISTORY_COLUMN_SORT_KEY.resolution, "desc"));

    // Lowest to highest, the two 4K spellings adjacent; unknown values last.
    expect(ranks(asc)).toEqual([1, 2, 3, 4, 5, 5, null, null]);
    expect(asc.slice(4, 6).sort()).toEqual(["2160", "4k"]);
    // An unrecognised value (shown raw) before an absent one (shown "-").
    expect(asc.slice(6)).toEqual(["weird", null]);

    // Highest to lowest; unknowns stay last in this direction too.
    expect(ranks(desc)).toEqual([5, 5, 4, 3, 2, 1, null, null]);
    expect(desc.slice(0, 2).sort()).toEqual(["2160", "4k"]);
    expect(desc.slice(6)).toEqual(["weird", null]);
  });

  it("sorts the Stream Resolution column by the delivered stream's label, not the file's", async () => {
    const server = await createTestServer(userId);
    const lib = await createTestLibrary(server.id);
    const prisma = getTestPrisma();
    // Every file is 4K, so a sort that read the file's column would leave the
    // plays in an arbitrary (id) order rather than the stream order asserted.
    for (const [title, resolution] of RAW_RESOLUTIONS) {
      const item = await createTestMediaItem(lib.id, { title, resolution: "4k" });
      clock += 60_000;
      await prisma.watchHistory.create({
        data: {
          mediaItemId: item.id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date(clock),
          source: "TRACEARR",
          sourceEventId: `evt-${title}`,
          resolution,
        },
      });
    }

    const streamOf = (rows: Row[]) => rows.map((r) => (r as unknown as { resolution: string | null }).resolution);
    const asc = streamOf(await list(HISTORY_COLUMN_SORT_KEY.streamResolution, "asc"));
    const desc = streamOf(await list(HISTORY_COLUMN_SORT_KEY.streamResolution, "desc"));
    expect(ranks(asc)).toEqual([1, 2, 3, 4, 5, 5, null, null]);
    expect(asc.slice(6)).toEqual(["weird", null]);
    expect(ranks(desc)).toEqual([5, 5, 4, 3, 2, 1, null, null]);
  });

  it("sorts Type by the label shown (Movie, Music, Series), not the enum order", async () => {
    const server = await createTestServer(userId);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const tv = await createTestLibrary(server.id, { type: "SERIES" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });
    // Played in enum declaration order, so a fallback to either the enum
    // order or Watched At would pass for MOVIE/SERIES/MUSIC — not for this.
    await play((await createTestMediaItem(movies.id, { type: "MOVIE", title: "m" })).id, server.id);
    await play((await createTestMediaItem(tv.id, { type: "SERIES", title: "s", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 })).id, server.id);
    await play((await createTestMediaItem(music.id, { type: "MUSIC", title: "t", parentTitle: "Artist" })).id, server.id);

    const types = (rows: Row[]) => rows.map((r) => r.mediaItem.type);
    expect(types(await list(HISTORY_COLUMN_SORT_KEY.type, "asc"))).toEqual(["MOVIE", "MUSIC", "SERIES"]);
    expect(types(await list(HISTORY_COLUMN_SORT_KEY.type, "desc"))).toEqual(["SERIES", "MUSIC", "MOVIE"]);
  });
});
