import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
} from "../../setup/test-helpers";
import { FakeTracearrArchive, TRACEARR_SERVER_ID, play } from "./fake-tracearr-archive";

/**
 * A Tracearr-mapped Jellyfin/Emby server whose item two libraries list (two
 * libraries over one folder: one item, one id, two rows), end to end against
 * real Postgres and a fake Tracearr keyset.
 *
 * Skipped as "ambiguous", a play of such an item reached neither copy: both
 * read as never watched, and once the archive walk completed the evidence
 * marker vouched for that — negative `watchedByUser` and `playCount = 0` DELETE
 * rules then match items that were watched. The native path files such a play
 * against every copy; the Tracearr import now does too, on that exact shape
 * only: one row per copy, every row but the primary's naming it through
 * `fanOutOfItemId`, so lists of plays show the play once.
 */

const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  getHistoryForItem: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
}));

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
    getOrSet: async (_key: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return { MemoryCache: vi.fn(() => noopCache), appCache: noopCache };
});

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.getHistoryForItem = m.getHistoryForItem;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

import { logger } from "@/lib/logger";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { recoverHistoryForNewItems, resetRecoveryAnswers } from "@/lib/sync/tracearr-backfill-additions";
import { GET as listHistory } from "@/app/api/media/history/route";
import { GET as listSeriesHistory } from "@/app/api/media/series/watch-history/route";
import { GET as importStatus } from "@/app/api/integrations/tracearr/status/route";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
// One base for the whole file: a play's time and the expectation built from
// it must be the same instant, not two reads of the clock apart.
const NOW = Date.now();
const at = (offset: number) => new Date(NOW + offset);

let archive: FakeTracearrArchive;
let userId: string;

async function mappedServer(type: "JELLYFIN" | "EMBY" | "PLEX") {
  const server = await createTestServer(userId, { type, tracearrServerId: TRACEARR_SERVER_ID });
  return server.id;
}

/** A movie row with a chosen id, so which copy is "lowest" is known. */
async function movie(libraryId: string, id: string, ratingKey: string) {
  const item = await createTestMediaItem(libraryId, { ratingKey, type: "MOVIE", title: "Shared Film" });
  return prisma.mediaItem.update({ where: { id: item.id }, data: { id } });
}

async function rowsOf(serverId: string) {
  return prisma.watchHistory.findMany({
    where: { mediaServerId: serverId },
    select: {
      mediaItemId: true,
      sourceEventId: true,
      fanOutOfItemId: true,
      watched: true,
      percentComplete: true,
    },
    orderBy: { mediaItemId: "asc" },
  });
}

