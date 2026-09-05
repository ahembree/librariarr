/**
 * SAFETY AUDIT, as an executable test.
 *
 * Question: can any rule criterion whose value comes from Tracearr select the
 * ENTIRE library and hand it to a DELETE action?
 *
 * Exactly seven fields carry Tracearr-derived data. One reads the
 * `WatchHistory` relation directly:
 *
 *   1. watchedByUser
 *
 * ...and six read it transitively, through the two denormalized columns
 * `watch-reconcile.ts` maintains (`MediaItem.playCount` / `lastPlayedAt`):
 *
 *   2. playCount                      5. latestEpisodeViewDate
 *   3. lastPlayedAt                   6. watchedEpisodeCount
 *   4. seriesLastPlayedAt             7. watchedEpisodePercentage
 *
 * Every other activity/series field (rating, isWatchlisted, addedAt,
 * availableEpisodeCount, lastEpisodeAddedAt/AiredAt) is metadata the media
 * server reports and Tracearr never touches.
 *
 * The hazard is the same for all seven and it is a NEGATIVE rule, because a
 * negative is what goes vacuously true against absent evidence:
 * `watchedByUser is not alice` compiles to `watchHistory: { none: … }`, which
 * is trivially satisfied by every item when the relation is empty; `playCount
 * = 0` and `lastPlayedAt is null` match everything if those columns were reset.
 * On a DELETE rule set that is the whole library.
 *
 * And the empty state is not hypothetical — Librariarr creates it ON PURPOSE.
 * Changing a server's watch-history source wipes that server's rows, and the
 * Tracearr re-import that refills them walks newest-first over minutes to
 * hours. So the library spends real time in each state below.
 *
 * Two independent defences are asserted here, one per class of field:
 *
 *   - watchedByUser reads the rows themselves, so it CANNOT be made safe by
 *     data alone. It is gated: `checkWatchHistoryCompleteness` refuses to
 *     evaluate while any in-scope server's history is incomplete.
 *   - playCount / lastPlayedAt and the four series aggregates built on them are
 *     NOT gated — deliberately, since pausing "not played in N months" during
 *     every import would be its own outage. They are safe because every writer
 *     of those two columns is non-regressive, so an emptied `WatchHistory`
 *     cannot walk them back. That is asserted directly, as data.
 *
 * If a future change breaks either defence, one of these fails.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { checkLifecycleRuleEvaluability, checkWatchHistoryCompleteness } =
  await import("@/lib/lifecycle/evaluability");
const { evaluateLifecycleRules } = await import("@/lib/rules/lifecycle-engine");
const { reconcileWatchStateFromHistory } = await import("@/lib/sync/watch-reconcile");
const {
  invalidateWatchHistoryEvidence,
  invalidateServersWithoutWatchHistory,
  markWatchHistoryEstablished,
} = await import("@/lib/media/watch-evidence");

const LIBRARY_SIZE = 6;

interface Fixture {
  userId: string;
  serverId: string;
  libraryId: string;
  itemIds: string[];
}

/**
 * A library whose items were watched by other household members — the case that
 * matters, because the admin's own account-scoped metadata says nothing about
 * them. Every item ends up with real `playCount` / `lastPlayedAt`, reconciled
 * from `WatchHistory` exactly as a live sync would do it.
 */
