/**
 * A Jellyfin/Emby item listed by two libraries (two libraries over one folder)
 * is stored once per library, and the native sync files each play against
 * every copy — every copy has to read as watched to the per-item consumers.
 * Lists of PLAYS and the watch analytics must still count it once: all rows
 * but one point at the copy holding the play's primary row
 * (`WatchHistory.fanOutOfItemId`).
 *
 * Real database, real routes, and the REAL Jellyfin/Emby/Plex clients talking
 * to a local fake server — only the media server itself is faked.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import {
  startFakeMediaServer,
  jellyfinRoute,
  type FakeMediaServer,
  type FakePlayedItem,
  type FakeRoute,
} from "./fake-media-server";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: vi.fn(async () => true),
  isJobRetrying: vi.fn(async () => false),
}));

import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { GET as getSeriesHistory } from "@/app/api/media/series/watch-history/route";
import { GET as getItemPlays } from "@/app/api/media/[id]/plays/route";
import { GET as getHistory } from "@/app/api/media/history/route";
import { computeWatchLeaderboard, computeWatchTrends } from "@/lib/media/watch-analytics";

const prisma = getTestPrisma();

interface PlaysBody {
  items: Array<{ id: string; serverUsername: string; watchedAt: string | null; mediaItem: { id: string } }>;
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
}

const SERIES_KEY = "tvdb:4242";
/** Recent, so it sits inside every analytics window. */
const PLAYED_AT = new Date(Date.now() - 2 * 86_400_000);
PLAYED_AT.setUTCMilliseconds(0);

const played = (id: string, playCount = 1): FakePlayedItem => ({
  Id: id,
  UserData: { PlayCount: playCount, LastPlayedDate: PLAYED_AT.toISOString() },
});

let fake: FakeMediaServer | null = null;

async function serve(route: FakeRoute): Promise<string> {
  fake = await startFakeMediaServer(route);
  return fake.url;
}

