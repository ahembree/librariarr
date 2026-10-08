import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
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
import { HISTORY_COLUMN_SORT_KEY as KEY } from "@/lib/media/history-sort";
import { normalizeResolutionLabel } from "@/lib/resolution";

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
  id: string;
  serverUsername: string;
  resolution: string | null;
  server: { name: string };
  mediaItem: {
    id: string;
    type: string;
    title: string;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    resolution: string | null;
  };
};
type HistoryResponse = {
  items: Row[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
  usernames: string[];
};
type ItemInit = NonNullable<Parameters<typeof createTestMediaItem>[1]>;
type PlayData = Partial<Prisma.WatchHistoryUncheckedCreateInput>;

let userId: string;
let serverId: string;
let libs: Record<"MOVIE" | "SERIES" | "MUSIC", string>;
// Plays are a minute apart in creation order, so a sort that fell back to
// Watched At gives a visibly different order from the one asserted.
let clock: number;

async function list(searchParams: Record<string, string> = {}) {
  return expectJson<HistoryResponse>(await callRoute(GET, { url: "/api/media/history", searchParams }), 200);
}

async function sorted(sortBy: string, sortOrder: "asc" | "desc") {
  return (await list({ sortBy, sortOrder })).items;
}

/** Plays a new item once; `set` writes what the factory can't (nulls, titleSort, channels). */
async function played(
  { libraryId, ...item }: ItemInit & { libraryId?: string },
  set: Prisma.MediaItemUpdateInput = {},
  playData: PlayData = {},
) {
  const prisma = getTestPrisma();
  const { id } = await createTestMediaItem(libraryId ?? libs[item.type ?? "MOVIE"], item);
  await prisma.mediaItem.update({ where: { id }, data: set });
  clock += 60_000;
  await prisma.watchHistory.create({
    data: { mediaItemId: id, mediaServerId: serverId, serverUsername: "alice", watchedAt: new Date(clock), ...playData },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  clock = Date.parse("2024-01-01T00:00:00Z");
  userId = (await createTestUser()).id;
  setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
  serverId = (await createTestServer(userId, { name: "Attic" })).id;
  libs = {
    MOVIE: (await createTestLibrary(serverId, { type: "MOVIE" })).id,
    SERIES: (await createTestLibrary(serverId, { type: "SERIES" })).id,
    MUSIC: (await createTestLibrary(serverId, { type: "MUSIC" })).id,
  };
});

afterAll(async () => {
  await disconnectTestDb();
});

describe("GET /api/media/history — sorting", () => {
  /** The Title column's text, as the page renders it (`getItemTitle`). */
  function displayed({ mediaItem: mi }: Row): string {
    if (mi.type === "SERIES" && mi.parentTitle) {
      const code = `S${String(mi.seasonNumber).padStart(2, "0")}E${String(mi.episodeNumber).padStart(2, "0")}`;
      return `${mi.parentTitle} - ${code} - ${mi.title}`;
    }
    return mi.type === "MUSIC" && mi.parentTitle ? `${mi.parentTitle} - ${mi.title}` : mi.title;
  }

  it("sorts Title by the displayed text: show, season, episode, then title", async () => {
    // Each `titleSort` is the row's OWN sort title, as the sync stores it.
    const seed: Array<[ItemInit, string]> = [
      [{ type: "SERIES", parentTitle: "Zeta Show", title: "Aardvark", seasonNumber: 1, episodeNumber: 2 }, "Aardvark"],
      [{ type: "SERIES", parentTitle: "Alpha Show", title: "Zulu", seasonNumber: 2, episodeNumber: 1 }, "Zulu"],
      [{ type: "SERIES", parentTitle: "Alpha Show", title: "Middle", seasonNumber: 1, episodeNumber: 10 }, "Middle"],
      [{ type: "SERIES", parentTitle: "Alpha Show", title: "Yankee", seasonNumber: 1, episodeNumber: 2 }, "Yankee"],
      // Tracks keep disc/track numbers in season/episode, which the display does not show.
      [{ type: "MUSIC", parentTitle: "Beta Artist", title: "Zebra", seasonNumber: 1, episodeNumber: 1 }, "Zebra"],
      [{ type: "MUSIC", parentTitle: "Beta Artist", title: "Aardvark Song", seasonNumber: 1, episodeNumber: 9 }, "Aardvark Song"],
      [{ type: "MOVIE", title: "Charlie Movie" }, "Aaa sorts first by titleSort"],
    ];
    for (const [item, titleSort] of seed) await played(item, { titleSort });

    const expected = [
      "Alpha Show - S01E02 - Yankee",
      "Alpha Show - S01E10 - Middle",
      "Alpha Show - S02E01 - Zulu",
      "Beta Artist - Aardvark Song",
      "Beta Artist - Zebra",
      "Charlie Movie",
      "Zeta Show - S01E02 - Aardvark",
    ];
    expect((await sorted("title", "asc")).map(displayed)).toEqual(expected);
    expect((await sorted("title", "desc")).map(displayed)).toEqual([...expected].reverse());
  });

  it("sorts the Server column by server name, not by username", async () => {
    const basement = await createTestServer(userId, { name: "Basement" });
    const libraryId = (await createTestLibrary(basement.id)).id;
    // Username order is the opposite of server-name order.
    await played({ title: "B1", libraryId }, {}, { mediaServerId: basement.id, serverUsername: "amy" });
    await played({ title: "A1" }, {}, { serverUsername: "zed" });

    expect((await sorted(KEY.server, "asc")).map((r) => r.server.name)).toEqual(["Attic", "Basement"]);
    expect((await sorted(KEY.server, "desc")).map((r) => r.server.name)).toEqual(["Basement", "Attic"]);
    expect((await sorted(KEY.serverUsername, "asc")).map((r) => r.serverUsername)).toEqual(["amy", "zed"]);
  });

  it("sorts by dynamic range, video codec and audio codec + channels", async () => {
    const specs = [
      ["one", "SDR", "hevc", "eac3", 6],
      ["two", null, "av1", "aac", 6],
      ["three", "HDR10", "h264", "aac", 2],
      ["four", "Dolby Vision", "mpeg2", "truehd", 8],
    ] as const;
    for (const [title, dynamicRange, videoCodec, audioCodec, audioChannels] of specs) {
      await played({ title, videoCodec, audioCodec }, { dynamicRange, audioChannels });
    }

    const titles = async (sortBy: string, order: "asc" | "desc") =>
      (await sorted(sortBy, order)).map((r) => r.mediaItem.title);
    expect(await titles(KEY.dynamicRange, "asc")).toEqual(["four", "three", "one", "two"]);
    // NULLS LAST in both directions.
    expect(await titles(KEY.dynamicRange, "desc")).toEqual(["one", "three", "four", "two"]);
    expect(await titles(KEY.videoCodec, "asc")).toEqual(["two", "three", "one", "four"]);
    expect(await titles(KEY.audioCodec, "asc")).toEqual(["three", "two", "one", "four"]);
    expect(await titles(KEY.audioCodec, "desc")).toEqual(["four", "one", "two", "three"]);
  });

  // The Resolution columns show the normalized label, so they sort by its rank.
  const RAW_RESOLUTIONS = ["720", null, "4k", "1080", "sd", "2160", "480", "weird"];

  it.each([
    // Every file is 4K for the stream column, so reading the file's column fails.
    ["file", KEY.resolution, (r: Row) => r.mediaItem.resolution],
    ["stream", KEY.streamResolution, (r: Row) => r.resolution],
  ] as const)("sorts the %s Resolution column by the displayed label", async (_, sortBy, valueOf) => {
    for (const [i, resolution] of RAW_RESOLUTIONS.entries()) {
      if (sortBy === KEY.resolution) await played({ title: `r${i}` }, { resolution });
      else await played({ title: `r${i}`, resolution: "4k" }, {}, { source: "TRACEARR", sourceEventId: `evt-${i}`, resolution });
    }
    const asc = (await sorted(sortBy, "asc")).map(valueOf);
    const desc = (await sorted(sortBy, "desc")).map(valueOf);

    // Both 4K spellings together; an unknown value (shown raw) before an absent one, in both directions.
    expect(asc.map(normalizeResolutionLabel)).toEqual(["SD", "480P", "720P", "1080P", "4K", "4K", "Other", "Other"]);
    expect(asc.slice(6)).toEqual(["weird", null]);
    expect(desc.map(normalizeResolutionLabel)).toEqual(["4K", "4K", "1080P", "720P", "480P", "SD", "Other", "Other"]);
    expect(desc.slice(6)).toEqual(["weird", null]);
  });

  it("sorts Type by the label shown (Movie, Music, Series), not the enum order", async () => {
    // Played in enum order, so a fallback to the enum or to Watched At fails.
    await played({ type: "MOVIE", title: "m" });
    await played({ type: "SERIES", title: "s", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 });
    await played({ type: "MUSIC", title: "t", parentTitle: "Artist" });

    expect((await sorted(KEY.type, "asc")).map((r) => r.mediaItem.type)).toEqual(["MOVIE", "MUSIC", "SERIES"]);
    expect((await sorted(KEY.type, "desc")).map((r) => r.mediaItem.type)).toEqual(["SERIES", "MUSIC", "MOVIE"]);
  });
});

describe("GET /api/media/history — resolution filter", () => {
  /** The stored file resolutions the page shows under each label. */
  const SHOWN_AS: Record<string, Array<string | null>> = {
    "4K": ["4k", "4K", "2160", "2160p", "3840"],
    "1080P": ["1080", "1080p", "1024p", "1080i"],
    "720P": ["720", "720p", "872"],
    "480P": ["480", "576", "480p"],
    SD: ["sd", "360", "240"],
    Other: [null, "", "weird", "Weird"],
  };
  const titleOf = (r: string | null) => `res:${r === null ? "<null>" : r === "" ? "<empty>" : r}`;
  const titles = (...values: Array<string | null>) => values.map(titleOf).sort();

  async function filtered(resolution: string, extra: Record<string, string> = {}) {
    const body = await list({ resolution, ...extra });
    expect(body.pagination.totalCount, `resolution=${resolution}`).toBe(body.items.length);
    return body.items.map((r) => r.mediaItem.title).sort();
  }

  beforeEach(async () => {
    for (const resolution of Object.values(SHOWN_AS).flat()) {
      await played({ title: titleOf(resolution) }, { resolution });
    }
  });

  it("matches each label, in any case, against exactly the files the page shows under it", async () => {
    for (const [label, values] of Object.entries(SHOWN_AS)) {
      expect(values.map(normalizeResolutionLabel), label).toEqual(values.map(() => label));
      expect(await filtered(label), label).toEqual(titles(...values));
      expect(await filtered(label.toLowerCase()), label).toEqual(titles(...values));
    }
  });

  it("matches other values against the stored resolution and combines values with OR", async () => {
    const cases: Array<[string, Array<string | null>]> = [
      // Not a label: only the files stored with that value, ignoring case.
      ["weird", ["weird", "Weird"]],
      ["WEIRD", ["weird", "Weird"]],
      ["2160", ["2160"]],
      ["2160P", ["2160p"]],
      ["1024P", ["1024p"]],
      ["nothing-stored-like-this", []],
      ["1080P|weird", [...SHOWN_AS["1080P"], "weird", "Weird"]],
      ["SD|2160", [...SHOWN_AS.SD, "2160"]],
      ["4K|1080P", [...SHOWN_AS["4K"], ...SHOWN_AS["1080P"]]],
      // A stored value inside a label it also names is listed once; empty segments are ignored.
      ["4K|2160", SHOWN_AS["4K"]],
      ["|SD||", SHOWN_AS.SD],
    ];
    for (const [value, expected] of cases) expect(await filtered(value), value).toEqual(titles(...expected));
  });

  it("still combines with the other filters by AND", async () => {
    await played(
      { type: "SERIES", title: "res:episode-1024p", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, resolution: "1024p" },
      {},
      { serverUsername: "bob" },
    );
    expect(await filtered("1080P", { type: "SERIES" })).toEqual(["res:episode-1024p"]);
    expect(await filtered("1080P", { username: "bob" })).toEqual(["res:episode-1024p"]);
    expect(await filtered("1080P|Other", { type: "MOVIE" })).toEqual(titles(...SHOWN_AS["1080P"], ...SHOWN_AS.Other));
    expect(await filtered("720P", { type: "SERIES" })).toEqual([]);
  });
});

/**
 * A Jellyfin/Emby play filed against two library copies of one item is stored
 * once per copy (every row but the primary's sets `fanOutOfItemId`). The History
 * page lists plays, so it must show it once, in the rows and in `totalCount`.
 */
describe("GET /api/media/history — fan-out copies", () => {
  let jellyfinId: string;
  let plexId: string;
  // Two Jellyfin movie libraries over one folder, plus a TV library.
  let moviesA: string;
  let moviesB: string;
  let tv: string;
  let plexMovies: string;
  const playIds = new Map<string, string>();
  const at = (day: number) => new Date(`2024-06-0${day}T20:00:00Z`);
  const ids = (...names: string[]) => names.map((n) => playIds.get(n));

  async function play(name: string, mediaItemId: string, data: PlayData = {}) {
    const row = await getTestPrisma().watchHistory.create({
      data: { mediaItemId, mediaServerId: jellyfinId, serverUsername: "alice", watchedAt: at(1), ...data },
    });
    playIds.set(name, row.id);
    return row;
  }

  function expectNoCopies(body: HistoryResponse) {
    const copies = [...playIds].filter(([name]) => name.startsWith("copy")).map(([, id]) => id);
    expect(copies.length).toBeGreaterThan(0);
    for (const id of copies) expect(body.items.map((r) => r.id)).not.toContain(id);
  }

  beforeEach(async () => {
    playIds.clear();
    jellyfinId = (await createTestServer(userId, { name: "Jelly", type: "JELLYFIN" })).id;
    plexId = (await createTestServer(userId, { name: "Plexy", type: "PLEX" })).id;
    moviesA = (await createTestLibrary(jellyfinId, { type: "MOVIE", title: "Movies" })).id;
    moviesB = (await createTestLibrary(jellyfinId, { type: "MOVIE", title: "Movies (kids)" })).id;
    tv = (await createTestLibrary(jellyfinId, { type: "SERIES", title: "TV" })).id;
    plexMovies = (await createTestLibrary(plexId, { type: "MOVIE" })).id;
  });

  /** "Arrival" played once on both copies, plus plays without copies on both servers. */
  async function seedArrival() {
    const file = { title: "Arrival", ratingKey: "rk-arrival", resolution: "4k", videoCodec: "hevc", audioCodec: "eac3", dynamicRange: "HDR10" };
    const primary = await createTestMediaItem(moviesA, file);
    const copy = await createTestMediaItem(moviesB, file);
    const shield = { deviceName: "Shield", platform: "Android" };
    await play("arrival", primary.id, { ...shield, watchedAt: at(3) });
    await play("copy-arrival", copy.id, { ...shield, watchedAt: at(3), fanOutOfItemId: primary.id });
    const sicario = await createTestMediaItem(moviesA, { title: "Sicario", resolution: "1080" });
    await play("sicario", sicario.id, { serverUsername: "bob", watchedAt: at(2), deviceName: "iPad", platform: "iOS" });
    const pilot = await createTestMediaItem(tv, {
      type: "SERIES", title: "Pilot", parentTitle: "Severance", seasonNumber: 1, episodeNumber: 1, resolution: "720",
    });
    await play("pilot", pilot.id, { ...shield, watchedAt: at(1) });
    const dune = await createTestMediaItem(plexMovies, { title: "Dune", resolution: "4k", videoCodec: "hevc" });
    await play("dune", dune.id, {
      mediaServerId: plexId, serverUsername: "carol", watchedAt: at(4), deviceName: "Apple TV", platform: "tvOS",
    });
    return { primary, copy };
  }

  it("counts an empty history as zero on both count paths", async () => {
    const empty = await list();
    expect(empty.items).toEqual([]);
    expect(empty.pagination).toMatchObject({ totalCount: 0, hasMore: false });
    expect((await list({ type: "MOVIE" })).pagination.totalCount).toBe(0);
  });

  it("never lists the copy under any filter, and counts what it lists", async () => {
    await seedArrival();
    const cases: Array<[Record<string, string>, string[]]> = [
      [{}, ["dune", "arrival", "sicario", "pilot"]],
      // Play-side filters: the count skips the MediaItem join and subtracts the
      // copies matching the same filters, so each is also tried without the copy.
      [{ serverId: jellyfinId }, ["arrival", "sicario", "pilot"]],
      [{ serverId: plexId }, ["dune"]],
      [{ username: "alice" }, ["arrival", "pilot"]],
      [{ username: "bob" }, ["sicario"]],
      [{ username: "alice|carol" }, ["dune", "arrival", "pilot"]],
      [{ username: "carol|bob" }, ["dune", "sicario"]],
      [{ deviceName: "Shield" }, ["arrival", "pilot"]],
      [{ deviceName: "iPad|Apple TV" }, ["dune", "sicario"]],
      [{ platform: "Android|tvOS" }, ["dune", "arrival", "pilot"]],
      [{ platform: "iOS" }, ["sicario"]],
      // Item-side filters: the count joins MediaItem.
      [{ type: "MOVIE" }, ["dune", "arrival", "sicario"]],
      [{ search: "arrival" }, ["arrival"]],
      [{ startsWith: "A" }, ["arrival"]],
      [{ resolution: "4K" }, ["dune", "arrival"]],
      [{ dynamicRange: "HDR10" }, ["arrival"]],
      [{ videoCodec: "hevc" }, ["dune", "arrival"]],
      [{ audioCodec: "eac3" }, ["arrival"]],
      [{ username: "alice", type: "MOVIE" }, ["arrival"]],
      [{ serverId: jellyfinId, resolution: "4K" }, ["arrival"]],
    ];
    for (const [filter, expected] of cases) {
      const body = await list(filter);
      const label = JSON.stringify(filter);
      expect(body.items.map((r) => r.id), label).toEqual(ids(...expected));
      expect(body.pagination, label).toMatchObject({ totalCount: expected.length, hasMore: false });
      expectNoCopies(body);
    }
    // The copy's user is still a known user for the filter pickers.
    expect((await list()).usernames).toEqual(["alice", "bob", "carol"]);
  });

  it("pages a history full of copies as a total order, each play once", async () => {
    // One tie block, each play fanned out to a second library.
    const primaries: string[] = [];
    for (let i = 0; i < 7; i++) {
      const primary = await createTestMediaItem(moviesA, { title: `Tie ${i}` });
      const copy = await createTestMediaItem(moviesB, { title: `Tie ${i}` });
      primaries.push((await play(`tie${i}`, primary.id)).id);
      await play(`copy${i}`, copy.id, { fanOutOfItemId: primary.id });
    }

    for (const sortBy of ["watchedAt", "percentComplete", "title"]) {
      const seen: string[] = [];
      for (const page of [1, 2, 3, 4]) {
        const body = await list({ page: String(page), limit: "2", sortBy, sortOrder: "desc" });
        expect(body.pagination.totalCount, sortBy).toBe(7);
        expect(body.pagination.hasMore, `${sortBy} page ${page}`).toBe(page < 4);
        expectNoCopies(body);
        seen.push(...body.items.map((r) => r.id));
      }
      expect(seen, sortBy).toHaveLength(7);
      expect(new Set(seen), sortBy).toEqual(new Set(primaries));
    }
    expect((await list({ username: "alice", serverId: jellyfinId })).pagination.totalCount).toBe(7);
  });

  it("shows the copy once the primary's item is deleted", async () => {
    // `fanOutOfItemId` is `onDelete: SetNull`: the copy becomes the play's only record.
    const { primary, copy } = await seedArrival();
    const prisma = getTestPrisma();
    await prisma.mediaItem.delete({ where: { id: primary.id } });
    const copyId = playIds.get("copy-arrival")!;
    expect((await prisma.watchHistory.findUniqueOrThrow({ where: { id: copyId } })).fanOutOfItemId).toBeNull();

    const body = await list();
    expect(body.pagination.totalCount).toBe(4);
    expect(body.items.find((r) => r.id === copyId)?.mediaItem.id).toBe(copy.id);
    expect((await list({ username: "alice" })).pagination.totalCount).toBe(2);
    expect((await list({ search: "Arrival" })).pagination.totalCount).toBe(1);
  });
});