async function seedWatchedLibrary(): Promise<Fixture> {
  const prisma = getTestPrisma();
  const user = await prisma.user.create({
    data: { username: `audit-${Math.random().toString(36).slice(2)}`, passwordHash: "x" },
  });
  const server = await prisma.mediaServer.create({
    data: {
      userId: user.id,
      name: "Plex",
      type: "PLEX",
      url: "http://plex:32400",
      accessToken: "x",
      machineId: `audit-${Math.random().toString(36).slice(2)}`,
      tracearrServerId: "trc-server",
      tracearrBackfillComplete: true,
      // Established: a sync has determined what was played here. Without this
      // the server starts in the schema's own default — never synced — and the
      // guard would refuse every rule below for the right reason but the wrong
      // one, hiding whatever the test meant to assert.
      watchHistorySyncedAt: new Date(),
    },
  });
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });

  const itemIds: string[] = [];
  for (let i = 0; i < LIBRARY_SIZE; i++) {
    const item = await prisma.mediaItem.create({
      data: { libraryId: library.id, ratingKey: `k${i}`, title: `Movie ${i}`, type: "MOVIE" },
    });
    itemIds.push(item.id);
    await prisma.watchHistory.create({
      data: {
        mediaItemId: item.id,
        mediaServerId: server.id,
        serverUsername: "roommate",
        watchedAt: new Date("2025-06-01T00:00:00Z"),
        source: "TRACEARR",
        sourceEventId: `chain-${i}`,
        watched: true,
      },
    });
  }

  // The same call every watch-history sync ends with.
  await reconcileWatchStateFromHistory(server.id);

  return { userId: user.id, serverId: server.id, libraryId: library.id, itemIds };
}

/** Wipe the server's plays and set the marker, exactly as the PUT route does. */
async function switchWatchHistorySource(
  fx: Fixture,
  to: { tracearrServerId: string | null },
) {
  const prisma = getTestPrisma();
  await prisma.watchHistory.deleteMany({ where: { mediaServerId: fx.serverId } });
  await prisma.mediaServer.update({
    where: { id: fx.serverId },
    data: {
      tracearrServerId: to.tracearrServerId,
      tracearrBackfillComplete: false,
      tracearrOldestPlayAt: null,
      tracearrBackfillCursorAt: null,
      watchHistorySyncedAt: null,
    },
  });
}

function group(field: string, operator: string, value: unknown): LifecycleRuleGroup[] {
  return [
    {
      id: "g1",
      condition: "AND",
      rules: [{ id: "r1", field, operator, value, condition: "AND" } as never],
      groups: [],
    } as unknown as LifecycleRuleGroup,
  ];
}

/** How many of the library's items a rule selects, via the real engine. */
async function matchCount(fx: Fixture, rules: LifecycleRuleGroup[]): Promise<number> {
  const items = await evaluateLifecycleRules(rules, "MOVIE", [fx.serverId], undefined, undefined);
  return items.filter((i) => fx.itemIds.includes(i.id as string)).length;
}

