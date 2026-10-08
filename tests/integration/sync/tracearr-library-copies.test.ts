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
import { addTracearrInstance, answerFrom, storeTracearrPlay, tracearr } from "./tracearr-import-kit";

// A Tracearr-mapped Jellyfin/Emby server whose item two libraries list (one
// item, one id, two rows): a play is filed against every copy, every row but
// the primary's naming it through `fanOutOfItemId`, so lists show it once.
// Skipped as "ambiguous", both copies read as never watched.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
vi.mock("@/lib/tracearr/tracearr-client", async () => (await import("./tracearr-import-kit")).clientModule(100));
vi.mock("@/lib/cache/memory-cache", () => {
  const cache = { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {}, clear: () => {} };
  const getOrSet = async (_key: string, compute: () => Promise<unknown>) => compute();
  return { MemoryCache: vi.fn(() => ({ ...cache, getOrSet })), appCache: { ...cache, getOrSet } };
});

import { logger } from "@/lib/logger";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { recoverHistoryForNewItems, resetRecoveryAnswers } from "@/lib/sync/tracearr-backfill-additions";
import { GET as listHistory } from "@/app/api/media/history/route";
import { GET as listSeriesHistory } from "@/app/api/media/series/watch-history/route";
import { GET as importStatus } from "@/app/api/integrations/tracearr/status/route";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// One base: a play's time and the expectation built from it must be the same instant.
const NOW = Date.now();
const at = (offset: number) => new Date(NOW + offset);
const FINISHED = { watched: true, percent_complete: 95 };
/** A re-delivery of a finished play's chain, window-truncated to its last segment. */
const TRUNCATED = { watched: false, percent_complete: 12 };
const chain1 = (extra: Parameters<typeof play>[2] = {}) => play("chain-1", at(-2 * DAY), { rating_key: "jf-1", ...extra });

type ServerType = "JELLYFIN" | "EMBY" | "PLEX";
let archive: FakeTracearrArchive;
let userId: string;

async function mappedServer(type: ServerType) {
  return (await createTestServer(userId, { type, tracearrServerId: TRACEARR_SERVER_ID })).id;
}

/** A movie with a chosen id (so which copy is lowest is known), in a library of its own. */
async function copy(serverId: string, id: string, ratingKey = "jf-1") {
  const library = await createTestLibrary(serverId, { type: "MOVIE" });
  const item = await createTestMediaItem(library.id, { ratingKey, type: "MOVIE", title: "Shared Film" });
  return prisma.mediaItem.update({ where: { id: item.id }, data: { id } });
}

/** A mapped server listing the item jf-1 once per id, each in a library of its own. */
async function copiesOn(type: ServerType, ...ids: string[]) {
  const serverId = await mappedServer(type);
  for (const id of ids) await copy(serverId, id);
  return serverId;
}

/** Every row of the server as [item, sourceEventId, fanOutOfItemId, watched, percentComplete]. */
async function rowsOf(serverId: string) {
  const rows = await prisma.watchHistory.findMany({ where: { mediaServerId: serverId }, orderBy: { mediaItemId: "asc" } });
  return rows.map((r) => [r.mediaItemId, r.sourceEventId, r.fanOutOfItemId, r.watched, r.percentComplete]);
}

const backfill = (serverId: string) => syncTracearrHistory(serverId, { passes: "backfill" });
const forward = (serverId: string, options: { signal?: AbortSignal; yieldTo?: () => boolean } = {}) =>
  syncTracearrHistory(serverId, { passes: "forward", ...options });
/** From here on the archive delivers only `records`. */
function redeliver(...records: ReturnType<typeof play>[]) {
  archive = new FakeTracearrArchive();
  archive.add(...records);
}
const playCountOf = async (id: string) => (await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).playCount;
const plays = () =>
  callRoute(listHistory, { url: "/api/media/history" }).then((response) =>
    expectJson<{ items: unknown[]; pagination: { totalCount: number } }>(response, 200),
  );
const importedServer = () =>
  callRoute(importStatus, { url: "/api/integrations/tracearr/status" }).then(
    async (response) =>
      (await expectJson<{ servers: Array<{ importedCount: number; oldestImported: string; newestImported: string }> }>(
        response,
        200,
      )).servers[0],
  );

/** Run `hook` ahead of every raw query whose SQL `matches` (throwing refuses the query). */
function hookRawQuery(matches: (sql: string) => boolean, hook: () => unknown) {
  const original = prisma.$queryRawUnsafe.bind(prisma);
  return vi.spyOn(prisma, "$queryRawUnsafe").mockImplementation((async (sql: string, ...args: unknown[]) => {
    if (matches(sql)) await hook();
    return original(sql, ...args);
  }) as typeof prisma.$queryRawUnsafe);
}

