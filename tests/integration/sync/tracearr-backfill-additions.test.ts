import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestServer, createTestLibrary, createTestMediaItem, createTestExternalId } from "../../setup/test-helpers";
import { FakeTracearrArchive, play } from "./fake-tracearr-archive";
import { answerFrom, seedMappedServer, storeTracearrPlay, tracearr } from "./tracearr-import-kit";

// The re-added-item recovery pass against a REAL database: the unit test mocks
// `$queryRawUnsafe`, so only this file proves which rows the candidate query returns.

vi.mock("@/lib/db", async () => ({ prisma: (await import("../../setup/test-db")).getTestPrisma() }));
vi.mock("@/lib/logger", async () => (await import("./tracearr-import-kit")).loggerModule());
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/tracearr/tracearr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tracearr/tracearr-client")>()),
  ...(await import("./tracearr-import-kit")).clientModule(100),
}));

import { recoverHistoryForNewItems, resetRecoveryAnswers, RECOVERY_REASK_MS } from "@/lib/sync/tracearr-backfill-additions";

const prisma = getTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

/** A play of The Matrix (TMDB 603), as Tracearr answers for it. */
const rec = (id: string, startedAt: string | Date, extra: Parameters<typeof play>[2] = {}) =>
  play(id, startedAt, { tmdb_id: 603, ...extra });

type Filter = { ratingKey?: string; tmdbId?: string | null };
const answer = (fn: (filter: Filter) => ReturnType<typeof rec>[]) =>
  tracearr.getHistoryForItem.mockImplementation(async (_server: string, filter: Filter) => fn(filter));

/** A mapped server whose archive walk has finished — when recovery runs — and an empty movie library. */
async function seedServer() {
  const { userId, serverId, libraryId, itemId } = await seedMappedServer({ tracearrBackfillComplete: true });
  await prisma.mediaItem.delete({ where: { id: itemId } });
  return { userId, serverId, libraryId };
}

/** Backdate an item's row creation — the instant the candidate window keys on. */
async function createdDaysAgo(itemId: string, days: number) {
  await prisma.mediaItem.update({ where: { id: itemId }, data: { createdAt: daysAgo(days) } });
}

/** An item with an id, backdated, carrying a TMDB id when given one. */
async function item(libraryId: string, ratingKey: string, ageDays?: number, tmdb?: string, title = "The Matrix") {
  const created = await createTestMediaItem(libraryId, { ratingKey, title, year: 1999 });
  if (ageDays !== undefined) await createdDaysAgo(created.id, ageDays);
  if (tmdb) await createTestExternalId(created.id, "TMDB", tmdb);
  return created;
}

const asked = () => tracearr.getHistoryForItem.mock.calls.map((c) => (c[1] as Filter).ratingKey).filter((k) => k !== undefined);
const askedRatingKeys = () => asked().sort();