describe("Tracearr criteria cannot select the whole library", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ── Class 1: watchedByUser — gated, because data alone cannot save it ────
  //
  // These four states are every way a server's `WatchHistory` can be empty or
  // unrepresentative. In each, the negative form of `watchedByUser` would match
  // all six items if it were allowed to run, so the guard must refuse first.
  describe("watchedByUser is refused while history is incomplete", () => {
    const incompleteStates: Array<{
      name: string;
      apply: (fx: Fixture) => Promise<void>;
    }> = [
      {
        name: "native → Tracearr: rows wiped, import not started",
        apply: (fx) => switchWatchHistorySource(fx, { tracearrServerId: "trc-new" }),
      },
      {
        name: "Tracearr → native (UNLINK): mapping nulled at the emptiest moment",
        // The direction a `tracearrServerId != null` check misses entirely.
        apply: (fx) => switchWatchHistorySource(fx, { tracearrServerId: null }),
      },
      {
        name: "backfill mid-walk: recent plays imported, archive still owed",
        apply: async (fx) => {
          const prisma = getTestPrisma();
          await prisma.watchHistory.deleteMany({ where: { mediaServerId: fx.serverId } });
          await prisma.mediaServer.update({
            where: { id: fx.serverId },
            data: { tracearrBackfillComplete: false, watchHistorySyncedAt: new Date() },
          });
          // One recent play landed; everything older is still un-walked.
          await prisma.watchHistory.create({
            data: {
              mediaItemId: fx.itemIds[0],
              mediaServerId: fx.serverId,
              serverUsername: "roommate",
              watchedAt: new Date(),
              source: "TRACEARR",
              sourceEventId: "chain-recent",
              watched: true,
            },
          });
        },
      },
      {
        name: "flagged complete but holding no rows (restore, or a data purge)",
        apply: async (fx) => {
          const prisma = getTestPrisma();
          await prisma.watchHistory.deleteMany({ where: { mediaServerId: fx.serverId } });
          await prisma.mediaServer.update({
            where: { id: fx.serverId },
            // The flag says done and a sync did once establish history — but
            // the rows are gone, so the evidence the flag vouches for is not
            // there. Caught by the restore/purge paths withdrawing the marker.
            data: { tracearrBackfillComplete: true, watchHistorySyncedAt: null },
          });
        },
      },
    ];

    // Every negative form. `notEquals`/`notContains`/`isNull` compile to
    // `none:` directly; a positive form under `negate` gets there via
    // `pushDownGroupNegation`, which is why it has to be covered too.
    const negativeForms: Array<{ label: string; rules: LifecycleRuleGroup[] }> = [
      { label: "notEquals", rules: group("watchedByUser", "notEquals", "roommate") },
      { label: "notContains", rules: group("watchedByUser", "notContains", "roommate") },
      { label: "isNull", rules: group("watchedByUser", "isNull", null) },
      {
        label: "equals under negate",
        rules: [
          {
            id: "g1",
            condition: "AND",
            rules: [
              {
                id: "r1",
                field: "watchedByUser",
                operator: "equals",
                value: "roommate",
                condition: "AND",
                negate: true,
              } as never,
            ],
            groups: [],
          } as unknown as LifecycleRuleGroup,
        ],
      },
    ];

    for (const state of incompleteStates) {
      for (const form of negativeForms) {
        it(`refuses "${form.label}" — ${state.name}`, async () => {
          const fx = await seedWatchedLibrary();
          await state.apply(fx);

          const verdict = await checkLifecycleRuleEvaluability(
            fx.userId,
            "MOVIE",
            form.rules,
            [fx.serverId],
          );

          expect(verdict.evaluable).toBe(false);
          if (verdict.evaluable) throw new Error("expected a refusal");
          expect(verdict.reason).toMatch(/play history/i);
          // Transient: it lifts by itself when the import finishes, so callers
          // skip the rule set rather than disarming it.
          expect(verdict.permanent).toBe(false);

          // And confirm the refusal is load-bearing rather than belt-and-braces:
          // the engine really would sweep the library here. Not always ALL of
          // it — mid-backfill one item's recent play has already landed, so
          // that state sweeps 5 of 6 — but "all but the handful the walk has
          // reached so far" is the same catastrophe, and it grows toward the
          // whole library the earlier in the import it happens.
          const swept = await matchCount(fx, form.rules);
          expect(swept).toBeGreaterThanOrEqual(LIBRARY_SIZE - 1);
        });
      }
    }

    it("allows the rule again once the history is complete", async () => {
      // The guard must RELEASE, or it is an outage of its own.
      const fx = await seedWatchedLibrary();

      const verdict = await checkLifecycleRuleEvaluability(
        fx.userId,
        "MOVIE",
        group("watchedByUser", "notEquals", "roommate"),
        [fx.serverId],
      );

      expect(verdict).toEqual({ evaluable: true });
      // ...and the rule is then correct rather than vacuous: every item WAS
      // watched by the roommate, so a "not watched by roommate" rule selects
      // nothing at all.
      expect(await matchCount(fx, group("watchedByUser", "notEquals", "roommate"))).toBe(0);
    });

    it("does not pause a rule set that reads only unaffected servers", async () => {
      // Over-refusing is its own hazard: it would silently stop lifecycle
      // management on servers whose history is complete and correct.
      const importing = await seedWatchedLibrary();
      await switchWatchHistorySource(importing, { tracearrServerId: "trc-new" });

      const healthy = await getTestPrisma().mediaServer.create({
        data: {
          userId: importing.userId,
          name: "Native Plex",
          type: "PLEX",
          url: "http://other:32400",
          accessToken: "x",
          machineId: "audit-healthy",
          watchHistorySyncedAt: new Date(),
        },
      });

      await expect(
        checkLifecycleRuleEvaluability(
          importing.userId,
          "MOVIE",
          group("watchedByUser", "notEquals", "roommate"),
          [healthy.id],
        ),
      ).resolves.toEqual({ evaluable: true });
    });
  });

  // ── Class 2: playCount / lastPlayedAt — safe by data, not by a gate ──────
  //
  // These are deliberately NOT gated: "not played in N months" is the flagship
  // lifecycle rule and pausing it for the hours every Tracearr import takes
  // would be a worse failure than the one being prevented. Their safety rests
  // entirely on the columns never regressing, so that is what is asserted.
  describe("play state survives an emptied WatchHistory", () => {
    it("keeps playCount and lastPlayedAt after the source switch wipes every row", async () => {
      const fx = await seedWatchedLibrary();
      const prisma = getTestPrisma();

      const before = await prisma.mediaItem.findMany({
        where: { id: { in: fx.itemIds } },
        select: { id: true, playCount: true, lastPlayedAt: true },
        orderBy: { ratingKey: "asc" },
      });
      expect(before.every((i) => i.playCount > 0 && i.lastPlayedAt !== null)).toBe(true);

      await switchWatchHistorySource(fx, { tracearrServerId: "trc-new" });
      // The reconcile that ends every sync, now running against nothing.
      await reconcileWatchStateFromHistory(fx.serverId);

      const after = await prisma.mediaItem.findMany({
        where: { id: { in: fx.itemIds } },
        select: { id: true, playCount: true, lastPlayedAt: true },
        orderBy: { ratingKey: "asc" },
      });
      expect(after).toEqual(before);
    });

    it("leaves every play-derived DELETE criterion selecting nothing", async () => {
      // The six transitive fields, as the negative forms that would sweep the
      // library. All are evaluated AFTER the wipe.
      const fx = await seedWatchedLibrary();
      await switchWatchHistorySource(fx, { tracearrServerId: "trc-new" });
      await reconcileWatchStateFromHistory(fx.serverId);

      expect(await matchCount(fx, group("playCount", "equals", 0))).toBe(0);
      expect(await matchCount(fx, group("playCount", "lessThan", 1))).toBe(0);
      expect(await matchCount(fx, group("lastPlayedAt", "isNull", null))).toBe(0);
      expect(
        await matchCount(fx, group("lastPlayedAt", "before", "2020-01-01")),
      ).toBe(0);
    });

    it("does not let a partially-imported archive drag play state backwards", async () => {
      // Mid-backfill the table holds only the newest plays. The reconcile is
      // monotonic and joins only items that HAVE history, so an item the walk
      // has not reached yet keeps what it had rather than resetting to zero.
      const fx = await seedWatchedLibrary();
      const prisma = getTestPrisma();

      await prisma.watchHistory.deleteMany({ where: { mediaServerId: fx.serverId } });
      await prisma.watchHistory.create({
        data: {
          mediaItemId: fx.itemIds[0],
          mediaServerId: fx.serverId,
          serverUsername: "roommate",
          watchedAt: new Date("2025-08-01T00:00:00Z"),
          source: "TRACEARR",
          sourceEventId: "chain-recent",
          watched: true,
        },
      });
      await reconcileWatchStateFromHistory(fx.serverId);

      const rows = await prisma.mediaItem.findMany({
        where: { id: { in: fx.itemIds } },
        select: { playCount: true, lastPlayedAt: true },
      });
      expect(rows.every((r) => r.playCount > 0)).toBe(true);
      expect(rows.every((r) => r.lastPlayedAt !== null)).toBe(true);
    });

    it("never counts an abandoned Tracearr play as a watch", async () => {
      // The other direction of the same column: a 4%-complete play must not
      // reach these columns either. They are monotonic, so one that did would
      // pin `lastPlayedAt` to "just now" permanently and silently DISARM every
      // "not played in N months" rule — the same failure inverted.
      const prisma = getTestPrisma();
      const fx = await seedWatchedLibrary();
      await prisma.watchHistory.deleteMany({ where: { mediaServerId: fx.serverId } });
      await prisma.mediaItem.updateMany({
        where: { id: { in: fx.itemIds } },
        data: { playCount: 0, lastPlayedAt: null },
      });
      await prisma.watchHistory.create({
        data: {
          mediaItemId: fx.itemIds[0],
          mediaServerId: fx.serverId,
          serverUsername: "roommate",
          watchedAt: new Date(),
          source: "TRACEARR",
          sourceEventId: "chain-abandoned",
          watched: false,
        },
      });

      await reconcileWatchStateFromHistory(fx.serverId);

      const row = await prisma.mediaItem.findUniqueOrThrow({
        where: { id: fx.itemIds[0] },
        select: { playCount: true, lastPlayedAt: true },
      });
      expect(row.playCount).toBe(0);
      expect(row.lastPlayedAt).toBeNull();
    });
  });

  // ── The completeness check itself, independent of any rule shape ─────────
  describe("checkWatchHistoryCompleteness", () => {
    it("ignores a DISABLED server that is mid-import", async () => {
      // A disabled server's items are not synced and its history is not read,
      // so it must not hold the whole install's rules hostage.
      const fx = await seedWatchedLibrary();
      await switchWatchHistorySource(fx, { tracearrServerId: "trc-new" });
      await getTestPrisma().mediaServer.update({
        where: { id: fx.serverId },
        data: { enabled: false },
      });

      await expect(
        checkWatchHistoryCompleteness(fx.userId),
      ).resolves.toEqual({ complete: true });
    });

    it("treats an unscoped check as covering every server", async () => {
      // An empty/absent `serverIds` means "all", which is also a rule set's own
      // default — it must stay broad rather than silently matching nothing.
      const fx = await seedWatchedLibrary();
      await switchWatchHistorySource(fx, { tracearrServerId: "trc-new" });

      const all = await checkWatchHistoryCompleteness(fx.userId);
      expect(all.complete).toBe(false);

      const empty = await checkWatchHistoryCompleteness(fx.userId, []);
      expect(empty.complete).toBe(false);
    });
  });

  // ── Bulk destruction other than a source switch ─────────────────────────
  //
  // `WatchHistory.mediaItem` is a required FK with `onDelete: Cascade`, so
  // deleting media takes its plays with it. Four paths do that in bulk, and
  // every one of them has to leave the server marked un-evidenced — otherwise
  // the next sync brings the items back with an empty history and the first
  // detection run reads it as "nobody watched anything".
  describe("every bulk-destruction path marks the server un-evidenced", () => {
    it("a library purge does", async () => {
      const fx = await seedWatchedLibrary();
      const prisma = getTestPrisma();

      await prisma.mediaItem.deleteMany({ where: { libraryId: fx.libraryId } });
      await invalidateWatchHistoryEvidence([fx.serverId]);

      await expect(
        checkWatchHistoryCompleteness(fx.userId, [fx.serverId]),
      ).resolves.toMatchObject({ complete: false });
    });

    it("a restore does, discovered from the rows rather than the operation", async () => {
      // Restore truncates everything and re-inserts servers from the file, so
      // the affected ids are not knowable up front — the marker is derived from
      // which servers end up holding no plays.
      const fx = await seedWatchedLibrary();
      const prisma = getTestPrisma();

      await prisma.watchHistory.deleteMany({});
      await prisma.mediaItem.deleteMany({});
      await invalidateServersWithoutWatchHistory();

      await expect(
        checkWatchHistoryCompleteness(fx.userId, [fx.serverId]),
      ).resolves.toMatchObject({ complete: false });
    });

    it("leaves a server that still holds plays alone", async () => {
      const fx = await seedWatchedLibrary();

      await invalidateServersWithoutWatchHistory();

      await expect(
        checkWatchHistoryCompleteness(fx.userId, [fx.serverId]),
      ).resolves.toEqual({ complete: true });
    });

    it("keeps the original timestamp when a server is marked twice", async () => {
      // Idempotent on purpose: a second bulk operation must not slide the
      // marker forward, or "how long has this been paused" becomes unreadable.
      const fx = await seedWatchedLibrary();
      const prisma = getTestPrisma();

      await invalidateWatchHistoryEvidence([fx.serverId]);
      const first = await prisma.mediaServer.findUniqueOrThrow({
        where: { id: fx.serverId },
        select: { watchHistorySyncedAt: true },
      });

      await invalidateWatchHistoryEvidence([fx.serverId]);
      const second = await prisma.mediaServer.findUniqueOrThrow({
        where: { id: fx.serverId },
        select: { watchHistorySyncedAt: true },
      });

      expect(second.watchHistorySyncedAt).toEqual(first.watchHistorySyncedAt);
    });
  });


  // ── The broadened policy: play activity is only answerable where it exists ─
  //
  // watchedByUser was gated first because it reads the rows and goes vacuous
  // the instant they are gone. But playCount and lastPlayedAt go vacuous the
  // same way wherever the denormalized columns were never established — and
  // unlike a source switch, which preserves them, nothing establishes them for
  // a server that has never synced or whose items were recreated by a purge or
  // a restore. Every field that reads play activity is therefore gated on the
  // same question: do we actually know what was played here?
  describe("every play-activity field is gated, not just watchedByUser", () => {
    const playActivityRules: Array<{ label: string; rules: LifecycleRuleGroup[] }> = [
      { label: "playCount", rules: group("playCount", "equals", 0) },
      { label: "lastPlayedAt", rules: group("lastPlayedAt", "isNull", null) },
      { label: "watchedByUser", rules: group("watchedByUser", "isNull", null) },
      { label: "seriesLastPlayedAt", rules: group("seriesLastPlayedAt", "isNull", null) },
      { label: "latestEpisodeViewDate", rules: group("latestEpisodeViewDate", "isNull", null) },
      { label: "watchedEpisodeCount", rules: group("watchedEpisodeCount", "equals", 0) },
      {
        label: "watchedEpisodePercentage",
        rules: group("watchedEpisodePercentage", "lessThan", 50),
      },
    ];

    for (const field of playActivityRules) {
      it(`refuses ${field.label} on a server that has never synced`, async () => {
        // The state a "cleared at" marker could not express: nothing destroyed
        // this history, it was simply never read. A null default has to mean
        // "we don't know", or absence of evidence presents itself as evidence
        // of absence.
        const fx = await seedWatchedLibrary();
        await getTestPrisma().mediaServer.update({
          where: { id: fx.serverId },
          data: { watchHistorySyncedAt: null },
        });

        const verdict = await checkLifecycleRuleEvaluability(
          fx.userId,
          field.label.startsWith("series") ||
            field.label.startsWith("watchedEpisode") ||
            field.label.startsWith("latest")
            ? "SERIES"
            : "MOVIE",
          field.rules,
          [fx.serverId],
        );

        expect(verdict.evaluable).toBe(false);
        if (verdict.evaluable) throw new Error("expected a refusal");
        expect(verdict.reason).toMatch(/play history/i);
      });
    }

    it("allows them all once a sync has established the history", async () => {
      // Including the case that must NOT stay paused: a server nobody has
      // watched anything on is a real steady state. Its sync finds no plays,
      // marks the history established, and `playCount = 0` then legitimately
      // matches everything on it.
      const fx = await seedWatchedLibrary();
      await getTestPrisma().watchHistory.deleteMany({ where: { mediaServerId: fx.serverId } });
      await markWatchHistoryEstablished([fx.serverId]);

      for (const field of playActivityRules) {
        const verdict = await checkLifecycleRuleEvaluability(
          fx.userId,
          "SERIES",
          field.rules,
          [fx.serverId],
        );
        expect(verdict, `${field.label} should be evaluable`).toEqual({ evaluable: true });
      }
    });

    it("still ignores fields that do not read play activity", async () => {
      // The gate must stay narrow. `addedAt` and `rating` come from the media
      // server's own metadata and say nothing about plays, so an unsynced
      // history is no reason to refuse them.
      const fx = await seedWatchedLibrary();
      await getTestPrisma().mediaServer.update({
        where: { id: fx.serverId },
        data: { watchHistorySyncedAt: null },
      });

      for (const rules of [
        group("addedAt", "before", "2020-01-01"),
        group("rating", "lessThan", 5),
        group("title", "contains", "Movie"),
      ]) {
        await expect(
          checkLifecycleRuleEvaluability(fx.userId, "MOVIE", rules, [fx.serverId]),
        ).resolves.toEqual({ evaluable: true });
      }
    });
  });

});