describe("native watch history: one play filed against two library copies", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
  });

  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** One episode stored in two libraries of a Jellyfin/Emby server (lower id = primary). */
  async function twoCopies(type: "JELLYFIN" | "EMBY", plays: Record<string, FakePlayedItem[]>) {
    const url = await serve(jellyfinRoute(plays));
    const server = await createTestServer(userId, { type, url, watchHistorySyncedAt: null });
    const libA = await createTestLibrary(server.id, { key: "lib-a", type: "SERIES" });
    const libB = await createTestLibrary(server.id, { key: "lib-b", type: "SERIES" });
    const episode = (libraryId: string, ratingKey: string, episodeNumber: number) =>
      createTestMediaItem(libraryId, {
        type: "SERIES",
        ratingKey,
        title: `Episode ${episodeNumber}`,
        parentTitle: "The Show",
        seriesKey: SERIES_KEY,
        seasonNumber: 1,
        episodeNumber,
      });
    const a = await episode(libA.id, "jf-ep1", 1);
    const b = await episode(libB.id, "jf-ep1", 1);
    const [primary, copy] = [a, b].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return { server, libA, libB, primary, copy, episode };
  }

  const seriesHistory = async (query: Record<string, string> = {}) =>
    expectJson<PlaysBody>(
      await callRoute(getSeriesHistory, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: SERIES_KEY, ...query },
      }),
    );
  const itemPlays = async (id: string) =>
    expectJson<PlaysBody>(
      await callRouteWithParams(getItemPlays, { id }, { url: `/api/media/${id}/plays` }),
    );
  const storedRows = (serverId: string) =>
    prisma.watchHistory.findMany({
      where: { mediaServerId: serverId },
      select: { mediaItemId: true, fanOutOfItemId: true, serverUsername: true, watchedAt: true },
    });
  /** `[mediaItemId, fanOutOfItemId]` of every stored row, by item id. */
  const storedPointers = async (serverId: string) =>
    (await storedRows(serverId))
      .map((r) => [r.mediaItemId, r.fanOutOfItemId])
      .sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0));
  /**
   * How many times every list of plays shows alice's one play: the show's
   * play list, the History page and both analytics — each page's rows and its
   * count, which must agree.
   */
  async function expectListedTimes(serverId: string, times: number) {
    const series = await seriesHistory();
    expect(series.items).toHaveLength(times);
    expect(series.pagination.totalCount).toBe(times);
    const history = await expectJson<PlaysBody>(
      await callRoute(getHistory, { url: "/api/media/history" }),
    );
    expect(history.items).toHaveLength(times);
    expect(history.pagination.totalCount).toBe(times);
    const trends = await computeWatchTrends([serverId], { days: 30, limit: 10 });
    expect(trends).toEqual([expect.objectContaining({ title: "The Show", plays: times, users: 1 })]);
    const board = await computeWatchLeaderboard([serverId], { groupBy: "user", days: 30, limit: 10 });
    expect(board).toEqual([expect.objectContaining({ key: "alice", plays: times })]);
  }

  it.each(["JELLYFIN", "EMBY"] as const)(
    "%s: stores the play on both copies with exactly one primary row, and every list counts it once",
    async (type) => {
      const { server, primary, copy } = await twoCopies(type, { alice: [played("jf-ep1")] });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 2 });

      // Both copies hold the play; the lower id holds its primary row.
      const rows = await storedRows(server.id);
      expect(
        rows.map((r) => [r.mediaItemId, r.fanOutOfItemId]).sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
      ).toEqual([
        [primary.id, null],
        [copy.id, primary.id],
      ]);

      // The show's play list: one play, and a count that agrees.
      const series = await seriesHistory();
      expect(series.items).toHaveLength(1);
      expect(series.items[0].mediaItem.id).toBe(primary.id);
      expect(series.pagination.totalCount).toBe(1);

      // Each copy's own page still lists it — on the second copy's page its
      // row is the only record of the play, and the copy was watched.
      for (const item of [primary, copy]) {
        const plays = await itemPlays(item.id);
        expect(plays.items).toHaveLength(1);
        expect(plays.items[0].mediaItem.id).toBe(item.id);
        expect(plays.pagination.totalCount).toBe(1);
      }

      // The analytics count plays, not rows.
      const trends = await computeWatchTrends([server.id], { days: 30, limit: 10 });
      expect(trends).toEqual([expect.objectContaining({ title: "The Show", plays: 1, users: 1 })]);
      const seriesTrends = await computeWatchTrends([server.id], { mediaType: "SERIES", days: 30, limit: 10 });
      expect(seriesTrends).toEqual([expect.objectContaining({ title: "The Show", plays: 1 })]);
      const board = await computeWatchLeaderboard([server.id], { groupBy: "user", days: 30, limit: 10 });
      expect(board).toEqual([expect.objectContaining({ key: "alice", plays: 1, items: 1 })]);

      // The per-item reconcile is unchanged: BOTH copies read as watched.
      const items = await prisma.mediaItem.findMany({
        where: { id: { in: [primary.id, copy.id] } },
        select: { playCount: true, lastPlayedAt: true },
      });
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.playCount).toBe(1);
        expect(item.lastPlayedAt?.toISOString()).toBe(PLAYED_AT.toISOString());
      }
    },
  );

  it("files the undated plays of a play count against both copies the same way", async () => {
    // PlayCount 3: one dated entry (LastPlayedDate) and two undated ones.
    const { server, primary, copy } = await twoCopies("JELLYFIN", { alice: [played("jf-ep1", 3)] });

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 6 });

    const rows = await storedRows(server.id);
    expect(rows.filter((r) => r.mediaItemId === primary.id).every((r) => r.fanOutOfItemId === null)).toBe(true);
    expect(rows.filter((r) => r.mediaItemId === copy.id).map((r) => r.fanOutOfItemId)).toEqual([
      primary.id,
      primary.id,
      primary.id,
    ]);
    expect(rows.filter((r) => r.watchedAt === null)).toHaveLength(4);

    const series = await seriesHistory();
    expect(series.pagination.totalCount).toBe(3);
    expect(series.items.every((i) => i.mediaItem.id === primary.id)).toBe(true);
    for (const item of [primary, copy]) {
      expect((await itemPlays(item.id)).pagination.totalCount).toBe(3);
    }
    // Both copies read as played three times.
    const items = await prisma.mediaItem.findMany({
      where: { id: { in: [primary.id, copy.id] } },
      select: { playCount: true },
    });
    expect(items.map((i) => i.playCount)).toEqual([3, 3]);
  });

  it("pages and counts the show's plays, not its rows", async () => {
    const { server, libA, libB, episode } = await twoCopies("JELLYFIN", {
      alice: [played("jf-ep1"), played("jf-ep2"), played("jf-ep3")],
    });
    // Episode 2 is in both libraries too; episode 3 only in the first.
    await episode(libA.id, "jf-ep2", 2);
    await episode(libB.id, "jf-ep2", 2);
    await episode(libA.id, "jf-ep3", 3);

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 5 });

    // 5 rows, 3 plays. Counted on rows, page 2 would still say there is more.
    const page1 = await seriesHistory({ limit: "2", page: "1" });
    expect(page1.items).toHaveLength(2);
    expect(page1.pagination).toMatchObject({ hasMore: true, totalCount: 3 });
    const page2 = await seriesHistory({ limit: "2", page: "2" });
    expect(page2.items).toHaveLength(1);
    expect(page2.pagination).toMatchObject({ hasMore: false, totalCount: 3 });
    const ids = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("shows the play through the other copy once the primary copy is deleted", async () => {
    const { server, primary, copy } = await twoCopies("JELLYFIN", { alice: [played("jf-ep1")] });
    await syncWatchHistory(server.id);

    // A real delete: the primary row cascades away with its item, and the
    // copy's pointer is set to null — it is now the play's only record.
    await prisma.mediaItem.delete({ where: { id: primary.id } });

    expect(await storedRows(server.id)).toEqual([
      expect.objectContaining({ mediaItemId: copy.id, fanOutOfItemId: null }),
    ]);
    const series = await seriesHistory();
    expect(series.items.map((i) => i.mediaItem.id)).toEqual([copy.id]);
    // Once, everywhere: the History page and the analytics as well.
    await expectListedTimes(server.id, 1);
  });

  it("with three copies, lists the play once per remaining copy after the primary copy is deleted — until the next full replace", async () => {
    // The documented limit of the design (see `nativeRowsForPlay`): stored
    // rows are not re-pointed when the primary copy is deleted, and `SetNull`
    // clears the pointer on EVERY remaining copy.
    const { server, episode } = await twoCopies("JELLYFIN", { alice: [played("jf-ep1")] });
    const libC = await createTestLibrary(server.id, { key: "lib-c", type: "SERIES" });
    await episode(libC.id, "jf-ep1", 1);
    const [primary, second, third] = (
      await prisma.mediaItem.findMany({ where: { ratingKey: "jf-ep1" }, select: { id: true } })
    )
      .map((i) => i.id)
      .sort();

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 3 });
    expect(await storedPointers(server.id)).toEqual([
      [primary, null],
      [second, primary],
      [third, primary],
    ]);
    await expectListedTimes(server.id, 1);

    await prisma.mediaItem.delete({ where: { id: primary } });

    // Both survivors now read as primaries: the play is shown twice.
    expect(await storedPointers(server.id)).toEqual([
      [second, null],
      [third, null],
    ]);
    await expectListedTimes(server.id, 2);

    // The next full replace rebuilds the play's rows over the copies left.
    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 2 });
    expect(await storedPointers(server.id)).toEqual([
      [second, null],
      [third, second],
    ]);
    await expectListedTimes(server.id, 1);
  });

  it("re-points the copy's row on the next full replace after the primary copy is deleted", async () => {
    const { server, primary, copy } = await twoCopies("JELLYFIN", { alice: [played("jf-ep1")] });
    await syncWatchHistory(server.id);
    await prisma.mediaItem.delete({ where: { id: primary.id } });

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

    expect(await storedRows(server.id)).toEqual([
      expect.objectContaining({ mediaItemId: copy.id, fanOutOfItemId: null }),
    ]);
  });

  it("on Plex, still places or skips a play on a rating key two libraries share, and never fans it out", async () => {
    // Plex keys are server-unique: one of the two rows is stale, and only the
    // play's own library can say which.
    const viewedAt = Math.floor(PLAYED_AT.getTime() / 1000);
    const url = await serve((path) => {
      if (path === "/accounts") return { body: { MediaContainer: { Account: [{ id: 1, name: "alice" }] } } };
      if (path === "/devices") return { body: { MediaContainer: { Device: [] } } };
      return {
        body: {
          MediaContainer: {
            totalSize: 2,
            size: 2,
            Metadata: [
              { historyKey: "/h/1", ratingKey: "100", viewedAt, accountID: 1, librarySectionID: 2 },
              // Names no library: ambiguous, skipped.
              { historyKey: "/h/2", ratingKey: "100", viewedAt: viewedAt - 60, accountID: 1 },
            ],
          },
        },
      };
    });
    const server = await createTestServer(userId, { type: "PLEX", url });
    const libA = await createTestLibrary(server.id, { key: "1" });
    const libB = await createTestLibrary(server.id, { key: "2" });
    await createTestMediaItem(libA.id, { ratingKey: "100" });
    const inB = await createTestMediaItem(libB.id, { ratingKey: "100" });

    await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

    expect(await storedRows(server.id)).toEqual([
      expect.objectContaining({ mediaItemId: inB.id, fanOutOfItemId: null }),
    ]);
  });
});
