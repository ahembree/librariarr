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

import { GET } from "@/app/api/media/history/route";

type HistoryResponse = {
  items: Array<{ id: string }>;
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
};

/** Every descending sort on a column of the play, and that column. */
const PLAY_SORTS: Record<string, string> = {
  watchedAt: "watchedAt",
  serverUsername: "serverUsername",
  deviceName: "deviceName",
  platform: "platform",
  percentComplete: "percentComplete",
  isTranscode: "isTranscode",
  player: "player",
  streamResolution: "resolution",
};

describe("GET /api/media/history — order across pages", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true});
    const server = await createTestServer(userId);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });

    // Fourteen plays with ties, and nulls in every sortable column of the
    // play: undated native plays, unknown devices and platforms, and native
    // rows that carry none of the Tracearr columns.
    const day = (d: number) => new Date(Date.UTC(2024, 0, d));
    const plays: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 14; i++) {
      const tracearr = i % 2 === 0;
      plays.push({
        serverUsername: ["ann", "ben", "cat"][i % 3],
        watchedAt: i % 5 === 4 ? null : day(1 + (i % 4)),
        deviceName: i % 4 === 3 ? null : ["den", "hall", "loft"][i % 3],
        platform: i % 6 === 5 ? null : ["ios", "tvos"][i % 2],
        ...(tracearr
          ? {
              source: "TRACEARR",
              sourceEventId: `evt-${i}`,
              percentComplete: (i % 3) * 40,
              isTranscode: i % 4 === 0,
              player: i % 8 === 0 ? null : "web",
              resolution: ["1080p", "720p"][i % 2 === 0 ? (i / 2) % 2 : 0],
            }
          : {}),
      });
    }
    for (const [i, play] of plays.entries()) {
      const item = await createTestMediaItem(library.id, { title: `Film ${i}` });
      await getTestPrisma().watchHistory.create({
        data: { mediaItemId: item.id, mediaServerId: server.id, serverUsername: "x", ...play },
      });
    }
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function pageThrough(sortBy: string, sortOrder: "asc" | "desc", limit: number) {
    const ids: string[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await expectJson<HistoryResponse>(
        await callRoute(GET, {
          url: "/api/media/history",
          searchParams: { page: String(page), limit: String(limit), sortBy, sortOrder },
        }),
      );
      expect(data.pagination.totalCount).toBe(14);
      ids.push(...data.items.map((i) => i.id));
      if (!data.pagination.hasMore) break;
    }
    return ids;
  }

  async function reference(column: string, direction: "ASC" | "DESC") {
    const rows = await getTestPrisma().$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "WatchHistory" ORDER BY "${column}" ${direction} NULLS LAST, id ASC`,
    );
    return rows.map((r) => r.id);
  }

  for (const [sortBy, column] of Object.entries(PLAY_SORTS)) {
    it(`pages ${sortBy} newest/highest first with nulls last, every play once`, async () => {
      const expected = await reference(column, "DESC");
      // Page sizes that put a page boundary inside the null rows and inside ties.
      for (const limit of [1, 3, 4, 14]) {
        expect(await pageThrough(sortBy, "desc", limit)).toEqual(expected);
      }
    });
  }

  it("keeps ascending order with nulls last", async () => {
    expect(await pageThrough("watchedAt", "asc", 3)).toEqual(await reference("watchedAt", "ASC"));
    expect(await pageThrough("deviceName", "asc", 3)).toEqual(await reference("deviceName", "ASC"));
  });

  it("puts undated plays after every dated one, newest first", async () => {
    const data = await expectJson<{ items: Array<{ watchedAt: string | null }> }>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { page: "1", limit: "14", sortBy: "watchedAt", sortOrder: "desc" },
      }),
    );
    const dates = data.items.map((i) => i.watchedAt);
    const firstNull = dates.indexOf(null);
    expect(firstNull).toBeGreaterThan(0);
    expect(dates.slice(firstNull).every((d) => d === null)).toBe(true);
    const dated = dates.slice(0, firstNull) as string[];
    expect([...dated].sort().reverse()).toEqual(dated);
  });
});