describe("Tracearr plays of an item two Jellyfin/Emby libraries list (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetRecoveryAnswers();
    vi.clearAllMocks();
    // Reset, not just cleared: a once-implementation a failed test never
    // consumed must not leak into the next one.
    for (const fn of Object.values(m)) fn.mockReset();
    archive = new FakeTracearrArchive();
    m.getHistoryPage.mockImplementation(async (id: string, options: object) => archive.page(id, options));
    m.findOldestPlayAt.mockImplementation(async (id: string) => archive.oldest(id));
    m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
    m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
    m.getHistoryForItem.mockImplementation(async (id: string, filter: { ratingKey?: string }) =>
      filter.ratingKey
        ? archive.page(id, { pageSize: 1000 }).records.filter((record) => record.rating_key === filter.ratingKey)
        : [],
    );
    const user = await createTestUser();
    userId = user.id;
    await prisma.tracearrInstance.create({
      data: { userId, name: "Tracearr", url: "http://tracearr:8080", apiKey: "k" },
    });
    setMockSession({ userId, plexToken: "tok", isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  for (const type of ["JELLYFIN", "EMBY"] as const) {
    it(`files the play against both copies on ${type}, and lists and counts it once`, async () => {
      const serverId = await mappedServer(type);
      const moviesA = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies" });
      const moviesB = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies (4K shelf)" });
      await movie(moviesA.id, "item-b", "jf-1");
      await movie(moviesB.id, "item-c", "jf-1");
      archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1" }));
      // A native row left from before the mapping: replaced by the import,
      // copies and all, as on any other server.
      await prisma.watchHistory.create({
        data: { mediaItemId: "item-c", mediaServerId: serverId, serverUsername: "walter", watchedAt: at(-9 * DAY) },
      });

      const result = await syncTracearrHistory(serverId, { passes: "backfill" });

      expect(result).toMatchObject({ count: 1, backfillPending: false });
      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: null },
        {
          mediaItemId: "item-c",
          sourceEventId: "chain-1:copy:item-c",
          fanOutOfItemId: "item-b",
          watched: true,
          percentComplete: null,
        },
      ]);
      // Both copies read as watched to the rules.
      for (const id of ["item-b", "item-c"]) {
        expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).toMatchObject({
          playCount: 1,
          lastPlayedAt: at(-2 * DAY),
        });
      }

      const history = await expectJson<{ items: unknown[]; pagination: { totalCount: number } }>(
        await callRoute(listHistory, { url: "/api/media/history" }),
        200,
      );
      expect(history.items).toHaveLength(1);
      expect(history.pagination.totalCount).toBe(1);

      const status = await expectJson<{
        servers: Array<{ importedCount: number; oldestImported: string; newestImported: string }>;
      }>(await callRoute(importStatus, { url: "/api/integrations/tracearr/status" }), 200);
      expect(status.servers[0]).toMatchObject({
        importedCount: 1,
        oldestImported: at(-2 * DAY).toISOString(),
        newestImported: at(-2 * DAY).toISOString(),
      });
    });
  }

  it("lists an episode's play once on the series route", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const tvA = await createTestLibrary(serverId, { type: "SERIES", title: "TV" });
    const tvB = await createTestLibrary(serverId, { type: "SERIES", title: "Kids TV" });
    for (const library of [tvA, tvB]) {
      const episode = await createTestMediaItem(library.id, {
        ratingKey: "ep-1",
        type: "SERIES",
        title: "Pilot",
        parentTitle: "The Show",
        seriesKey: "tvdb:1",
        seasonNumber: 1,
        episodeNumber: 1,
      });
      await prisma.mediaItem.update({ where: { id: episode.id }, data: { grandparentRatingKey: "show-1" } });
    }
    archive.add(
      play("chain-ep", at(-DAY), {
        media_type: "episode",
        rating_key: "ep-1",
        grandparent_rating_key: "show-1",
        season_number: 1,
        episode_number: 1,
      }),
    );

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(2);
    const plays = await expectJson<{ items: unknown[]; pagination: { totalCount: number } }>(
      await callRoute(listSeriesHistory, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:1" },
      }),
      200,
    );
    expect(plays.items).toHaveLength(1);
    expect(plays.pagination.totalCount).toBe(1);
  });

  it("merges a resumed chain re-delivered into both rows, without adding any", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    await movie(moviesB.id, "item-c", "jf-1");
    archive.add(
      play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 40, state: "stopped" }),
    );
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // Resumed and finished: the same chain, delivered again by the catch-up.
    archive = new FakeTracearrArchive();
    archive.add(
      play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95, segment_count: 2 }),
    );
    const again = await syncTracearrHistory(serverId, { passes: "forward" });

    expect(again.count).toBe(1);
    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-1:copy:item-c",
        fanOutOfItemId: "item-b",
        watched: true,
        percentComplete: 95,
      },
    ]);
  });

  it("keeps one row on the survivor when the primary's item goes, carrying what it had accumulated", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    await movie(moviesB.id, "item-c", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // The primary's copy leaves the library: its row goes with it, and the
    // other copy's row stops pointing at it.
    await prisma.mediaItem.delete({ where: { id: "item-b" } });
    expect(await rowsOf(serverId)).toEqual([
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-1:copy:item-c",
        fanOutOfItemId: null,
        watched: true,
        percentComplete: 95,
      },
    ]);

    // Re-delivered with a window-truncated view of the chain.
    archive = new FakeTracearrArchive();
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 12 }));
    await syncTracearrHistory(serverId, { passes: "forward" });

    // One row for the play — the copy's, promoted — still finished.
    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-c", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
    ]);
  });

  it("moves the primary row to a lower-id copy added later, leaving one row per copy", async () => {
    const serverId = await mappedServer("EMBY");
    const libraries = await Promise.all(
      ["A", "B", "C"].map((title) => createTestLibrary(serverId, { type: "MOVIE", title })),
    );
    await movie(libraries[0].id, "item-b", "jf-1");
    await movie(libraries[1].id, "item-c", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1" }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    // A third library over the same folder lists it under a lower id.
    await movie(libraries[2].id, "item-a", "jf-1");
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: null },
      {
        mediaItemId: "item-b",
        sourceEventId: "chain-1:copy:item-b",
        fanOutOfItemId: "item-a",
        watched: true,
        percentComplete: null,
      },
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-1:copy:item-c",
        fanOutOfItemId: "item-a",
        watched: true,
        percentComplete: null,
      },
    ]);
  });

  // A chain re-delivered by the catch-up can be a window-truncated view of a
  // play that was finished (only the in-window segment): a row built from that
  // would read 12% and unwatched. Whichever copy's row is new, it carries what
  // the play has accumulated.
  const truncated = () =>
    play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 12 });
  const finished = { watched: true, percentComplete: 95 };

  it("gives a copy listed later the play's accumulated state, not a truncated re-delivery's", async () => {
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    await movie(moviesB.id, "item-c", "jf-1");
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
      { mediaItemId: "item-c", sourceEventId: "chain-1:copy:item-c", fanOutOfItemId: "item-b", ...finished },
    ]);
  });

  it("keeps the play's state on the old primary when a lower-id copy takes the primary row", async () => {
    const serverId = await mappedServer("EMBY");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    await movie(moviesB.id, "item-a", "jf-1");
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
      { mediaItemId: "item-b", sourceEventId: "chain-1:copy:item-b", fanOutOfItemId: "item-a", ...finished },
    ]);
  });

  // The repair promotes such a row before the walk; when it could not run
  // (it failed, or stopped early), the page write re-delivering the play does,
  // picking the lowest copy row that exists — not the new copy's, which holds
  // none, and would leave the play rebuilt from the truncated record.
  for (const repaired of [true, false]) {
    it(`promotes a surviving copy's row when the primary goes and a lower-id copy arrives${repaired ? "" : ", in the page write if the repair could not run"}`, async () => {
      const serverId = await mappedServer("JELLYFIN");
      const libraries = await Promise.all(
        ["A", "B", "C", "D"].map((title) => createTestLibrary(serverId, { type: "MOVIE", title })),
      );
      await movie(libraries[0].id, "item-b", "jf-1");
      await movie(libraries[1].id, "item-c", "jf-1");
      await movie(libraries[2].id, "item-d", "jf-1");
      archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
      await syncTracearrHistory(serverId, { passes: "backfill" });

      // The primary's copy goes, and a library listing it under a lower id comes.
      await prisma.mediaItem.delete({ where: { id: "item-b" } });
      await movie(libraries[3].id, "item-a", "jf-1");
      archive = new FakeTracearrArchive();
      archive.add(truncated());
      const original = prisma.$queryRawUnsafe.bind(prisma);
      const refused = repaired
        ? undefined
        : vi.spyOn(prisma, "$queryRawUnsafe").mockImplementation((async (sql: string, ...args: unknown[]) => {
            if (sql.includes(`"sourceEventId" LIKE '%:copy:%'`)) throw new Error("orphan read refused");
            return original(sql, ...args);
          }) as typeof prisma.$queryRawUnsafe);
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        refused?.mockRestore();
      }
      if (!repaired) {
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          "WatchHistory",
          expect.stringContaining("Could not repair the library-copy rows"),
          { error: expect.stringContaining("orphan read refused") },
        );
      }

      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
        { mediaItemId: "item-c", sourceEventId: "chain-1:copy:item-c", fanOutOfItemId: "item-a", ...finished },
        { mediaItemId: "item-d", sourceEventId: "chain-1:copy:item-d", fanOutOfItemId: "item-a", ...finished },
      ]);
      const history = await expectJson<{ items: unknown[] }>(
        await callRoute(listHistory, { url: "/api/media/history" }),
        200,
      );
      expect(history.items).toHaveLength(1);
    });
  }

  it("drops the copy row a copy holds when the play's primary row moves onto it", async () => {
    // The primary's copy stops listing the item under the play's key while it
    // stays in the library: the primary row moves to the copy, which must not
    // keep its own copy row of the same play beside it — that counts the play
    // twice, and play counts never go back down.
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "jf-1");
    await movie(moviesB.id, "item-c", "jf-1");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
    await syncTracearrHistory(serverId, { passes: "backfill" });

    await prisma.mediaItem.update({ where: { id: "item-b" }, data: { ratingKey: "jf-other" } });
    archive = new FakeTracearrArchive();
    archive.add(truncated());
    await syncTracearrHistory(serverId, { passes: "forward" });

    expect(await rowsOf(serverId)).toEqual([
      { mediaItemId: "item-c", sourceEventId: "chain-1", fanOutOfItemId: null, ...finished },
    ]);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: "item-c" } })).playCount).toBe(1);
  });

  it("still skips a rating key two Plex libraries share — a stale row, not a copy", async () => {
    const serverId = await mappedServer("PLEX");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    await movie(moviesA.id, "item-b", "100");
    await movie(moviesB.id, "item-c", "100");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "100" }));

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(await rowsOf(serverId)).toEqual([]);
  });

  it("still skips a provider id two different files share", async () => {
    // A 4K beside a 1080p: two media, not one item listed twice.
    const serverId = await mappedServer("JELLYFIN");
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    const uhd = await movie(moviesA.id, "item-uhd", "jf-uhd");
    const hd = await movie(moviesB.id, "item-hd", "jf-hd");
    await createTestExternalId(uhd.id, "TMDB", "603");
    await createTestExternalId(hd.id, "TMDB", "603");
    archive.add(play("chain-1", at(-2 * DAY), { rating_key: "gone", tmdb_id: 603 }));

    await syncTracearrHistory(serverId, { passes: "backfill" });

    expect(await rowsOf(serverId)).toEqual([]);
  });

  it("recovers a play onto both copies of a re-added item, counted once", async () => {
    // A walked archive (its newest play recent) on a server where an item two
    // libraries list was just added back: its old play reaches both copies.
    const serverId = await mappedServer("JELLYFIN");
    await prisma.mediaServer.update({ where: { id: serverId }, data: { tracearrBackfillComplete: true } });
    const moviesA = await createTestLibrary(serverId, { type: "MOVIE" });
    const moviesB = await createTestLibrary(serverId, { type: "MOVIE" });
    const other = await movie(moviesA.id, "item-z", "jf-9");
    await prisma.mediaItem.update({ where: { id: other.id }, data: { createdAt: at(-400 * DAY) } });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: other.id,
        mediaServerId: serverId,
        serverUsername: "walter",
        watchedAt: at(-60 * 60 * 1000),
        source: "TRACEARR",
        sourceEventId: "recent",
        watched: true,
        state: "stopped",
      },
    });
    for (const [library, id] of [
      [moviesA, "item-b"],
      [moviesB, "item-c"],
    ] as const) {
      await movie(library.id, id, "jf-1");
      await prisma.mediaItem.update({ where: { id }, data: { createdAt: at(-DAY) } });
    }
    archive.add(play("chain-old", at(-30 * DAY), { rating_key: "jf-1" }));

    const result = await recoverHistoryForNewItems(serverId);

    // One play, asked about through either copy: two new rows (what the
    // caller reconciles and notifies pages for), logged as one play.
    expect(result.imported).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(
      "WatchHistory",
      expect.stringContaining("imported 1 new play(s) (1 already stored)"),
    );
    expect((await rowsOf(serverId)).filter((row) => row.mediaItemId !== "item-z")).toEqual([
      { mediaItemId: "item-b", sourceEventId: "chain-old", fanOutOfItemId: null, watched: true, percentComplete: null },
      {
        mediaItemId: "item-c",
        sourceEventId: "chain-old:copy:item-c",
        fanOutOfItemId: "item-b",
        watched: true,
        percentComplete: null,
      },
    ]);
    for (const id of ["item-b", "item-c"]) {
      expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).lastPlayedAt).toEqual(at(-30 * DAY));
    }
    // Both answered: a play resolved to each — neither is asked again.
    m.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(serverId);
    expect(m.getHistoryForItem).not.toHaveBeenCalled();
  });

  // Nothing writes an archived play again — the catch-up re-reads an hour,
  // the archive walk runs once — so a copy listed after its plays were
  // imported, or a deleted copy that held their primary rows, is put right
  // before every import run walks (`repairLibraryCopyRows`).
  describe("the stored plays, repaired before each import run", () => {
    const HOUR = 60 * 60 * 1000;

    /** A statement that writes rows. */
    const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

    /** The search for missing copy rows (`MISSING_COPY_ROWS_SQL`). */
    const isSearch = (sql: string) => sql.includes("WITH copies AS");

    /** The refresh of WatchHistory's statistics ahead of a large repair's writes. */
    const isAnalyse = (sql: string) => /^\s*ANALYZE\b/i.test(sql);

    /** The nested-loop, statement-timeout and lock-timeout settings a statement ran under. */
    type Settings = { sql: string; nestloop: string; timeout: string; lockTimeout: string };

    type RawTx = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;

    /**
     * Records what each interactive `prisma.$transaction` runs while it is on:
     * every raw statement (after `rewrite`, if given), and, for each statement
     * `explain` picks, its plan and what is wrong with it — checked BEFORE it
     * runs (`planProblems`; a plan found wrong is refused, never run: the one
     * this guards against took minutes and gigabytes), then by row counts
     * once it has run (`growthProblems`, through EXPLAIN ANALYZE). For each
     * statement `setting` picks, the nested-loop, statement-timeout and
     * lock-timeout settings in force when it ran (`settingsOf`). For each
     * statement `visits` picks, the most rows any one node of its plan read
     * (`mostRowsRead`), from an EXPLAIN ANALYZE inside a savepoint rolled
     * back before the statement itself runs, so a write is not applied twice.
     */
    function recordTransactions(
      pick: {
        explain?: (sql: string) => boolean;
        setting?: (sql: string) => boolean;
        visits?: (sql: string) => boolean;
        rewrite?: (sql: string) => string;
      } = {},
    ) {
      const runs: Array<{
        statements: string[];
        plans: unknown[];
        problems: string[];
        settings: Settings[];
        visits: Array<{ sql: string; rows: number }>;
      }> = [];
      const original = prisma.$transaction.bind(prisma) as unknown as (
        fn: unknown,
        options?: unknown,
      ) => Promise<unknown>;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
        fn: unknown,
        options?: unknown,
      ) => {
        if (typeof fn !== "function") return original(fn, options);
        const run = {
          statements: [] as string[],
          plans: [] as unknown[],
          problems: [] as string[],
          settings: [] as Settings[],
          visits: [] as Array<{ sql: string; rows: number }>,
        };
        runs.push(run);
        return original(async (tx: RawTx) => {
          const recorded =
            (method: keyof RawTx) =>
            async (sql: string, ...args: unknown[]) => {
              const text = pick.rewrite ? pick.rewrite(sql) : sql;
              run.statements.push(text);
              if (pick.explain?.(text)) {
                const [plan] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
                  `EXPLAIN (FORMAT JSON) ${text}`,
                  ...args,
                );
                run.plans.push(plan["QUERY PLAN"]);
                const problems = planProblems(plan["QUERY PLAN"]);
                if (problems.length > 0) {
                  run.problems.push(...problems);
                  throw new Error(`refused to run the plan: ${problems.join("; ")}`);
                }
                const [analyzed] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
                  `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
                  ...args,
                );
                run.problems.push(...growthProblems(analyzed["QUERY PLAN"]));
              }
              if (pick.setting?.(text)) {
                const [row] = await tx.$queryRawUnsafe<
                  Array<{ nestloop: string; timeout: string; lockTimeout: string }>
                >(
                  `SELECT current_setting('enable_nestloop') AS "nestloop",
                          current_setting('statement_timeout') AS "timeout",
                          current_setting('lock_timeout') AS "lockTimeout"`,
                );
                run.settings.push({ sql: text, ...row });
              }
              if (pick.visits?.(text)) {
                await tx.$executeRawUnsafe(`SAVEPOINT visits`);
                try {
                  const [analyzed] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
                    `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
                    ...args,
                  );
                  run.visits.push({ sql: text, rows: mostRowsRead(analyzed["QUERY PLAN"]) });
                } finally {
                  await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT visits`);
                }
              }
              return tx[method](text, ...args);
            };
          const wrapped = new Proxy(tx, {
            get: (target, prop) =>
              prop === "$queryRawUnsafe" || prop === "$executeRawUnsafe"
                ? recorded(prop)
                : Reflect.get(target, prop),
          });
          return (fn as (tx: RawTx) => Promise<unknown>)(wrapped);
        }, options);
      }) as unknown as typeof prisma.$transaction);
      return { runs, restore: () => spy.mockRestore() };
    }

    /** The settings the recorded statements `match` picks ran under, in order. */
    function settingsOf(runs: Array<{ settings: Settings[] }>, match: (sql: string) => boolean) {
      return runs
        .flatMap((run) => run.settings)
        .filter((settings) => match(settings.sql))
        .map(({ nestloop, timeout, lockTimeout }) => ({ nestloop, timeout, lockTimeout }));
    }

    /**
     * What each recorded transaction was, in order, leaving out the import's
     * own: the search for missing copy rows, the refresh of WatchHistory's
     * statistics, or a write under the server row — joined with "+" if one
     * transaction was more than one of them.
     */
    function phases(runs: Array<{ statements: string[] }>): string[] {
      return runs
        .map((run) => {
          const has = (match: (sql: string) => boolean) => run.statements.some(match);
          return [
            has(isSearch) && "search",
            has(isAnalyse) && "analyse",
            has((sql) => sql.includes("FOR NO KEY UPDATE")) && "write",
          ]
            .filter(Boolean)
            .join("+");
        })
        .filter((phase) => phase !== "");
    }

    /** Every node of an `EXPLAIN (FORMAT JSON)` plan. */
    function planNodes(plan: unknown): Array<Record<string, unknown>> {
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) {
          visit(child);
        }
      };
      for (const entry of plan as Array<{ Plan: Record<string, unknown> }>) visit(entry.Plan);
      return nodes;
    }

    /** A join condition keyed on an item, library, rating key or play. */
    const IDENTIFIER = /"(itemId|primaryId|copyId|mediaItemId|libraryId|ratingKey|sourceEventId)"|\.id\b/;

    /**
     * What is wrong with a plan before it runs: a nested loop or a correlated
     * subquery (each reads a table once per row of another — cheap only on
     * statistics, which are missing exactly when the search has the most to
     * do), or a join keyed on no identifier (it pairs rows that do not belong
     * together: on `source` alone, every item's id with every other's).
     */
    function planProblems(plan: unknown): string[] {
      return planNodes(plan).flatMap((node) => {
        if (node["Node Type"] === "Nested Loop") return ["a nested loop"];
        if (node["Parent Relationship"] === "SubPlan") {
          return [`a correlated subquery (${node["Subplan Name"]})`];
        }
        const condition = node["Hash Cond"] ?? node["Merge Cond"];
        if (typeof condition === "string" && !IDENTIFIER.test(condition)) {
          return [`a ${node["Node Type"]} keyed on ${condition}`];
        }
        return [];
      });
    }

    /**
     * The most rows any one node of an analysed plan read, over every loop:
     * those it passed on and those its filters dropped. A nested loop probing
     * a whole server's plays once per outer row shows here as rows times
     * loops; a statement that reads each row at most once stays near the
     * table's size.
     */
    function mostRowsRead(plan: unknown): number {
      return Math.max(
        0,
        ...planNodes(plan).map(
          (node) =>
            (Number(node["Actual Rows"] ?? 0) +
              Number(node["Rows Removed by Filter"] ?? 0) +
              Number(node["Rows Removed by Join Filter"] ?? 0) +
              Number(node["Rows Removed by Index Recheck"] ?? 0)) *
            Number(node["Actual Loops"] ?? 0),
        ),
      );
    }

    /** Rows a node produced, over every loop. */
    const produced = (node: Record<string, unknown>) =>
      Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 0);

    /**
     * What is wrong with a plan once it has run: a join that produced many
     * times more rows than the larger of its inputs. Every join here pairs a
     * row with at most a handful of others (an item's copies, its ids, its
     * plays), so four times its larger input, with a little slack for tiny
     * ones, is a generous bound — and a hundred-fold blowup is far past it.
     */
    function growthProblems(plan: unknown): string[] {
      return planNodes(plan).flatMap((node) => {
        if (!/Join|Nested Loop/.test(String(node["Node Type"]))) return [];
        const inputs = ((node.Plans as Array<Record<string, unknown>> | undefined) ?? []).map(produced);
        const largest = Math.max(0, ...inputs);
        const out = produced(node);
        return out > 4 * largest + 1_000
          ? [`a ${node["Node Type"]} produced ${out} rows from inputs of ${inputs.join(" and ")}`]
          : [];
      });
    }

    /** A server whose archived play of jf-1 is stored on item-b alone, walked to the end. */
    async function walkedServer(type: "JELLYFIN" | "EMBY" | "PLEX" = "JELLYFIN") {
      const serverId = await mappedServer(type);
      const movies = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies" });
      await movie(movies.id, "item-b", "jf-1");
      archive.add(play("chain-1", at(-30 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }));
      await syncTracearrHistory(serverId, { passes: "backfill" });
      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
      ]);
      // From here on the archive re-delivers nothing.
      archive = new FakeTracearrArchive();
      return serverId;
    }

    for (const type of ["JELLYFIN", "EMBY"] as const) {
      it(`files a stored play against a copy listed since, at the next ${type} import`, async () => {
        const serverId = await walkedServer(type);
        // A second library over the same folder: it lists the item too.
        const more = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies (all)" });
        await movie(more.id, "item-c", "jf-1");

        await syncTracearrHistory(serverId, { passes: "forward" });

        expect(await rowsOf(serverId)).toEqual([
          { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
          {
            mediaItemId: "item-c",
            sourceEventId: "chain-1:copy:item-c",
            fanOutOfItemId: "item-b",
            watched: true,
            percentComplete: 95,
          },
        ]);
        // The copy reads as watched — the walk wrote nothing, so the repair
        // reconciled it.
        expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id: "item-c" } })).toMatchObject({
          playCount: 1,
          lastPlayedAt: at(-30 * DAY),
        });
        const history = await expectJson<{ pagination: { totalCount: number } }>(
          await callRoute(listHistory, { url: "/api/media/history" }),
          200,
        );
        expect(history.pagination.totalCount).toBe(1);
        const status = await expectJson<{ servers: Array<{ importedCount: number }> }>(
          await callRoute(importStatus, { url: "/api/integrations/tracearr/status" }),
          200,
        );
        expect(status.servers[0].importedCount).toBe(1);

        // Repaired once: the next run finds every row in place.
        await syncTracearrHistory(serverId, { passes: "forward" });
        expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(2);
        expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: "item-c" } })).playCount).toBe(1);
      });
    }

    it("re-points the surviving copies when the copy holding a play's primary row is deleted", async () => {
      const serverId = await mappedServer("JELLYFIN");
      const libraries = await Promise.all(
        ["A", "B", "C"].map((title) => createTestLibrary(serverId, { type: "MOVIE", title })),
      );
      await movie(libraries[0].id, "item-a", "jf-1");
      await movie(libraries[1].id, "item-b", "jf-1");
      await movie(libraries[2].id, "item-c", "jf-1");
      await movie(libraries[0].id, "item-z", "jf-9");
      archive.add(
        play("old-1", at(-90 * DAY), { rating_key: "jf-1", watched: true, percent_complete: 95 }),
        play("recent-z", at(-2 * HOUR), { rating_key: "jf-9" }),
      );
      await syncTracearrHistory(serverId, { passes: "backfill" });

      // The copy holding the primary row goes (a stale-item purge of one item):
      // `SetNull` leaves both other copies' rows pointing at nothing.
      await prisma.mediaItem.delete({ where: { id: "item-a" } });
      archive = new FakeTracearrArchive();
      archive.add(play("recent-z", at(-2 * HOUR), { rating_key: "jf-9" }));

      await syncTracearrHistory(serverId, { passes: "forward" });

      // The lowest survivor holds the primary row, the other points at it.
      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-b", sourceEventId: "old-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
        {
          mediaItemId: "item-c",
          sourceEventId: "old-1:copy:item-c",
          fanOutOfItemId: "item-b",
          watched: true,
          percentComplete: 95,
        },
        { mediaItemId: "item-z", sourceEventId: "recent-z", fanOutOfItemId: null, watched: true, percentComplete: null },
      ]);
      const history = await expectJson<{ pagination: { totalCount: number } }>(
        await callRoute(listHistory, { url: "/api/media/history" }),
        200,
      );
      expect(history.pagination.totalCount).toBe(2);
      const status = await expectJson<{ servers: Array<{ importedCount: number }> }>(
        await callRoute(importStatus, { url: "/api/integrations/tracearr/status" }),
        200,
      );
      expect(status.servers[0].importedCount).toBe(2);

      // A later re-delivery of the chain — window-truncated — finds those rows:
      // merged into them, nothing added, nothing regressed.
      // (A restarted walk re-delivers it.)
      archive.add(play("old-1", at(-90 * DAY), { rating_key: "jf-1", watched: false, percent_complete: 12 }));
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: false, tracearrBackfillCursorAt: at(0) },
      });
      expect((await syncTracearrHistory(serverId, { passes: "backfill" })).count).toBe(2);
      expect((await rowsOf(serverId)).filter((row) => row.mediaItemId !== "item-z")).toEqual([
        { mediaItemId: "item-b", sourceEventId: "old-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
        {
          mediaItemId: "item-c",
          sourceEventId: "old-1:copy:item-c",
          fanOutOfItemId: "item-b",
          watched: true,
          percentComplete: 95,
        },
      ]);
      for (const id of ["item-b", "item-c"]) {
        expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).playCount).toBe(1);
      }
    });

    it("files nothing against a copy whose identity contradicts the item's", async () => {
      const serverId = await walkedServer("JELLYFIN");
      await createTestExternalId("item-b", "TMDB", "550");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      await createTestExternalId("item-c", "TMDB", "999");

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await rowsOf(serverId)).map((row) => row.sourceEventId)).toEqual(["chain-1"]);
    });

    it("files nothing against a row of another type under the same rating key", async () => {
      const serverId = await walkedServer("JELLYFIN");
      const tv = await createTestLibrary(serverId, { type: "SERIES" });
      const episode = await createTestMediaItem(tv.id, {
        ratingKey: "jf-1",
        type: "SERIES",
        title: "Pilot",
        parentTitle: "The Show",
        seasonNumber: 1,
        episodeNumber: 1,
      });

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect(await prisma.watchHistory.count({ where: { mediaItemId: episode.id } })).toBe(0);
    });

    it("drops a pointer-less copy row on the item that holds its play's primary row", async () => {
      // Two rows of one play on one item count it twice there.
      const serverId = await walkedServer("JELLYFIN");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      await syncTracearrHistory(serverId, { passes: "forward" });
      // Left behind on item-b by a writer that no longer exists.
      const primary = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "chain-1" } });
      await prisma.watchHistory.create({
        data: {
          mediaItemId: "item-b",
          mediaServerId: serverId,
          serverUsername: "walter",
          watchedAt: primary.watchedAt,
          source: "TRACEARR",
          sourceEventId: "chain-1:copy:item-b",
          watched: true,
          state: "stopped",
        },
      });

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-b", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
        {
          mediaItemId: "item-c",
          sourceEventId: "chain-1:copy:item-c",
          fanOutOfItemId: "item-b",
          watched: true,
          percentComplete: 95,
        },
      ]);
    });

    it("leaves a Plex server's second row under one rating key without the play", async () => {
      // A stale row on Plex, not a copy: the join never files a play there.
      const serverId = await walkedServer("PLEX");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");

      await syncTracearrHistory(serverId, { passes: "forward" });

      expect((await rowsOf(serverId)).map((row) => row.sourceEventId)).toEqual(["chain-1"]);
    });

    it("repairs nothing once the mapping has changed under the run", async () => {
      const serverId = await walkedServer("JELLYFIN");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      // An unlink and re-link lands between the run's read and the repair.
      const original = prisma.$queryRawUnsafe.bind(prisma);
      const spy = vi.spyOn(prisma, "$queryRawUnsafe").mockImplementation((async (sql: string, ...args: unknown[]) => {
        if (sql.includes("HAVING COUNT(*) > 1")) {
          await prisma.mediaServer.update({
            where: { id: serverId },
            data: { tracearrMappingVersion: { increment: 1 } },
          });
        }
        return original(sql, ...args);
      }) as typeof prisma.$queryRawUnsafe);
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        spy.mockRestore();
      }

      expect((await rowsOf(serverId)).map((row) => row.sourceEventId)).toEqual(["chain-1"]);
    });

    it("waits for a page write of the server's plays in flight before it repairs", async () => {
      // A write moving a play's primary row onto the item this repair is giving
      // a copy row would leave the item two rows of the play. Page writes hold
      // the server row FOR SHARE; the repair takes it FOR NO KEY UPDATE.
      const serverId = await walkedServer("JELLYFIN");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => (held = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const writer = prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "MediaServer" WHERE "id" = $1 FOR SHARE`, serverId);
        held();
        await released;
      });
      await isHeld;

      const run = syncTracearrHistory(serverId, { passes: "forward" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await prisma.watchHistory.count({ where: { mediaItemId: "item-c" } })).toBe(0);

      release();
      await writer;
      await run;
      expect(await prisma.watchHistory.count({ where: { mediaItemId: "item-c" } })).toBe(1);
    });

    /** Run `between` once, right after the repair's search for missing copy rows. */
    function afterMissingRead(between: () => Promise<void>) {
      const original = prisma.$transaction.bind(prisma) as unknown as (
        fn: unknown,
        options?: unknown,
      ) => Promise<unknown>;
      let done = false;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
        fn: unknown,
        options?: unknown,
      ) => {
        const result = await original(fn, options);
        if (!done) {
          done = true;
          await between();
        }
        return result;
      }) as unknown as typeof prisma.$transaction);
      return () => spy.mockRestore();
    }

    it("writes no copy row onto an item a page write has since given the play's primary row", async () => {
      // The search takes no lock, and a page write can land before the repair
      // writes: here one re-delivering the play onto a copy listed since, with
      // a lower id, which takes the primary row and gives item-b a copy row.
      const serverId = await walkedServer("JELLYFIN");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-a", "jf-1");
      const restore = afterMissingRead(async () => {
        const primary = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "chain-1" } });
        await prisma.watchHistory.update({ where: { id: primary.id }, data: { mediaItemId: "item-a" } });
        await prisma.watchHistory.create({
          data: {
            mediaItemId: "item-b",
            fanOutOfItemId: "item-a",
            mediaServerId: serverId,
            serverUsername: "walter",
            watchedAt: primary.watchedAt,
            source: "TRACEARR",
            sourceEventId: "chain-1:copy:item-b",
            watched: true,
            state: "stopped",
            percentComplete: 95,
          },
        });
      });
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        restore();
      }

      expect(await rowsOf(serverId)).toEqual([
        { mediaItemId: "item-a", sourceEventId: "chain-1", fanOutOfItemId: null, watched: true, percentComplete: 95 },
        {
          mediaItemId: "item-b",
          sourceEventId: "chain-1:copy:item-b",
          fanOutOfItemId: "item-a",
          watched: true,
          percentComplete: 95,
        },
      ]);
    });

    it("skips a copy deleted since the search, and still fills the others", async () => {
      const serverId = await walkedServer("JELLYFIN");
      const second = await createTestLibrary(serverId, { type: "MOVIE" });
      const third = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(second.id, "item-c", "jf-1");
      await movie(third.id, "item-d", "jf-1");
      const restore = afterMissingRead(async () => {
        await prisma.mediaItem.delete({ where: { id: "item-c" } });
      });
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        restore();
      }

      expect((await rowsOf(serverId)).map((row) => [row.mediaItemId, row.sourceEventId, row.fanOutOfItemId])).toEqual([
        ["item-b", "chain-1", null],
        ["item-d", "chain-1:copy:item-d", "item-b"],
      ]);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    /**
     * A walked server holding 10,001 plays on item-b and a copy, item-c, listed
     * since: two transactions' worth of copy rows to add.
     */
    async function largeRepair() {
      const serverId = await walkedServer("JELLYFIN");
      await prisma.$executeRawUnsafe(
        `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state","createdAt")
         SELECT 'bulk-' || g, 'item-b', $1, 'walter', $2::timestamp - (g || ' minutes')::interval, 'TRACEARR', 'bulk-' || g, true, 'stopped', now()
           FROM generate_series(1, 10000) g`,
        serverId,
        at(-30 * DAY),
      );
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      return serverId;
    }
    const onCopy = () => prisma.watchHistory.count({ where: { mediaItemId: "item-c" } });

    it("writes a large repair a transaction at a time, stopping at the run's limits and finishing at the next run", async () => {
      const serverId = await largeRepair();

      // A cancelled run starts nothing.
      const cancelled = new AbortController();
      cancelled.abort();
      await syncTracearrHistory(serverId, { passes: "forward", signal: cancelled.signal });
      expect(await onCopy()).toBe(0);

      // A sync waiting for the queue: one transaction, then the run moves on.
      await syncTracearrHistory(serverId, { passes: "forward", yieldTo: () => true });
      expect(await onCopy()).toBe(10_000);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("stopped early, the next import does the rest"),
      );

      await syncTracearrHistory(serverId, { passes: "forward" });
      expect(await onCopy()).toBe(10_001);
      expect(await prisma.watchHistory.count({ where: { mediaItemId: "item-b" } })).toBe(10_001);
    }, 60_000);

    it("settles what it committed when a later transaction fails", async () => {
      // The rows of the first transaction stand; the copy must read as watched
      // now, not after whatever reconciles next.
      const serverId = await largeRepair();
      // The first 10,000 rows commit; the transaction writing the rest fails
      // at its first statement.
      let writes = 0;
      const recorder = recordTransactions({
        rewrite: (sql) => (sql.includes("FOR NO KEY UPDATE") && ++writes === 2 ? "SELECT connection_lost()" : sql),
      });
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        recorder.restore();
      }

      expect(await onCopy()).toBe(10_000);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Could not repair the library-copy rows"),
        expect.anything(),
      );
      expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: "item-c" } })).playCount).toBeGreaterThan(0);

      await syncTracearrHistory(serverId, { passes: "forward" });
      expect(await onCopy()).toBe(10_001);
    }, 60_000);

    it("costs one read without a copy group, and takes no lock while every row is in place", async () => {
      const serverId = await walkedServer("JELLYFIN");
      const queries = vi.spyOn(prisma, "$queryRawUnsafe");
      const recorder = recordTransactions();
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
        const sqls = queries.mock.calls.map(([sql]) => String(sql));
        expect(sqls.filter((sql) => sql.includes("HAVING COUNT(*) > 1"))).toHaveLength(1);
        expect(sqls.some((sql) => sql.includes(":copy:"))).toBe(false);
        expect(recorder.runs).toEqual([]);

        // A copy, repaired once under the lock; after that, reads only.
        const more = await createTestLibrary(serverId, { type: "MOVIE" });
        await movie(more.id, "item-c", "jf-1");
        await syncTracearrHistory(serverId, { passes: "forward" });
        const locked = recorder.runs.filter((run) =>
          run.statements.some((sql) => sql.includes("FOR NO KEY UPDATE")),
        );
        expect(locked).toHaveLength(1);
        expect(locked[0].statements.some((sql) => WRITE.test(sql))).toBe(true);

        recorder.runs.length = 0;
        await syncTracearrHistory(serverId, { passes: "forward" });
        expect(recorder.runs).toHaveLength(1);
        const statements = recorder.runs[0].statements;
        expect(statements.some((sql) => sql.includes("FOR NO KEY UPDATE"))).toBe(false);
        expect(statements.filter((sql) => WRITE.test(sql))).toEqual([]);
      } finally {
        queries.mockRestore();
        recorder.restore();
      }
    });

    it("plans its search without a nested loop where one would be cheapest, and writes with the planner's own settings", async () => {
      // A nested loop is only as cheap as the statistics behind it, and they
      // are missing right after a restore or a large sync — exactly when the
      // search has the most to find. Planned as one, it ran past five minutes
      // on 20,000 copy pairs. Over a handful of rows a nested loop IS the
      // cheapest plan, so this is where one shows up unless they are off.
      // The writes reach each row by index, which only a nested loop does.
      const serverId = await walkedServer("JELLYFIN");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      const recorder = recordTransactions({
        explain: isSearch,
        setting: (sql) => isSearch(sql) || WRITE.test(sql),
      });
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        recorder.restore();
      }

      expect(recorder.runs.flatMap((run) => run.problems)).toEqual([]);
      expect(recorder.runs.flatMap((run) => run.plans)).toHaveLength(1);
      expect(settingsOf(recorder.runs, isSearch)).toEqual([{ nestloop: "off", timeout: "1min", lockTimeout: "0" }]);
      const writes = settingsOf(recorder.runs, (sql) => WRITE.test(sql));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes).toEqual(writes.map(() => ({ nestloop: "on", timeout: "0", lockTimeout: "0" })));
      expect(await prisma.watchHistory.count({ where: { mediaItemId: "item-c" } })).toBe(1);
    });

    /**
     * A walked Jellyfin server whose second library lists every one of its
     * `items` films — each with a TMDB id and one stored play, filed against
     * the first library's copy — and holds none of their plays yet. Analysed,
     * as an established install's tables are.
     */
    async function listedTwice(items: number) {
      const serverId = await mappedServer("JELLYFIN");
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true, watchHistorySyncedAt: at(-DAY) },
      });
      const first = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies" });
      const second = await createTestLibrary(serverId, { type: "MOVIE", title: "Movies (all)" });
      for (const [libraryId, prefix] of [
        [first.id, "a"],
        [second.id, "b"],
      ] as const) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "MediaItem" ("id","libraryId","ratingKey","title","type","createdAt","updatedAt")
           SELECT '${prefix}-' || g, $1, 'jf-' || g, 'Film ' || g, 'MOVIE', $3::timestamp, $3::timestamp
             FROM generate_series(1, $2::int) g`,
          libraryId,
          items,
          at(-60 * DAY),
        );
      }
      await prisma.$executeRawUnsafe(
        `INSERT INTO "MediaItemExternalId" ("id","mediaItemId","source","externalId")
         SELECT 'e-' || mi."id", mi."id", 'TMDB', split_part(mi."id", '-', 2) FROM "MediaItem" mi`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state")
         SELECT 'w-' || g, 'a-' || g, $1, 'walter', $3::timestamp - (g || ' minutes')::interval,
                'TRACEARR', 'chain-' || g, true, 'stopped'
           FROM generate_series(1, $2::int) g`,
        serverId,
        items,
        at(-30 * DAY),
      );
      await prisma.$executeRawUnsafe(`ANALYZE`);
      return serverId;
    }

    it("searches 5,000 films listed twice joining only on identifiers, no join outgrowing its inputs", async () => {
      // With statistics, the planner joined the primaries' ids to the copies'
      // on `source` alone — every film with a TMDB id against every other, a
      // hundred million rows here — before matching them to pairs: 45 seconds
      // and 6 GB of temporary files. On these analysed tables no join may be
      // keyed on anything but an identifier, produce many times the rows it
      // was given, or be a nested loop or a correlated subquery — in the
      // search that fills the copies, and in the one that then finds every
      // row in place. The writes run with the planner's own settings and no
      // timeout.
      const serverId = await listedTwice(5_000);
      const recorder = recordTransactions({
        explain: isSearch,
        setting: (sql) => isSearch(sql) || WRITE.test(sql),
      });
      let filled = 0;
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
        filled = await prisma.watchHistory.count({ where: { fanOutOfItemId: { not: null } } });
        await prisma.$executeRawUnsafe(`ANALYZE`);
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        recorder.restore();
      }

      expect(recorder.runs.flatMap((run) => run.problems)).toEqual([]);
      expect(filled).toBe(5_000);
      expect(recorder.runs.flatMap((run) => run.plans)).toHaveLength(2);
      expect(settingsOf(recorder.runs, isSearch)).toEqual([
        { nestloop: "off", timeout: "1min", lockTimeout: "0" },
        { nestloop: "off", timeout: "1min", lockTimeout: "0" },
      ]);
      const writes = settingsOf(recorder.runs, (sql) => WRITE.test(sql));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes).toEqual(writes.map(() => ({ nestloop: "on", timeout: "0", lockTimeout: "0" })));
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    }, 60_000);

    it("gives up with a WARN when its search runs past the timeout, and the import goes on", async () => {
      // Nothing else stops a statement once it runs, and the search runs at
      // the start of every import run, most of them jobs on the serial queue.
      // Here it waits on a lock, under a timeout shortened from a minute so
      // the test is quick.
      const serverId = await walkedServer("JELLYFIN");
      const more = await createTestLibrary(serverId, { type: "MOVIE" });
      await movie(more.id, "item-c", "jf-1");
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => (held = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const locker = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`LOCK TABLE "MediaItemExternalId" IN ACCESS EXCLUSIVE MODE`);
          held();
          await released;
        },
        { timeout: 30_000 },
      );
      await isHeld;

      const recorder = recordTransactions({
        rewrite: (sql) => sql.replace(/statement_timeout = \d+/, "statement_timeout = 200"),
      });
      const gaveUp = () =>
        vi.mocked(logger.warn).mock.calls.some(([, message]) => String(message).includes("Could not repair"));
      let run: ReturnType<typeof syncTracearrHistory>;
      try {
        run = syncTracearrHistory(serverId, { passes: "forward" });
        for (let waited = 0; waited < 5_000 && !gaveUp(); waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        release();
        await locker;
        recorder.restore();
      }
      const result = await run;

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Could not repair the library-copy rows"),
        { error: expect.stringContaining("statement timeout") },
      );
      expect(result.failed).toBeUndefined();
      expect(await prisma.watchHistory.count({ where: { mediaItemId: "item-c" } })).toBe(0);

      await syncTracearrHistory(serverId, { passes: "forward" });
      expect(await prisma.watchHistory.count({ where: { mediaItemId: "item-c" } })).toBe(1);
    });

    // With WatchHistory's statistics missing or taken before this server's
    // plays were stored, every write statement reads all of the server's
    // plays, one statement per 176 rows: filling 100,000 copy rows took over a
    // minute and 9 GB of temporary files. A repair that has found 1,000
    // missing rows refreshes them first, once, in a transaction of its own.
    it("analyses WatchHistory once before filling 1,000 copy rows, between the search and the writes", async () => {
      const serverId = await listedTwice(1_000);
      const recorder = recordTransactions({ setting: isAnalyse });
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        recorder.restore();
      }

      expect(phases(recorder.runs)).toEqual(["search", "analyse", "write", "search"]);
      expect(settingsOf(recorder.runs, isAnalyse)).toEqual([{ nestloop: "on", timeout: "1min", lockTimeout: "5s" }]);
      expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: { not: null } } })).toBe(1_000);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    it("fills 999 copy rows without analysing", async () => {
      const serverId = await listedTwice(999);
      const recorder = recordTransactions();
      try {
        await syncTracearrHistory(serverId, { passes: "forward" });
      } finally {
        recorder.restore();
      }

      expect(phases(recorder.runs)).toEqual(["search", "write"]);
      expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: { not: null } } })).toBe(999);
    });

    /**
     * A walked Jellyfin server with three libraries over one folder, each
     * listing `items` films, whose plays lost their primary rows with the copy
     * that held them: each play keeps a pointer-less copy row on the second
     * and third libraries' copies (`b-…`, `c-…`), and the first library's copy
     * (`a-…`), listed since, holds none.
     */
    async function orphaned(items: number) {
      const serverId = await mappedServer("JELLYFIN");
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true, watchHistorySyncedAt: at(-DAY) },
      });
      for (const prefix of ["a", "b", "c"]) {
        const library = await createTestLibrary(serverId, { type: "MOVIE", title: `Movies ${prefix}` });
        await prisma.$executeRawUnsafe(
          `INSERT INTO "MediaItem" ("id","libraryId","ratingKey","title","type","createdAt","updatedAt")
           SELECT '${prefix}-' || g, $1, 'jf-' || g, 'Film ' || g, 'MOVIE', $3::timestamp, $3::timestamp
             FROM generate_series(1, $2::int) g`,
          library.id,
          items,
          at(-60 * DAY),
        );
      }
      for (const prefix of ["b", "c"]) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state")
           SELECT 'w-${prefix}-' || g, '${prefix}-' || g, $1, 'walter', $3::timestamp - (g || ' minutes')::interval,
                  'TRACEARR', 'chain-' || g || ':copy:${prefix}-' || g, true, 'stopped'
             FROM generate_series(1, $2::int) g`,
          serverId,
          items,
          at(-30 * DAY),
        );
      }
      return serverId;
    }

    // Repairing orphaned rows writes like a fill — a pass over the server's
    // plays per statement at worst, re-pointing 176 rows a statement — so it
    // refreshes the statistics past the same 1,000 rows, and once a run.
    for (const [items, expected, name] of [
      [10, ["write", "search", "write", "search"], "repairs 20 orphaned copy rows and fills 10 without analysing"],
      [
        1_000,
        ["analyse", "write", "search", "write", "search"],
        "analyses WatchHistory once, before repairing 2,000 orphaned copy rows, not again before filling 1,000",
      ],
    ] as const) {
      it(name, async () => {
        const serverId = await orphaned(items);
        const recorder = recordTransactions();
        try {
          await syncTracearrHistory(serverId, { passes: "forward" });
          await syncTracearrHistory(serverId, { passes: "forward" });
        } finally {
          recorder.restore();
        }

        expect(phases(recorder.runs)).toEqual(expected);
        // Each play's primary row on its b- copy, with both other copies' rows
        // pointing at it.
        expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: null } })).toBe(items);
        expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: { startsWith: "b-" } } })).toBe(2 * items);
      });
    }

    it("writes anyway, with a WARN, when WatchHistory cannot be analysed", async () => {
      // A VACUUM holds the lock ANALYZE needs; the writes do not need it. The
      // wait is shortened from five seconds so the test is quick.
      const serverId = await listedTwice(1_000);
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => (held = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const vacuum = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`LOCK TABLE "WatchHistory" IN SHARE UPDATE EXCLUSIVE MODE`);
          held();
          await released;
        },
        { timeout: 30_000 },
      );
      await isHeld;

      const recorder = recordTransactions({
        rewrite: (sql) => sql.replace(/lock_timeout = \d+/, "lock_timeout = 100"),
      });
      const warned = () =>
        vi.mocked(logger.warn).mock.calls.some(([, message]) => String(message).includes("Could not refresh"));
      let run: ReturnType<typeof syncTracearrHistory>;
      try {
        run = syncTracearrHistory(serverId, { passes: "forward" });
        for (let waited = 0; waited < 5_000 && !warned(); waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        release();
        await vacuum;
        recorder.restore();
      }
      const result = await run;

      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Could not refresh WatchHistory's statistics"),
        { error: expect.stringContaining("lock timeout") },
      );
      expect(result.failed).toBeUndefined();
      expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: { not: null } } })).toBe(1_000);
    });

    it("promotes re-delivered plays' copy rows reading the server's plays at most once a statement, whatever the statistics", async () => {
      // A page write promotes the copy row of a play whose primary row went
      // with its copy (`settleLibraryCopyRows`). When that was one UPDATE,
      // statistics taken while WatchHistory held only another server's plays
      // made the planner take this server's plays for one row and read all of
      // them once per promoted row: 190,100 rows here, for 100 plays among
      // 1,900. Autovacuum is held off so the statistics stay that stale.
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchHistory" SET (autovacuum_enabled = false)`);
      try {
        const other = await createTestServer(userId, { type: "PLEX" });
        const elsewhere = await createTestLibrary(other.id, { type: "MOVIE" });
        await prisma.$executeRawUnsafe(
          `INSERT INTO "MediaItem" ("id","libraryId","ratingKey","title","type","updatedAt")
           SELECT 'o-' || g, $1, 'o-' || g, 'Other ' || g, 'MOVIE', now() FROM generate_series(1, 1000) g`,
          elsewhere.id,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state")
           SELECT 'o-' || g, 'o-' || (1 + g % 1000), $1, 'x', $2::timestamp - (g || ' minutes')::interval,
                  'TRACEARR', 'other-' || g, true, 'stopped'
             FROM generate_series(1, 20000) g`,
          other.id,
          at(-60 * DAY),
        );
        await prisma.$executeRawUnsafe(`ANALYZE "WatchHistory"`);

        // One library, so the repair finds no copies and leaves the page write
        // to do the promoting: 100 plays each kept on a copy row of the copy
        // that is left, among 1,800 other plays of the server.
        const serverId = await mappedServer("JELLYFIN");
        const movies = await createTestLibrary(serverId, { type: "MOVIE" });
        await prisma.$executeRawUnsafe(
          `INSERT INTO "MediaItem" ("id","libraryId","ratingKey","title","type","createdAt","updatedAt")
           SELECT 'b-' || g, $1, 'jf-' || g, 'Film ' || g, 'MOVIE', $2::timestamp, $2::timestamp
             FROM generate_series(1, 100) g`,
          movies.id,
          at(-60 * DAY),
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state")
           SELECT 'x-' || g || '-' || n, 'b-' || g, $1, 'walter', $2::timestamp - (n || ' hours')::interval,
                  'TRACEARR', 'x-' || g || '-' || n, true, 'stopped'
             FROM generate_series(1, 100) g, generate_series(1, 18) n`,
          serverId,
          at(-30 * DAY),
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state","percentComplete")
           SELECT 'w-' || g, 'b-' || g, $1, 'walter', $2::timestamp + (g || ' seconds')::interval,
                  'TRACEARR', 'chain-' || g || ':copy:b-' || g, true, 'stopped', 95
             FROM generate_series(1, 100) g`,
          serverId,
          at(-2 * DAY),
        );
        for (let g = 1; g <= 100; g++) {
          archive.add(
            play(`chain-${g}`, new Date(at(-2 * DAY).getTime() + g * 1000), {
              rating_key: `jf-${g}`,
              watched: true,
              percent_complete: 95,
            }),
          );
        }

        const recorder = recordTransactions({
          visits: (sql) => /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql) && sql.includes(`"WatchHistory"`),
        });
        try {
          await syncTracearrHistory(serverId, { passes: "forward" });
        } finally {
          recorder.restore();
        }

        const tableRows = await prisma.watchHistory.count();
        const visits = recorder.runs.flatMap((run) => run.visits);
        expect(visits.length).toBeGreaterThan(0);
        expect(visits.filter((visit) => visit.rows > 2 * tableRows + 1_000)).toEqual([]);
        expect(
          await prisma.watchHistory.count({
            where: { mediaServerId: serverId, sourceEventId: { startsWith: "chain-" }, fanOutOfItemId: null },
          }),
        ).toBe(100);
        expect(await prisma.watchHistory.count({ where: { sourceEventId: { contains: ":copy:" } } })).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "WatchHistory" RESET (autovacuum_enabled)`);
      }
    });
  });
});