describe("recoverHistoryForNewItems (real database)", () => {
  beforeEach(() => {
    resetRecoveryAnswers();
    const archive = new FakeTracearrArchive();
    answerFrom(() => archive);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("recovers a re-added film's old plays even though its new play is already imported", async () => {
    const { serverId, libraryId } = await seedServer();
    // Re-added two days ago under a NEW rating key, and played once since.
    const film = await item(libraryId, "500", 2, "603");
    const newPlayAt = daysAgo(1);
    await storeTracearrPlay(film.id, serverId, "new-play", newPlayAt, { watched: false, percentComplete: 8 });
    // Long in the library: the archive walk already had its chance at it.
    await item(libraryId, "600", 30, undefined, "Old Film");

    const newPlay = rec("new-play", newPlayAt, { rating_key: "500", watched: false, percent_complete: 8 });
    answer((filter) => {
      if (filter.ratingKey === "500") return [newPlay];
      if (filter.tmdbId === "603") {
        // Filed under the rating key the film had before it left.
        return [newPlay, rec("old-1", "2024-03-01T20:00:00.000Z", { rating_key: "123" }), rec("old-2", "2025-01-10T20:00:00.000Z", { rating_key: "123" })];
      }
      return [];
    });

    expect((await recoverHistoryForNewItems(serverId)).checked).toBe(1);
    // Only the recent addition was a candidate.
    expect(tracearr.getHistoryForItem.mock.calls.map((c) => c[1])).toEqual([{ ratingKey: "500" }, { tmdbId: "603", imdbId: null }]);
    const rows = await prisma.watchHistory.findMany({ where: { mediaItemId: film.id }, orderBy: { watchedAt: "asc" } });
    // The new play once (merged, not duplicated) plus both old ones, under the server's own account name.
    expect(rows.map((r) => r.sourceEventId)).toEqual(["old-1", "old-2", "new-play"]);
    expect(rows.every((r) => r.serverUsername === "walter")).toBe(true);
    // The point of the pass: the film no longer reads as never watched.
    const reconciled = await prisma.mediaItem.findUniqueOrThrow({ where: { id: film.id } });
    expect(reconciled.playCount).toBe(2);
    expect(reconciled.lastPlayedAt?.toISOString()).toBe("2025-01-10T20:00:00.000Z");
  });

  it("asks about each recent item once, then leaves it out of the candidate query", async () => {
    const { serverId, libraryId } = await seedServer();
    await item(libraryId, "701");
    await item(libraryId, "702");

    await recoverHistoryForNewItems(serverId);
    expect(askedRatingKeys()).toEqual(["701", "702"]);

    // Both answered ("no plays"): the pass costs no request at all.
    tracearr.getHistoryForItem.mockClear();
    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
  });

  it("only offers items on the server being recovered, newest first, within the cap", async () => {
    const { userId, serverId, libraryId } = await seedServer();
    const other = await createTestServer(userId, { name: "Other" });
    await createTestMediaItem((await createTestLibrary(other.id)).id, { ratingKey: "900" });
    for (const [key, ageDays] of [["801", 3], ["802", 1], ["803", 2]] as const) await item(libraryId, key, ageDays);

    await recoverHistoryForNewItems(serverId, { limit: 2 });

    expect(asked()).toEqual(["802", "803"]);
  });

  it("does not offer an item whose plays from before its creation are already stored", async () => {
    const { serverId, libraryId } = await seedServer();
    // Imported by the archive walk: a play older than the row itself.
    const walked = await item(libraryId, "1001", 2);
    await storeTracearrPlay(walked.id, serverId, "walked-old", daysAgo(400));
    // Re-added: its only stored play is one since it came back.
    const readded = await item(libraryId, "1002", 2);
    await storeTracearrPlay(readded.id, serverId, "readded-new", daysAgo(1));
    // A native row says nothing about what Tracearr was asked.
    const nativeOnly = await item(libraryId, "1003", 2);
    await storeTracearrPlay(nativeOnly.id, serverId, "n", daysAgo(400), { source: "NATIVE", sourceEventId: null });

    await recoverHistoryForNewItems(serverId);

    expect(askedRatingKeys()).toEqual(["1002", "1003"]);
  });

  it("offers a freshly synced library only its items that hold no walked history, also after a restart", async () => {
    // Every item was created minutes ago, so the window alone admits the whole library.
    const { serverId, libraryId } = await seedServer();
    for (let n = 0; n < 6; n++) {
      const created = await item(libraryId, `${2000 + n}`);
      if (n % 2 === 0) await storeTracearrPlay(created.id, serverId, `walk-${n}`, daysAgo(30 + n));
    }

    await recoverHistoryForNewItems(serverId);
    expect(askedRatingKeys()).toEqual(["2001", "2003", "2005"]);

    // Restart: the registry is gone, the rows are not.
    resetRecoveryAnswers();
    tracearr.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(serverId);
    expect(askedRatingKeys()).toEqual(["2001", "2003", "2005"]);
  });

  it("asks about nothing once the slice's deadline has passed, and stops mid-pass when it does", async () => {
    const { serverId, libraryId } = await seedServer();
    for (const key of ["3001", "3002", "3003"]) await item(libraryId, key);

    expect(await recoverHistoryForNewItems(serverId, { deadlineMs: Date.now() - 1 })).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
    expect(tracearr.listServers).not.toHaveBeenCalled();

    let lookups = 0;
    answer(() => {
      lookups++;
      return [];
    });
    expect((await recoverHistoryForNewItems(serverId, { yieldTo: () => lookups >= 1 })).checked).toBe(1);

    // The two it never reached are still candidates.
    tracearr.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(serverId);
    expect(askedRatingKeys()).toHaveLength(2);
  });

  it("keeps a re-added film a candidate while its old plays land on the old copy, and recovers them once that copy is gone", async () => {
    const { serverId, libraryId } = await seedServer();
    // The old copy, not purged yet, still claims the film's old plays by rating key.
    const oldCopy = await item(libraryId, "123", 400, "603");
    const film = await item(libraryId, "500", 2, "603");
    const oldPlays = [
      rec("old-1", "2024-03-01T20:00:00.000Z", { rating_key: "123" }),
      rec("old-2", "2025-01-10T20:00:00.000Z", { rating_key: "123" }),
    ];
    answer((filter) => (filter.tmdbId === "603" ? oldPlays : []));

    expect((await recoverHistoryForNewItems(serverId)).imported).toBe(2);
    expect(await prisma.watchHistory.count({ where: { mediaItemId: oldCopy.id } })).toBe(2);
    expect(await prisma.watchHistory.count({ where: { mediaItemId: film.id } })).toBe(0);

    // Deferred, not settled — but not asked again on the very next pass.
    tracearr.getHistoryForItem.mockClear();
    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();

    // The old copy is purged a day on; re-asked, the same plays resolve to the film by provider id.
    await prisma.mediaItem.delete({ where: { id: oldCopy.id } });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + RECOVERY_REASK_MS });
    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 1, imported: 2 });
    const rows = await prisma.watchHistory.findMany({ where: { mediaItemId: film.id }, orderBy: { watchedAt: "asc" } });
    expect(rows.map((r) => r.sourceEventId)).toEqual(["old-1", "old-2"]);

    // Answered now — and, from the rows, still after a restart.
    resetRecoveryAnswers();
    tracearr.getHistoryForItem.mockClear();
    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
  });

  it("offers a re-added item whose only stored play landed before its row was created", async () => {
    // Played after it came back but before our sync created its row: keyed on
    // `createdAt` itself, that play ended its candidacy.
    const { serverId, libraryId } = await seedServer();
    const film = await item(libraryId, "500", undefined, "603");
    await prisma.mediaItem.update({ where: { id: film.id }, data: { createdAt: new Date(Date.now() - HOUR) } });
    const newPlayAt = new Date(Date.now() - 5 * HOUR);
    await storeTracearrPlay(film.id, serverId, "new-play", newPlayAt);
    answer((filter) =>
      filter.tmdbId === "603"
        ? [rec("new-play", newPlayAt, { rating_key: "500" }), rec("old-1", "2025-01-10T20:00:00.000Z", { rating_key: "123" })]
        : [],
    );

    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 1, imported: 1 });
    expect(await prisma.watchHistory.count({ where: { mediaItemId: film.id, sourceEventId: "old-1" } })).toBe(1);
  });

  it("offers an item whose only plays are from the week before its row, once per run of the registry", async () => {
    // Nothing tells those plays apart from a re-added item's new ones.
    const { serverId, libraryId } = await seedServer();
    const created = await item(libraryId, "4001");
    await storeTracearrPlay(created.id, serverId, "recent", daysAgo(3));

    await recoverHistoryForNewItems(serverId);
    expect(askedRatingKeys()).toEqual(["4001"]);

    tracearr.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(serverId);
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();

    resetRecoveryAnswers();
    await recoverHistoryForNewItems(serverId);
    expect(askedRatingKeys()).toEqual(["4001"]);
  });

  describe("second copies whose plays always resolve to the other copy", () => {
    /**
     * `count` second copies (newest), each beside an older copy that keeps
     * claiming its plays (a 4K beside a 1080p), plus one re-added film, older
     * than all of them, whose old plays only a provider id reaches.
     */
    async function seedCopiesAndReadd(count: number) {
      const { serverId, libraryId } = await seedServer();
      for (let n = 0; n < count; n++) {
        await item(libraryId, `old-${n}`, 400, String(1000 + n), `Film ${n}`);
        const copy = await item(libraryId, `copy-${n}`, undefined, String(1000 + n), `Film ${n}`);
        await prisma.mediaItem.update({ where: { id: copy.id }, data: { createdAt: new Date(Date.now() - (n + 1) * HOUR) } });
      }
      const readded = await item(libraryId, "readded", 3, "603");
      // A walked archive's newest play is recent: without it the first copy
      // play stored (2024) would bound every later pass below the re-added film's (2025).
      const anchor = await item(libraryId, "anchor", 400, undefined, "Anchor");
      await storeTracearrPlay(anchor.id, serverId, "anchor-recent", new Date(Date.now() - HOUR));

      answer((filter) => {
        if (filter.tmdbId === "603") return [rec("matrix-old", "2025-01-10T20:00:00.000Z", { rating_key: "gone" })];
        const n = Number(filter.tmdbId) - 1000;
        if (!filter.tmdbId || n < 0 || n >= count) return [];
        return [rec(`play-${n}`, "2024-05-01T20:00:00.000Z", { rating_key: `old-${n}`, tmdb_id: 1000 + n })];
      });
      return { serverId, readded };
    }

    it("cannot starve a re-added item below more than a cap's worth of them", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const { serverId, readded } = await seedCopiesAndReadd(4);

      // Pass 1: the cap's three newest copies, deferred.
      await recoverHistoryForNewItems(serverId, { limit: 3 });
      expect(asked()).toEqual(["copy-0", "copy-1", "copy-2"]);

      // A day later they are due again — and still come after every item never asked.
      vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
      tracearr.getHistoryForItem.mockClear();
      const second = await recoverHistoryForNewItems(serverId, { limit: 3 });
      expect(asked()).toEqual(["copy-3", "readded", "copy-0"]);
      // copy-3's play (onto its older copy) and the re-added film's old one.
      expect(second.imported).toBe(2);
      // The copies' plays stay on the copy that owns them.
      expect(await prisma.watchHistory.count({ where: { mediaItem: { ratingKey: { startsWith: "copy-" } } } })).toBe(0);
      expect(await prisma.watchHistory.count({ where: { mediaItemId: readded.id, sourceEventId: "matrix-old" } })).toBe(1);
    });

    it("reaches the re-added item within a pass of a restart emptying the registry", async () => {
      const { serverId, readded } = await seedCopiesAndReadd(4);
      await recoverHistoryForNewItems(serverId, { limit: 3 });

      // Every copy is never-asked again; their answers are recorded again, so the next pass gets past them.
      resetRecoveryAnswers();
      tracearr.getHistoryForItem.mockClear();
      await recoverHistoryForNewItems(serverId, { limit: 3 });
      expect(asked()).toEqual(["copy-0", "copy-1", "copy-2"]);

      tracearr.getHistoryForItem.mockClear();
      await recoverHistoryForNewItems(serverId, { limit: 3 });
      expect(asked()).toEqual(["copy-3", "readded"]);
      expect(await prisma.watchHistory.count({ where: { mediaItemId: readded.id } })).toBe(1);
    });
  });

  it("reports nothing imported when every record it got back was already stored", async () => {
    const { serverId, libraryId } = await seedServer();
    const film = await item(libraryId, "500", 2);
    // Since the re-add, so it does not end candidacy on its own.
    const playedAt = daysAgo(1);
    await storeTracearrPlay(film.id, serverId, "new-play", playedAt);
    tracearr.getHistoryForItem.mockResolvedValue([rec("new-play", playedAt, { rating_key: "500" })]);

    // Merged, not inserted: nothing for the caller to reconcile or announce.
    expect(await recoverHistoryForNewItems(serverId)).toEqual({ checked: 1, imported: 0 });
    expect(await prisma.watchHistory.count({ where: { mediaItemId: film.id } })).toBe(1);
  });
});