describe("Tracearr plays of an item two Jellyfin/Emby libraries list (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetRecoveryAnswers();
    archive = new FakeTracearrArchive();
    answerFrom(() => archive);
    userId = (await createTestUser()).id;
    await addTracearrInstance(userId);
    setMockSession({ userId, plexToken: "tok", isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it.each(["JELLYFIN", "EMBY"] as const)("files the play against both copies on %s, and lists and counts it once", async (type) => {
    const serverId = await copiesOn(type, "item-b", "item-c");
    archive.add(chain1());
    // A native row from before the mapping: replaced by the import, copies and all.
    await prisma.watchHistory.create({
      data: { mediaItemId: "item-c", mediaServerId: serverId, serverUsername: "walter", watchedAt: at(-9 * DAY) },
    });

    expect(await backfill(serverId)).toMatchObject({ count: 1, backfillPending: false });
    expect(await rowsOf(serverId)).toEqual([
      ["item-b", "chain-1", null, true, null],
      ["item-c", "chain-1:copy:item-c", "item-b", true, null],
    ]);
    for (const id of ["item-b", "item-c"]) {
      expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).toMatchObject({
        playCount: 1,
        lastPlayedAt: at(-2 * DAY),
      });
    }
    const history = await plays();
    expect(history.items).toHaveLength(1);
    expect(history.pagination.totalCount).toBe(1);
    expect(await importedServer()).toMatchObject({
      importedCount: 1,
      oldestImported: at(-2 * DAY).toISOString(),
      newestImported: at(-2 * DAY).toISOString(),
    });
  });

  it("lists an episode's play once on the series route", async () => {
    const serverId = await mappedServer("JELLYFIN");
    for (const title of ["TV", "Kids TV"]) {
      const library = await createTestLibrary(serverId, { type: "SERIES", title });
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

    await backfill(serverId);

    expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(2);
    const series = await expectJson<{ items: unknown[]; pagination: { totalCount: number } }>(
      await callRoute(listSeriesHistory, { url: "/api/media/series/watch-history", searchParams: { seriesKey: "tvdb:1" } }),
      200,
    );
    expect(series.items).toHaveLength(1);
    expect(series.pagination.totalCount).toBe(1);
  });

  it("merges a resumed chain re-delivered into both rows, without adding any", async () => {
    const serverId = await copiesOn("JELLYFIN", "item-b", "item-c");
    archive.add(chain1({ watched: false, percent_complete: 40, state: "stopped" }));
    await backfill(serverId);

    // Resumed and finished: the same chain, delivered again by the catch-up.
    redeliver(chain1({ watched: true, percent_complete: 95, segment_count: 2 }));
    expect((await forward(serverId)).count).toBe(1);
    expect(await rowsOf(serverId)).toEqual([
      ["item-b", "chain-1", null, true, 95],
      ["item-c", "chain-1:copy:item-c", "item-b", true, 95],
    ]);
  });

  // Whichever copy's row is new, it carries what the play has accumulated, not
  // the truncated re-delivery's 12% and unwatched; a lower-id copy takes the
  // primary row and every other copy points at it.
  it.each([
    ["a copy listed later", "JELLYFIN", ["item-b"], "item-c", [
      ["item-b", "chain-1", null, true, 95],
      ["item-c", "chain-1:copy:item-c", "item-b", true, 95],
    ]],
    ["a lower-id copy listed later, which takes the primary row", "EMBY", ["item-b", "item-c"], "item-a", [
      ["item-a", "chain-1", null, true, 95],
      ["item-b", "chain-1:copy:item-b", "item-a", true, 95],
      ["item-c", "chain-1:copy:item-c", "item-a", true, 95],
    ]],
  ] as const)("gives %s the play's accumulated state", async (_label, type, copies, added, expected) => {
    const serverId = await copiesOn(type, ...copies);
    archive.add(chain1(FINISHED));
    await backfill(serverId);

    await copy(serverId, added);
    redeliver(chain1(TRUNCATED));
    await forward(serverId);

    expect(await rowsOf(serverId)).toEqual(expected);
  });

  // The repair promotes such a row before the walk; when it could not run, the
  // page write re-delivering the play does — the lowest copy row that exists,
  // not the new copy's, which holds none.
  it.each([
    ["", true],
    [", in the page write if the repair could not run", false],
  ])("promotes a surviving copy's row when the primary goes and a lower-id copy arrives%s", async (_label, repaired) => {
    const serverId = await copiesOn("JELLYFIN", "item-b", "item-c", "item-d");
    archive.add(chain1(FINISHED));
    await backfill(serverId);

    await prisma.mediaItem.delete({ where: { id: "item-b" } });
    await copy(serverId, "item-a");
    redeliver(chain1(TRUNCATED));
    const refused = repaired
      ? undefined
      : hookRawQuery(
          (sql) => sql.includes(`"sourceEventId" LIKE '%:copy:%'`),
          () => {
            throw new Error("orphan read refused");
          },
        );
    try {
      await forward(serverId);
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
      ["item-a", "chain-1", null, true, 95],
      ["item-c", "chain-1:copy:item-c", "item-a", true, 95],
      ["item-d", "chain-1:copy:item-d", "item-a", true, 95],
    ]);
    expect((await plays()).items).toHaveLength(1);
  });

  // The play stays on one row of the survivor, still finished: promoted from
  // its copy row, or moved there without the copy row beside it (two rows of a
  // play on one item count it twice, and play counts never go down).
  it.each([
    ["goes", () => prisma.mediaItem.delete({ where: { id: "item-b" } }), [
      ["item-c", "chain-1:copy:item-c", null, true, 95],
    ]],
    ["stops listing the play's rating key", () =>
      prisma.mediaItem.update({ where: { id: "item-b" }, data: { ratingKey: "jf-other" } }), [
      ["item-b", "chain-1", null, true, 95],
      ["item-c", "chain-1:copy:item-c", "item-b", true, 95],
    ]],
  ])("keeps one row on the survivor when the primary's item %s", async (_label, change, afterChange) => {
    const serverId = await copiesOn("JELLYFIN", "item-b", "item-c");
    archive.add(chain1(FINISHED));
    await backfill(serverId);

    await change();
    // `SetNull` clears the other copy's pointer when the item goes.
    expect(await rowsOf(serverId)).toEqual(afterChange);
    redeliver(chain1(TRUNCATED));
    await forward(serverId);

    expect(await rowsOf(serverId)).toEqual([["item-c", "chain-1", null, true, 95]]);
    expect(await playCountOf("item-c")).toBe(1);
  });

  it.each([
    ["a rating key two Plex libraries share — a stale row, not a copy", async () => {
      const serverId = await copiesOn("PLEX", "item-b", "item-c");
      archive.add(chain1());
      return serverId;
    }],
    ["a provider id two different files share — a 4K beside a 1080p", async () => {
      const serverId = await mappedServer("JELLYFIN");
      for (const [id, key] of [["item-uhd", "jf-uhd"], ["item-hd", "jf-hd"]]) {
        await copy(serverId, id, key);
        await createTestExternalId(id, "TMDB", "603");
      }
      archive.add(play("chain-1", at(-2 * DAY), { rating_key: "gone", tmdb_id: 603 }));
      return serverId;
    }],
  ])("still skips %s", async (_label, seed) => {
    const serverId = await seed();
    await backfill(serverId);
    expect(await rowsOf(serverId)).toEqual([]);
  });

  it("recovers a play onto both copies of a re-added item, counted once", async () => {
    // A walked archive whose newest play is recent, and an item two libraries list just added back.
    const serverId = await mappedServer("JELLYFIN");
    await prisma.mediaServer.update({ where: { id: serverId }, data: { tracearrBackfillComplete: true } });
    await copy(serverId, "item-z", "jf-9");
    await prisma.mediaItem.update({ where: { id: "item-z" }, data: { createdAt: at(-400 * DAY) } });
    await storeTracearrPlay("item-z", serverId, "recent", at(-HOUR));
    for (const id of ["item-b", "item-c"]) {
      await copy(serverId, id);
      await prisma.mediaItem.update({ where: { id }, data: { createdAt: at(-DAY) } });
    }
    archive.add(play("chain-old", at(-30 * DAY), { rating_key: "jf-1" }));

    // Asked about through either copy: two new rows, logged as one play.
    expect((await recoverHistoryForNewItems(serverId)).imported).toBe(2);
    expect(logger.info).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("imported 1 new play(s) (1 already stored)"));
    expect((await rowsOf(serverId)).filter(([item]) => item !== "item-z")).toEqual([
      ["item-b", "chain-old", null, true, null],
      ["item-c", "chain-old:copy:item-c", "item-b", true, null],
    ]);
    for (const id of ["item-b", "item-c"]) {
      expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id } })).lastPlayedAt).toEqual(at(-30 * DAY));
    }
    // A play resolved to each, so neither is asked again.
    tracearr.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(serverId);
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
  });

  // Nothing writes an archived play again, so a copy listed since its plays
  // were imported, or a deleted copy that held their primary rows, is put right
  // before every import run walks (`repairLibraryCopyRows`).
  describe("the stored plays, repaired before each import run", () => {
    /** A statement that writes rows. */
    const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;
    /** The search for missing copy rows (`MISSING_COPY_ROWS_SQL`). */
    const isSearch = (sql: string) => sql.includes("WITH copies AS");
    const isAnalyse = (sql: string) => /^\s*ANALYZE\b/i.test(sql);
    const isWrite = (sql: string) => WRITE.test(sql);

    type Settings = { sql: string; nestloop: string; timeout: string; lockTimeout: string };
    type RawTx = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;
    type Run = {
      statements: string[];
      plans: unknown[];
      problems: string[];
      settings: Settings[];
      visits: Array<{ sql: string; rows: number }>;
    };
    type Picks = {
      explain?: (sql: string) => boolean;
      setting?: (sql: string) => boolean;
      visits?: (sql: string) => boolean;
      rewrite?: (sql: string) => string;
    };

    /**
     * Records each interactive `prisma.$transaction`'s raw statements (after
     * `rewrite`). For a statement `explain` picks: its plan, refused BEFORE it
     * runs on `planProblems` (the plan this guards against took minutes and
     * gigabytes), then `growthProblems` from EXPLAIN ANALYZE. For one `setting`
     * picks: the planner settings it ran under. For one `visits` picks:
     * `mostRowsRead`, from an EXPLAIN ANALYZE rolled back to a savepoint.
     */
    function recordTransactions(pick: Picks = {}) {
      const runs: Run[] = [];
      const original = prisma.$transaction.bind(prisma) as unknown as (fn: unknown, options?: unknown) => Promise<unknown>;
      const plan = async (tx: RawTx, sql: string, args: unknown[], analyse = false) =>
        (
          await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
            `EXPLAIN (${analyse ? "ANALYZE, " : ""}FORMAT JSON) ${sql}`,
            ...args,
          )
        )[0]["QUERY PLAN"];
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, options?: unknown) => {
        if (typeof fn !== "function") return original(fn, options);
        const run: Run = { statements: [], plans: [], problems: [], settings: [], visits: [] };
        runs.push(run);
        return original(async (tx: RawTx) => {
          const recorded = (method: keyof RawTx) => async (sql: string, ...args: unknown[]) => {
            const text = pick.rewrite ? pick.rewrite(sql) : sql;
            run.statements.push(text);
            if (pick.explain?.(text)) {
              const planned = await plan(tx, text, args);
              run.plans.push(planned);
              const problems = planProblems(planned);
              if (problems.length > 0) {
                run.problems.push(...problems);
                throw new Error(`refused to run the plan: ${problems.join("; ")}`);
              }
              run.problems.push(...growthProblems(await plan(tx, text, args, true)));
            }
            if (pick.setting?.(text)) {
              const [row] = await tx.$queryRawUnsafe<Array<Omit<Settings, "sql">>>(
                `SELECT current_setting('enable_nestloop') AS "nestloop",
                        current_setting('statement_timeout') AS "timeout",
                        current_setting('lock_timeout') AS "lockTimeout"`,
              );
              run.settings.push({ sql: text, ...row });
            }
            if (pick.visits?.(text)) {
              await tx.$executeRawUnsafe(`SAVEPOINT visits`);
              try {
                run.visits.push({ sql: text, rows: mostRowsRead(await plan(tx, text, args, true)) });
              } finally {
                await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT visits`);
              }
            }
            return tx[method](text, ...args);
          };
          const wrapped = new Proxy(tx, {
            get: (target, prop) =>
              prop === "$queryRawUnsafe" || prop === "$executeRawUnsafe" ? recorded(prop) : Reflect.get(target, prop),
          });
          return (fn as (tx: RawTx) => Promise<unknown>)(wrapped);
        }, options);
      }) as unknown as typeof prisma.$transaction);
      return { runs, restore: () => spy.mockRestore() };
    }

    /** `recordTransactions` while `body` runs; the runs it recorded. */
    async function recording(pick: Picks, body: () => Promise<unknown>) {
      const recorder = recordTransactions(pick);
      try {
        await body();
      } finally {
        recorder.restore();
      }
      return recorder.runs;
    }

    /** The settings the recorded statements `match` picks ran under, in order. */
    function settingsOf(runs: Run[], match: (sql: string) => boolean) {
      return runs
        .flatMap((run) => run.settings)
        .filter((settings) => match(settings.sql))
        .map(({ nestloop, timeout, lockTimeout }) => ({ nestloop, timeout, lockTimeout }));
    }

    /**
     * Each recorded transaction (but the import's own) as the search, the
     * statistics refresh or a write under the server row — "+"-joined when one
     * transaction was several.
     */
    function phases(runs: Run[]): string[] {
      return runs
        .map((run) => {
          const has = (match: (sql: string) => boolean) => run.statements.some(match);
          return [has(isSearch) && "search", has(isAnalyse) && "analyse", has((sql) => sql.includes("FOR NO KEY UPDATE")) && "write"]
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
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) visit(child);
      };
      for (const entry of plan as Array<{ Plan: Record<string, unknown> }>) visit(entry.Plan);
      return nodes;
    }

    /** A join condition keyed on an item, library, rating key or play. */
    const IDENTIFIER = /"(itemId|primaryId|copyId|mediaItemId|libraryId|ratingKey|sourceEventId)"|\.id\b/;

    /**
     * Before it runs: a nested loop or correlated subquery (a table read once
     * per row of another — cheap only on statistics, missing exactly when the
     * search has most to do), or a join keyed on no identifier (it pairs rows
     * that do not belong together).
     */
    function planProblems(plan: unknown): string[] {
      return planNodes(plan).flatMap((node) => {
        if (node["Node Type"] === "Nested Loop") return ["a nested loop"];
        if (node["Parent Relationship"] === "SubPlan") return [`a correlated subquery (${node["Subplan Name"]})`];
        const condition = node["Hash Cond"] ?? node["Merge Cond"];
        if (typeof condition === "string" && !IDENTIFIER.test(condition)) {
          return [`a ${node["Node Type"]} keyed on ${condition}`];
        }
        return [];
      });
    }

    /** The most rows any one node read over every loop, passed on or filtered out. */
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

    const produced = (node: Record<string, unknown>) =>
      Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 0);

    /**
     * Once it has run: a join that produced over four times its larger input
     * (plus slack for tiny ones). Every join here pairs a row with a handful of
     * others; the blowup this guards against was a hundred-fold.
     */
    function growthProblems(plan: unknown): string[] {
      return planNodes(plan).flatMap((node) => {
        if (!/Join|Nested Loop/.test(String(node["Node Type"]))) return [];
        const inputs = ((node.Plans as Array<Record<string, unknown>> | undefined) ?? []).map(produced);
        const out = produced(node);
        return out > 4 * Math.max(0, ...inputs) + 1_000
          ? [`a ${node["Node Type"]} produced ${out} rows from inputs of ${inputs.join(" and ")}`]
          : [];
      });
    }

    /** A server whose archived play of jf-1 is stored on item-b alone, walked to the end; the archive is then empty. */
    async function walkedServer(type: ServerType = "JELLYFIN") {
      const serverId = await copiesOn(type, "item-b");
      archive.add(play("chain-1", at(-30 * DAY), { rating_key: "jf-1", ...FINISHED }));
      await backfill(serverId);
      expect(await rowsOf(serverId)).toEqual([["item-b", "chain-1", null, true, 95]]);
      archive = new FakeTracearrArchive();
      return serverId;
    }

    const onItem = (mediaItemId: string) => prisma.watchHistory.count({ where: { mediaItemId } });
    const copyRows = () => prisma.watchHistory.count({ where: { fanOutOfItemId: { not: null } } });
    const warned = (text: string) =>
      vi.mocked(logger.warn).mock.calls.some(([, message]) => String(message).includes(text));
    async function untilWarned(text: string) {
      for (let waited = 0; waited < 5_000 && !warned(text); waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    /** Hold the lock `sql` takes, in a transaction of its own, until the returned function is called. */
    async function holdLock(sql: string, ...args: unknown[]) {
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => (held = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const locker = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(sql, ...args);
          held();
          await released;
        },
        { timeout: 30_000 },
      );
      await isHeld;
      return async () => {
        release();
        await locker;
      };
    }

    it.each(["JELLYFIN", "EMBY"] as const)("files a stored play against a copy listed since, at the next %s import", async (type) => {
      const serverId = await walkedServer(type);
      await copy(serverId, "item-c");

      await forward(serverId);

      expect(await rowsOf(serverId)).toEqual([
        ["item-b", "chain-1", null, true, 95],
        ["item-c", "chain-1:copy:item-c", "item-b", true, 95],
      ]);
      // The walk wrote nothing, so the repair reconciled the copy.
      expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id: "item-c" } })).toMatchObject({
        playCount: 1,
        lastPlayedAt: at(-30 * DAY),
      });
      expect((await plays()).pagination.totalCount).toBe(1);
      expect((await importedServer()).importedCount).toBe(1);

      // Repaired once: the next run finds every row in place.
      await forward(serverId);
      expect(await prisma.watchHistory.count({ where: { mediaServerId: serverId } })).toBe(2);
      expect(await playCountOf("item-c")).toBe(1);
    });

    it("re-points the surviving copies when the copy holding a play's primary row is deleted", async () => {
      const serverId = await copiesOn("JELLYFIN", "item-a", "item-b", "item-c");
      await copy(serverId, "item-z", "jf-9");
      archive.add(
        play("old-1", at(-90 * DAY), { rating_key: "jf-1", ...FINISHED }),
        play("recent-z", at(-2 * HOUR), { rating_key: "jf-9" }),
      );
      await backfill(serverId);

      // `SetNull` leaves both other copies' rows pointing at nothing.
      await prisma.mediaItem.delete({ where: { id: "item-a" } });
      redeliver(play("recent-z", at(-2 * HOUR), { rating_key: "jf-9" }));
      await forward(serverId);

      // The lowest survivor holds the primary row, the other points at it.
      const repaired = [
        ["item-b", "old-1", null, true, 95],
        ["item-c", "old-1:copy:item-c", "item-b", true, 95],
      ];
      expect(await rowsOf(serverId)).toEqual([...repaired, ["item-z", "recent-z", null, true, null]]);
      expect((await plays()).pagination.totalCount).toBe(2);
      expect((await importedServer()).importedCount).toBe(2);

      // A restarted walk re-delivers the chain window-truncated: merged, nothing added or regressed.
      archive.add(play("old-1", at(-90 * DAY), { rating_key: "jf-1", ...TRUNCATED }));
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: false, tracearrBackfillCursorAt: at(0) },
      });
      expect((await backfill(serverId)).count).toBe(2);
      expect((await rowsOf(serverId)).filter(([item]) => item !== "item-z")).toEqual(repaired);
      for (const id of ["item-b", "item-c"]) expect(await playCountOf(id)).toBe(1);
    });

    it.each([
      ["a copy whose identity contradicts the item's", "JELLYFIN", async (serverId: string) => {
        await createTestExternalId("item-b", "TMDB", "550");
        await copy(serverId, "item-c");
        await createTestExternalId("item-c", "TMDB", "999");
      }],
      ["a row of another type under the same rating key", "JELLYFIN", async (serverId: string) => {
        const tv = await createTestLibrary(serverId, { type: "SERIES" });
        await createTestMediaItem(tv.id, {
          ratingKey: "jf-1",
          type: "SERIES",
          title: "Pilot",
          parentTitle: "The Show",
          seasonNumber: 1,
          episodeNumber: 1,
        });
      }],
      ["a Plex server's second row under one rating key — a stale row, not a copy", "PLEX", async (serverId: string) => {
        await copy(serverId, "item-c");
      }],
    ] as const)("files nothing against %s", async (_label, type, add) => {
      const serverId = await walkedServer(type);
      await add(serverId);

      await forward(serverId);

      expect(await rowsOf(serverId)).toEqual([["item-b", "chain-1", null, true, 95]]);
    });

    it("drops a pointer-less copy row on the item that holds its play's primary row", async () => {
      // Two rows of one play on one item count it twice there.
      const serverId = await walkedServer();
      await copy(serverId, "item-c");
      await forward(serverId);
      // Left behind on item-b by a writer that no longer exists.
      await storeTracearrPlay("item-b", serverId, "chain-1:copy:item-b", at(-30 * DAY));

      await forward(serverId);

      expect(await rowsOf(serverId)).toEqual([
        ["item-b", "chain-1", null, true, 95],
        ["item-c", "chain-1:copy:item-c", "item-b", true, 95],
      ]);
    });

    it("repairs nothing once the mapping has changed under the run", async () => {
      const serverId = await walkedServer();
      await copy(serverId, "item-c");
      // An unlink and re-link lands between the run's read and the repair.
      const spy = hookRawQuery(
        (sql) => sql.includes("HAVING COUNT(*) > 1"),
        () => prisma.mediaServer.update({ where: { id: serverId }, data: { tracearrMappingVersion: { increment: 1 } } }),
      );
      try {
        await forward(serverId);
      } finally {
        spy.mockRestore();
      }

      expect((await rowsOf(serverId)).map(([, event]) => event)).toEqual(["chain-1"]);
    });

    it("waits for a page write of the server's plays in flight before it repairs", async () => {
      // Page writes hold the server row FOR SHARE; the repair takes it FOR NO KEY UPDATE.
      const serverId = await walkedServer();
      await copy(serverId, "item-c");
      const unlock = await holdLock(`SELECT "id" FROM "MediaServer" WHERE "id" = $1 FOR SHARE`, serverId);

      const run = forward(serverId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await onItem("item-c")).toBe(0);

      await unlock();
      await run;
      expect(await onItem("item-c")).toBe(1);
    });

    /** Run `between` once, right after the repair's search for missing copy rows. */
    function afterMissingRead(between: () => Promise<unknown>) {
      const original = prisma.$transaction.bind(prisma) as unknown as (fn: unknown, options?: unknown) => Promise<unknown>;
      let done = false;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (fn: unknown, options?: unknown) => {
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
      // The search takes no lock: a page write re-delivers the play onto a
      // lower-id copy listed since, which takes the primary row and gives item-b a copy row.
      const serverId = await walkedServer();
      await copy(serverId, "item-a");
      const restore = afterMissingRead(async () => {
        const primary = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "chain-1" } });
        await prisma.watchHistory.update({ where: { id: primary.id }, data: { mediaItemId: "item-a" } });
        await storeTracearrPlay("item-b", serverId, "chain-1:copy:item-b", primary.watchedAt!, {
          fanOutOfItemId: "item-a",
          percentComplete: 95,
        });
      });
      try {
        await forward(serverId);
      } finally {
        restore();
      }

      expect(await rowsOf(serverId)).toEqual([
        ["item-a", "chain-1", null, true, 95],
        ["item-b", "chain-1:copy:item-b", "item-a", true, 95],
      ]);
    });

    it("skips a copy deleted since the search, and still fills the others", async () => {
      const serverId = await walkedServer();
      await copy(serverId, "item-c");
      await copy(serverId, "item-d");
      const restore = afterMissingRead(() => prisma.mediaItem.delete({ where: { id: "item-c" } }));
      try {
        await forward(serverId);
      } finally {
        restore();
      }

      expect((await rowsOf(serverId)).map(([item, event, fanOut]) => [item, event, fanOut])).toEqual([
        ["item-b", "chain-1", null],
        ["item-d", "chain-1:copy:item-d", "item-b"],
      ]);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    /** A walked server holding 10,001 plays on item-b, and item-c listed since: two transactions' worth. */
    async function largeRepair() {
      const serverId = await walkedServer();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state","createdAt")
         SELECT 'bulk-' || g, 'item-b', $1, 'walter', $2::timestamp - (g || ' minutes')::interval, 'TRACEARR', 'bulk-' || g, true, 'stopped', now()
           FROM generate_series(1, 10000) g`,
        serverId,
        at(-30 * DAY),
      );
      await copy(serverId, "item-c");
      return serverId;
    }

    it("writes a large repair a transaction at a time, stopping at the run's limits and finishing at the next run", async () => {
      const serverId = await largeRepair();

      // A cancelled run starts nothing.
      const cancelled = new AbortController();
      cancelled.abort();
      await forward(serverId, { signal: cancelled.signal });
      expect(await onItem("item-c")).toBe(0);

      // A sync waiting for the queue: one transaction, then the run moves on.
      await forward(serverId, { yieldTo: () => true });
      expect(await onItem("item-c")).toBe(10_000);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("stopped early, the next import does the rest"),
      );

      await forward(serverId);
      expect(await onItem("item-c")).toBe(10_001);
      expect(await onItem("item-b")).toBe(10_001);
    }, 60_000);

    it("settles what it committed when a later transaction fails", async () => {
      // The copy must read as watched now, not after whatever reconciles next.
      const serverId = await largeRepair();
      // The second write transaction fails at its first statement.
      let writes = 0;
      await recording(
        { rewrite: (sql) => (sql.includes("FOR NO KEY UPDATE") && ++writes === 2 ? "SELECT connection_lost()" : sql) },
        () => forward(serverId),
      );

      expect(await onItem("item-c")).toBe(10_000);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Could not repair the library-copy rows"),
        expect.anything(),
      );
      expect(await playCountOf("item-c")).toBeGreaterThan(0);

      await forward(serverId);
      expect(await onItem("item-c")).toBe(10_001);
    }, 60_000);

    it("costs one read without a copy group, and takes no lock while every row is in place", async () => {
      const serverId = await walkedServer();
      const queries = vi.spyOn(prisma, "$queryRawUnsafe");
      const recorder = recordTransactions();
      try {
        await forward(serverId);
        const sqls = queries.mock.calls.map(([sql]) => String(sql));
        expect(sqls.filter((sql) => sql.includes("HAVING COUNT(*) > 1"))).toHaveLength(1);
        expect(sqls.some((sql) => sql.includes(":copy:"))).toBe(false);
        expect(recorder.runs).toEqual([]);

        // A copy, repaired once under the lock; after that, reads only.
        await copy(serverId, "item-c");
        await forward(serverId);
        const locked = recorder.runs.filter((run) => run.statements.some((sql) => sql.includes("FOR NO KEY UPDATE")));
        expect(locked).toHaveLength(1);
        expect(locked[0].statements.some(isWrite)).toBe(true);

        recorder.runs.length = 0;
        await forward(serverId);
        expect(recorder.runs).toHaveLength(1);
        expect(recorder.runs[0].statements.some((sql) => sql.includes("FOR NO KEY UPDATE"))).toBe(false);
        expect(recorder.runs[0].statements.filter(isWrite)).toEqual([]);
      } finally {
        queries.mockRestore();
        recorder.restore();
      }
    });

    /** The search ran nested-loops-off under its 1 min timeout; every write with the planner's own settings. */
    function expectSearchAndWriteSettings(runs: Run[], searches: number) {
      expect(settingsOf(runs, isSearch)).toEqual(
        Array.from({ length: searches }, () => ({ nestloop: "off", timeout: "1min", lockTimeout: "0" })),
      );
      const writes = settingsOf(runs, isWrite);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes).toEqual(writes.map(() => ({ nestloop: "on", timeout: "0", lockTimeout: "0" })));
    }

    it("plans its search without a nested loop where one would be cheapest, and writes with the planner's own settings", async () => {
      // Over a handful of rows a nested loop IS the cheapest plan, so this is
      // where one shows up unless they are off; the writes need theirs on.
      const serverId = await walkedServer();
      await copy(serverId, "item-c");

      const runs = await recording({ explain: isSearch, setting: (sql) => isSearch(sql) || isWrite(sql) }, () => forward(serverId));

      expect(runs.flatMap((run) => run.problems)).toEqual([]);
      expect(runs.flatMap((run) => run.plans)).toHaveLength(1);
      expectSearchAndWriteSettings(runs, 1);
      expect(await onItem("item-c")).toBe(1);
    });

    /** A finished Jellyfin server, history established a day ago. */
    async function finishedJellyfin() {
      const serverId = await mappedServer("JELLYFIN");
      await prisma.mediaServer.update({
        where: { id: serverId },
        data: { tracearrBackfillComplete: true, watchHistorySyncedAt: at(-DAY) },
      });
      return serverId;
    }

    /** `count` films `<prefix>-1…`, rating keys jf-1…, created 60 days ago, in one new library. */
    async function insertFilms(serverId: string, prefix: string, count: number) {
      const library = await createTestLibrary(serverId, { type: "MOVIE", title: `Movies ${prefix}` });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "MediaItem" ("id","libraryId","ratingKey","title","type","createdAt","updatedAt")
         SELECT '${prefix}-' || g, $1, 'jf-' || g, 'Film ' || g, 'MOVIE', $3::timestamp, $3::timestamp
           FROM generate_series(1, $2::int) g`,
        library.id,
        count,
        at(-60 * DAY),
      );
    }

    /**
     * A finished server whose second library lists every one of `items` films
     * — each with a TMDB id and one play stored on the first library's copy —
     * holding none of their copy rows yet. Analysed, as an established install is.
     */
    async function listedTwice(items: number) {
      const serverId = await finishedJellyfin();
      await insertFilms(serverId, "a", items);
      await insertFilms(serverId, "b", items);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "MediaItemExternalId" ("id","mediaItemId","source","externalId")
         SELECT 'e-' || mi."id", mi."id", 'TMDB', split_part(mi."id", '-', 2) FROM "MediaItem" mi`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state")
         SELECT 'w-' || g, 'a-' || g, $1, 'walter', $3::timestamp - (g || ' minutes')::interval, 'TRACEARR', 'chain-' || g, true, 'stopped'
           FROM generate_series(1, $2::int) g`,
        serverId,
        items,
        at(-30 * DAY),
      );
      await prisma.$executeRawUnsafe(`ANALYZE`);
      return serverId;
    }

    it("searches 5,000 films listed twice joining only on identifiers, no join outgrowing its inputs", async () => {
      // With statistics, the planner joined the primaries' ids to the copies' on
      // `source` alone — a hundred million rows here, 45 s and 6 GB of
      // temporary files — when filling the copies and when finding them in place.
      const serverId = await listedTwice(5_000);
      let filled = 0;
      const runs = await recording({ explain: isSearch, setting: (sql) => isSearch(sql) || isWrite(sql) }, async () => {
        await forward(serverId);
        filled = await copyRows();
        await prisma.$executeRawUnsafe(`ANALYZE`);
        await forward(serverId);
      });

      expect(runs.flatMap((run) => run.problems)).toEqual([]);
      expect(filled).toBe(5_000);
      expect(runs.flatMap((run) => run.plans)).toHaveLength(2);
      expectSearchAndWriteSettings(runs, 2);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    }, 60_000);

    it("gives up with a WARN when its search runs past the timeout, and the import goes on", async () => {
      // It waits on a lock here, under a timeout shortened from a minute.
      const serverId = await walkedServer();
      await copy(serverId, "item-c");
      const unlock = await holdLock(`LOCK TABLE "MediaItemExternalId" IN ACCESS EXCLUSIVE MODE`);
      let run!: ReturnType<typeof forward>;
      await recording({ rewrite: (sql) => sql.replace(/statement_timeout = \d+/, "statement_timeout = 200") }, async () => {
        try {
          run = forward(serverId);
          await untilWarned("Could not repair");
        } finally {
          await unlock();
        }
      });
      const result = await run;

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Could not repair the library-copy rows"),
        { error: expect.stringContaining("statement timeout") },
      );
      expect(result.failed).toBeUndefined();
      expect(await onItem("item-c")).toBe(0);

      await forward(serverId);
      expect(await onItem("item-c")).toBe(1);
    });

    // With WatchHistory's statistics missing or taken before this server's
    // plays were stored, every write statement reads all of them: a repair
    // about to write 1,000 rows refreshes them first, once, in a transaction of its own.
    it.each([
      [1_000, ["search", "analyse", "write", "search"]],
      [999, ["search", "write", "search"]],
    ])("fills %i copy rows, analysing WatchHistory first only from 1,000", async (items, expected) => {
      const serverId = await listedTwice(items);

      const runs = await recording({ setting: isAnalyse }, async () => {
        await forward(serverId);
        await forward(serverId);
      });

      expect(phases(runs)).toEqual(expected);
      expect(settingsOf(runs, isAnalyse)).toEqual(
        items >= 1_000 ? [{ nestloop: "on", timeout: "1min", lockTimeout: "5s" }] : [],
      );
      expect(await copyRows()).toBe(items);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    /**
     * A finished server with three libraries over one folder, each listing
     * `items` films, whose plays lost their primary rows with the copy that
     * held them: a pointer-less copy row on each b- and c- copy, none on the
     * a- copy, listed since.
     */
    async function orphaned(items: number) {
      const serverId = await finishedJellyfin();
      for (const prefix of ["a", "b", "c"]) await insertFilms(serverId, prefix, items);
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

    // Repairing orphaned rows writes like a fill, so it analyses past the same
    // 1,000 rows — once a run.
    it.each([
      ["repairs 20 orphaned copy rows and fills 10 without analysing", 10, ["write", "search", "write", "search"]],
      [
        "analyses WatchHistory once, before repairing 2,000 orphaned copy rows, not again before filling 1,000",
        1_000,
        ["analyse", "write", "search", "write", "search"],
      ],
    ] as const)("%s", async (_name, items, expected) => {
      const serverId = await orphaned(items);

      const runs = await recording({}, async () => {
        await forward(serverId);
        await forward(serverId);
      });

      expect(phases(runs)).toEqual(expected);
      // Each play's primary row on its b- copy, both other copies' rows pointing at it.
      expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: null } })).toBe(items);
      expect(await prisma.watchHistory.count({ where: { fanOutOfItemId: { startsWith: "b-" } } })).toBe(2 * items);
    });

    it("writes anyway, with a WARN, when WatchHistory cannot be analysed", async () => {
      // A VACUUM holds the lock ANALYZE needs, and the writes do not; the wait is shortened from five seconds.
      const serverId = await listedTwice(1_000);
      const unlock = await holdLock(`LOCK TABLE "WatchHistory" IN SHARE UPDATE EXCLUSIVE MODE`);
      let run!: ReturnType<typeof forward>;
      await recording({ rewrite: (sql) => sql.replace(/lock_timeout = \d+/, "lock_timeout = 100") }, async () => {
        try {
          run = forward(serverId);
          await untilWarned("Could not refresh");
        } finally {
          await unlock();
        }
      });
      const result = await run;

      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("Could not refresh WatchHistory's statistics"),
        { error: expect.stringContaining("lock timeout") },
      );
      expect(result.failed).toBeUndefined();
      expect(await copyRows()).toBe(1_000);
    });

    it("promotes re-delivered plays' copy rows reading the server's plays at most once a statement, whatever the statistics", async () => {
      // Statistics taken while WatchHistory held only another server's plays
      // make the planner take this server's for one row; as one UPDATE the
      // promotion then read all of them once per promoted row. Autovacuum is
      // held off so the statistics stay that stale.
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchHistory" SET (autovacuum_enabled = false)`);
      try {
        const other = await createTestServer(userId, { type: "PLEX" });
        await insertFilms(other.id, "o", 1000);
        await prisma.$executeRawUnsafe(
          `INSERT INTO "WatchHistory" ("id","mediaItemId","mediaServerId","serverUsername","watchedAt","source","sourceEventId","watched","state")
           SELECT 'o-' || g, 'o-' || (1 + g % 1000), $1, 'x', $2::timestamp - (g || ' minutes')::interval,
                  'TRACEARR', 'other-' || g, true, 'stopped'
             FROM generate_series(1, 20000) g`,
          other.id,
          at(-60 * DAY),
        );
        await prisma.$executeRawUnsafe(`ANALYZE "WatchHistory"`);

        // One library, so the repair finds no copies and the page write
        // promotes: 100 plays each kept on a copy row, among 1,800 other plays.
        const serverId = await mappedServer("JELLYFIN");
        await insertFilms(serverId, "b", 100);
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
          archive.add(play(`chain-${g}`, new Date(at(-2 * DAY).getTime() + g * 1000), { rating_key: `jf-${g}`, ...FINISHED }));
        }

        const runs = await recording(
          { visits: (sql) => /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql) && sql.includes(`"WatchHistory"`) },
          () => forward(serverId),
        );

        const tableRows = await prisma.watchHistory.count();
        const visits = runs.flatMap((run) => run.visits);
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
