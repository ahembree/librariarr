/**
 * A Jellyfin/Emby item two libraries list is stored once per library; the native sync files each play
 * against every copy, while lists of plays and analytics count it once (`WatchHistory.fanOutOfItemId`).
 * Real database, routes and clients against a local fake server.
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

describe("native watch history: one play filed against several library copies", () => {
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
    fake = await startFakeMediaServer(jellyfinRoute(plays));
    const server = await createTestServer(userId, { type, url: fake.url, watchHistorySyncedAt: null });
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
  /** How often the show's play list, the History page and both analytics show alice's one play. */
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

      expect(await storedPointers(server.id)).toEqual([
        [primary.id, null],
        [copy.id, primary.id],
      ]);
      await expectListedTimes(server.id, 1);
      expect((await seriesHistory()).items[0].mediaItem.id).toBe(primary.id);
      const seriesTrends = await computeWatchTrends([server.id], { mediaType: "SERIES", days: 30, limit: 10 });
      expect(seriesTrends).toEqual([expect.objectContaining({ title: "The Show", plays: 1 })]);
      // Each copy's own page lists it (on the copy's, its row is the only record).
      for (const item of [primary, copy]) {
        const plays = await itemPlays(item.id);
        expect(plays.items.map((i) => i.mediaItem.id)).toEqual([item.id]);
        expect(plays.pagination.totalCount).toBe(1);
      }
      // The per-item reconcile is unchanged: BOTH copies read as watched.
      const items = await prisma.mediaItem.findMany({
        where: { id: { in: [primary.id, copy.id] } },
        select: { playCount: true, lastPlayedAt: true },
      });
      expect(items).toEqual([
        { playCount: 1, lastPlayedAt: PLAYED_AT },
        { playCount: 1, lastPlayedAt: PLAYED_AT },
      ]);
    },
  );

  it("files the undated plays of a play count against both copies the same way, counting plays", async () => {
    // PlayCount 3: one dated entry (LastPlayedDate) and two undated ones.
    const { server, primary, copy } = await twoCopies("JELLYFIN", { alice: [played("jf-ep1", 3)] });
    const updates: Array<{ detail?: string }> = [];

    await expect(syncWatchHistory(server.id, (u) => updates.push(u))).resolves.toEqual({ count: 6 });

    // Progress counts plays, not rows, so it never passes the total.
    expect(updates.at(-1)?.detail).toBe("Stored 3 of 3 plays");
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

    // 5 rows, 3 plays: counted on rows, page 2 would still say there is more.
    const page1 = await seriesHistory({ limit: "2", page: "1" });
    expect(page1.items).toHaveLength(2);
    expect(page1.pagination).toMatchObject({ hasMore: true, totalCount: 3 });
    const page2 = await seriesHistory({ limit: "2", page: "2" });
    expect(page2.items).toHaveLength(1);
    expect(page2.pagination).toMatchObject({ hasMore: false, totalCount: 3 });
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(3);
  });

  it("shows the play through the other copy once the primary copy is deleted", async () => {
    const { server, primary, copy } = await twoCopies("JELLYFIN", { alice: [played("jf-ep1")] });
    await syncWatchHistory(server.id);

    // The primary row cascades away; `SetNull` makes the copy's the only record.
    await prisma.mediaItem.delete({ where: { id: primary.id } });

    expect(await storedPointers(server.id)).toEqual([[copy.id, null]]);
    expect((await seriesHistory()).items.map((i) => i.mediaItem.id)).toEqual([copy.id]);
    await expectListedTimes(server.id, 1);
  });

  it("with three copies, lists the play once per remaining copy after the primary copy is deleted — until the next full replace", async () => {
    // The documented limit (`nativeRowsForPlay`): `SetNull` clears EVERY survivor's pointer.
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
});
