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
  mediaItem: { id: string; title: string };
  server: { id: string };
};
type HistoryResponse = {
  items: Row[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
  usernames: string[];
};

/**
 * Jellyfin/Emby can list one item in two libraries over the same folder, and
 * the native sync files a play against every copy so each reads as watched to
 * the per-item consumers — marking every copy's row but the primary's with
 * `fanOutOfItemId`. The History page lists PLAYS, so it must show such a play
 * once: in the rows AND in `totalCount`, under every filter, on every page.
 */
describe("GET /api/media/history — fan-out copies", () => {
  let userId: string;
  // Jellyfin, two movie libraries over one folder plus a TV library.
  let jellyfinId: string;
  // Plex, no fan-out (its rating keys are server-unique).
  let plexId: string;
  let moviesA: string;
  let moviesB: string;
  let tv: string;
  let plexMovies: string;
  const playIds = new Map<string, string>();

  async function list(searchParams: Record<string, string> = {}) {
    return expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history", searchParams }),
      200,
    );
  }

  async function play(
    name: string,
    data: {
      mediaItemId: string;
      mediaServerId: string;
      serverUsername: string;
      watchedAt: Date;
      fanOutOfItemId?: string;
      deviceName?: string;
      platform?: string;
    },
  ) {
    const row = await getTestPrisma().watchHistory.create({ data });
    playIds.set(name, row.id);
    return row;
  }

  /** The copy's row is never listed, so its id must not appear anywhere. */
  function expectNoCopies(body: HistoryResponse) {
    const copies = [...playIds].filter(([name]) => name.startsWith("copy")).map(([, id]) => id);
    expect(copies.length).toBeGreaterThan(0);
    for (const id of copies) expect(body.items.map((r) => r.id)).not.toContain(id);
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    playIds.clear();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });

    jellyfinId = (await createTestServer(userId, { name: "Jelly", type: "JELLYFIN" })).id;
    plexId = (await createTestServer(userId, { name: "Plexy", type: "PLEX" })).id;
    moviesA = (await createTestLibrary(jellyfinId, { type: "MOVIE", title: "Movies" })).id;
    moviesB = (await createTestLibrary(jellyfinId, { type: "MOVIE", title: "Movies (kids)" })).id;
    tv = (await createTestLibrary(jellyfinId, { type: "SERIES", title: "TV" })).id;
    plexMovies = (await createTestLibrary(plexId, { type: "MOVIE" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /**
   * One Jellyfin play of "Arrival" filed against both library copies, plus
   * plays with no copies on both servers, so every filter below has rows it
   * keeps and rows it drops. Both copies carry the same file metadata, as two
   * libraries over one folder do.
   */
  async function seedArrival() {
    const file = { title: "Arrival", resolution: "4k", videoCodec: "hevc", audioCodec: "eac3", dynamicRange: "HDR10" };
    const primary = await createTestMediaItem(moviesA, { ...file, ratingKey: "rk-arrival" });
    const copy = await createTestMediaItem(moviesB, { ...file, ratingKey: "rk-arrival" });
    const when = new Date("2024-06-03T20:00:00Z");
    await play("arrival", {
      mediaItemId: primary.id, mediaServerId: jellyfinId, serverUsername: "alice",
      watchedAt: when, deviceName: "Shield", platform: "Android",
    });
    await play("copy-arrival", {
      mediaItemId: copy.id, mediaServerId: jellyfinId, serverUsername: "alice",
      watchedAt: when, deviceName: "Shield", platform: "Android", fanOutOfItemId: primary.id,
    });

    const sicario = await createTestMediaItem(moviesA, { title: "Sicario", resolution: "1080" });
    await play("sicario", {
      mediaItemId: sicario.id, mediaServerId: jellyfinId, serverUsername: "bob",
      watchedAt: new Date("2024-06-02T20:00:00Z"), deviceName: "iPad", platform: "iOS",
    });
    const pilot = await createTestMediaItem(tv, {
      type: "SERIES", title: "Pilot", parentTitle: "Severance", seasonNumber: 1, episodeNumber: 1, resolution: "720",
    });
    await play("pilot", {
      mediaItemId: pilot.id, mediaServerId: jellyfinId, serverUsername: "alice",
      watchedAt: new Date("2024-06-01T20:00:00Z"), deviceName: "Shield", platform: "Android",
    });
    const dune = await createTestMediaItem(plexMovies, { title: "Dune", resolution: "4k", videoCodec: "hevc" });
    await play("dune", {
      mediaItemId: dune.id, mediaServerId: plexId, serverUsername: "carol",
      watchedAt: new Date("2024-06-04T20:00:00Z"), deviceName: "Apple TV", platform: "tvOS",
    });
    return { primary, copy };
  }

  it("counts an empty history as zero on both count paths", async () => {
    const empty = await list();
    expect(empty.items).toEqual([]);
    expect(empty.pagination).toMatchObject({ totalCount: 0, hasMore: false });
    expect((await list({ type: "MOVIE" })).pagination.totalCount).toBe(0);
  });

  it("lists a fanned-out play once and counts it once", async () => {
    await seedArrival();
    const body = await list();
    expect(body.items.map((r) => r.id)).toEqual(
      ["dune", "arrival", "sicario", "pilot"].map((n) => playIds.get(n)),
    );
    expect(body.pagination.totalCount).toBe(4);
    expect(body.pagination.hasMore).toBe(false);
    expectNoCopies(body);
    // The copy's user is still a known user for the filter pickers.
    expect(body.usernames).toEqual(["alice", "bob", "carol"]);
  });

  it("never lists the copy under any filter, and counts what it lists", async () => {
    await seedArrival();
    const cases: Array<[Record<string, string>, string[]]> = [
      // Play-side filters: the count runs without the MediaItem join, as a
      // total minus the copies matching the same filters.
      [{ serverId: "JELLY" }, ["arrival", "sicario", "pilot"]],
      [{ serverId: "PLEX" }, ["dune"]],
      [{ username: "alice" }, ["arrival", "pilot"]],
      [{ username: "alice|carol" }, ["dune", "arrival", "pilot"]],
      [{ deviceName: "Shield" }, ["arrival", "pilot"]],
      [{ platform: "Android|tvOS" }, ["dune", "arrival", "pilot"]],
      // Item-side filters: the count joins MediaItem.
      [{ type: "MOVIE" }, ["dune", "arrival", "sicario"]],
      [{ search: "arrival" }, ["arrival"]],
      [{ startsWith: "A" }, ["arrival"]],
      [{ resolution: "4K" }, ["dune", "arrival"]],
      [{ dynamicRange: "HDR10" }, ["arrival"]],
      [{ videoCodec: "hevc" }, ["dune", "arrival"]],
      [{ audioCodec: "eac3" }, ["arrival"]],
      // Both kinds at once.
      [{ username: "alice", type: "MOVIE" }, ["arrival"]],
      [{ serverId: "JELLY", resolution: "4K" }, ["arrival"]],
    ];
    for (const [filter, expected] of cases) {
      const params = Object.fromEntries(
        Object.entries(filter).map(([k, v]) => [k, v === "JELLY" ? jellyfinId : v === "PLEX" ? plexId : v]),
      );
      const body = await list(params);
      const label = JSON.stringify(filter);
      expect(body.items.map((r) => r.id), label).toEqual(expected.map((n) => playIds.get(n)));
      expect(body.pagination.totalCount, label).toBe(expected.length);
      expectNoCopies(body);
    }
  });

  it("subtracts only the copies the play-side filters select", async () => {
    // The unjoined count is "plays matching the filters minus copies matching
    // the same filters". A subtraction that ignored the filters would take the
    // Jellyfin copy off Plex's count (1 - 1 = 0) and off bob's.
    await seedArrival();
    expect((await list({ serverId: plexId })).pagination.totalCount).toBe(1);
    expect((await list({ username: "bob" })).pagination.totalCount).toBe(1);
    expect((await list({ username: "carol|bob" })).pagination.totalCount).toBe(2);
    expect((await list({ deviceName: "iPad|Apple TV" })).pagination.totalCount).toBe(2);
    expect((await list({ platform: "iOS" })).pagination.totalCount).toBe(1);
    // ...and every copy that does match: three copies of three plays.
    const second = await createTestMediaItem(moviesA, { title: "Second" });
    const secondCopy = await createTestMediaItem(moviesB, { title: "Second" });
    const third = await createTestMediaItem(moviesA, { title: "Third" });
    const thirdCopy = await createTestMediaItem(moviesB, { title: "Third" });
    for (const [primary, copy, n] of [[second, secondCopy, 2], [third, thirdCopy, 3]] as const) {
      const watchedAt = new Date(`2024-05-0${n}T00:00:00Z`);
      await play(`p${n}`, { mediaItemId: primary.id, mediaServerId: jellyfinId, serverUsername: "alice", watchedAt });
      await play(`copy${n}`, {
        mediaItemId: copy.id, mediaServerId: jellyfinId, serverUsername: "alice", watchedAt, fanOutOfItemId: primary.id,
      });
    }
    const alice = await list({ username: "alice", serverId: jellyfinId });
    expect(alice.pagination.totalCount).toBe(4);
    expect(alice.items).toHaveLength(4);
    expect((await list()).pagination.totalCount).toBe(6);
  });

  it("pages a history full of copies as a total order, each play once", async () => {
    // One tie block (every play at the same instant), each play fanned out to
    // a second library: a sort without the unique tiebreaker — or a filter
    // applied to one page's query and not the other's — shows a play twice or
    // drops one at a page boundary.
    const watchedAt = new Date("2024-06-01T00:00:00Z");
    const primaries: string[] = [];
    for (let i = 0; i < 7; i++) {
      const primary = await createTestMediaItem(moviesA, { title: `Tie ${i}` });
      const copy = await createTestMediaItem(moviesB, { title: `Tie ${i}` });
      const row = await play(`tie${i}`, { mediaItemId: primary.id, mediaServerId: jellyfinId, serverUsername: "alice", watchedAt });
      primaries.push(row.id);
      await play(`copy${i}`, {
        mediaItemId: copy.id, mediaServerId: jellyfinId, serverUsername: "alice", watchedAt, fanOutOfItemId: primary.id,
      });
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
  });

  it("shows the copy once the primary's item is deleted", async () => {
    // `fanOutOfItemId` is `onDelete: SetNull`: the primary's row cascades
    // away with its item, and the copy — now the play's only record — must
    // come back rather than the play vanishing from the history.
    const { primary, copy } = await seedArrival();
    await getTestPrisma().mediaItem.delete({ where: { id: primary.id } });

    const copyRow = await getTestPrisma().watchHistory.findUniqueOrThrow({ where: { id: playIds.get("copy-arrival")! } });
    expect(copyRow.fanOutOfItemId).toBeNull();

    const body = await list();
    expect(body.pagination.totalCount).toBe(4);
    expect(body.items.map((r) => r.id)).toContain(playIds.get("copy-arrival"));
    expect(body.items.find((r) => r.id === playIds.get("copy-arrival"))?.mediaItem.id).toBe(copy.id);
    expect((await list({ username: "alice" })).pagination.totalCount).toBe(2);
    expect((await list({ search: "Arrival" })).pagination.totalCount).toBe(1);
  });
});
