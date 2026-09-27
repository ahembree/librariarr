/**
 * Scheduled execution of grouped (series / artist) lifecycle actions, driven
 * through the real processor against the test database:
 * `processLifecycleRules` → `executeLifecycleActions`.
 *
 * Detection stores a series or artist match as its GROUP — title = the show or
 * artist, `parentTitle` cleared — against a representative episode or track,
 * whose own title is the episode's or track's. The executor's identity guard
 * compared that group title with the episode title, read every grouped action
 * as a Fix Match ("Breaking Bad" → "Pilot"), and cancelled it; the next
 * detection re-scheduled it `actionDelayDays` out and it was cancelled again
 * when due, so no scheduled series or artist action ever ran.
 *
 * The guard still has to refuse a row that genuinely became a different work,
 * so the Fix Match cases run through the same pipeline.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestExternalId,
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

// Never reach out to Discord or Plex during the pipeline.
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
  buildSuccessSummaryEmbed: vi.fn(),
  buildFailureSummaryEmbed: vi.fn(),
  buildMatchChangeEmbed: vi.fn(),
  buildMaintenanceEmbed: vi.fn(),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));

import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { logger } from "@/lib/logger";

const UNPLAYED = [
  {
    id: "g1",
    condition: "AND",
    rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    groups: [],
  },
];

/** Make every pending action of the rule set due, as if its delay had passed. */
async function makeDue(ruleSetId: string) {
  await getTestPrisma().lifecycleAction.updateMany({
    where: { ruleSetId, status: "PENDING" },
    data: { scheduledFor: new Date(Date.now() - 60_000) },
  });
}

function identityWarnings(): string[] {
  return vi
    .mocked(logger.warn)
    .mock.calls.map((c) => String(c[1]))
    .filter((msg) => msg.includes("identity changed"));
}

async function seedShow(
  libraryId: string,
  show = "Breaking Bad",
  tvdb = "81189",
) {
  const pilot = await createTestMediaItem(libraryId, {
    type: "SERIES",
    title: "Pilot",
    parentTitle: show,
    seasonNumber: 1,
    episodeNumber: 1,
    year: 2008,
    playCount: 0,
  });
  const second = await createTestMediaItem(libraryId, {
    type: "SERIES",
    title: "Cat's in the Bag...",
    parentTitle: show,
    seasonNumber: 1,
    episodeNumber: 2,
    year: 2008,
    playCount: 0,
  });
  // The sync stores the SERIES-level id on every episode (see series-key.ts).
  await createTestExternalId(pilot.id, "TVDB", tvdb);
  await createTestExternalId(second.id, "TVDB", tvdb);
  return [pilot, second];
}

async function seedArtist(libraryId: string) {
  const creep = await createTestMediaItem(libraryId, {
    type: "MUSIC",
    title: "Creep",
    parentTitle: "Radiohead",
    albumTitle: "Pablo Honey",
    playCount: 0,
  });
  const karma = await createTestMediaItem(libraryId, {
    type: "MUSIC",
    title: "Karma Police",
    parentTitle: "Radiohead",
    albumTitle: "OK Computer",
    playCount: 0,
  });
  return [creep, karma];
}

describe("grouped lifecycle actions through the scheduled executor (e2e)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe("executes grouped actions instead of cancelling them as identity changes", () => {
    for (const seriesScope of [true, false]) {
      it(`SERIES, seriesScope=${seriesScope}`, async () => {
        const prisma = getTestPrisma();
        const user = await createTestUser();
        const server = await createTestServer(user.id);
        const library = await createTestLibrary(server.id, { type: "SERIES" });
        const episodes = await seedShow(library.id);

        const ruleSet = await createTestRuleSet(user.id, {
          type: "SERIES",
          seriesScope,
          rules: UNPLAYED,
          serverIds: [server.id],
          actionEnabled: true,
          actionType: "DO_NOTHING",
          actionDelayDays: 0,
        });

        await processLifecycleRules(user.id);

        const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
        expect(pending).toHaveLength(1);
        // Detection stored the group: the show as the title, no parent.
        expect(pending[0].mediaItemTitle).toBe("Breaking Bad");
        expect(pending[0].mediaItemParentTitle).toBeNull();
        expect(episodes.map((e) => e.id)).toContain(pending[0].mediaItemId);
        expect([...pending[0].matchedMediaItemIds].sort()).toEqual(episodes.map((e) => e.id).sort());
        // The Arr identity it was scheduled against (Sonarr resolves by TVDB).
        expect(pending[0].mediaItemExternalId).toBe("81189");

        await makeDue(ruleSet.id);
        await executeLifecycleActions(user.id);

        const after = await prisma.lifecycleAction.findUnique({ where: { id: pending[0].id } });
        expect(after?.status).toBe("COMPLETED");
        expect(identityWarnings()).toEqual([]);
      });
    }

    it("MUSIC, artist scope (seriesScope=true)", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const tracks = await seedArtist(library.id);

      const ruleSet = await createTestRuleSet(user.id, {
        type: "MUSIC",
        seriesScope: true,
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });

      await processLifecycleRules(user.id);

      const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(pending).toHaveLength(1);
      expect(pending[0].mediaItemTitle).toBe("Radiohead");
      expect(pending[0].mediaItemParentTitle).toBeNull();
      expect([...pending[0].matchedMediaItemIds].sort()).toEqual(tracks.map((t) => t.id).sort());

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      const after = await prisma.lifecycleAction.findUnique({ where: { id: pending[0].id } });
      expect(after?.status).toBe("COMPLETED");
      expect(identityWarnings()).toEqual([]);
    });

    it("SERIES carried over to another server's copy of the show, titled differently there", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const s1 = await createTestServer(user.id);
      const s2 = await createTestServer(user.id);
      const l1 = await createTestLibrary(s1.id, { type: "SERIES" });
      const l2 = await createTestLibrary(s2.id, { type: "SERIES" });
      // One Sonarr series (TVDB 73244), titled differently on each server.
      const office = await seedShow(l1.id, "The Office", "73244");
      const officeUs = await seedShow(l2.id, "The Office (US)", "73244");

      const ruleSet = await createTestRuleSet(user.id, {
        type: "SERIES",
        rules: UNPLAYED,
        serverIds: [s1.id, s2.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });

      await processLifecycleRules(user.id);
      const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      const keptIsFirst = office.some((e) => e.id === action.mediaItemId);
      const [kept, other] = keptIsFirst ? [office, officeUs] : [officeUs, office];
      const otherTitle = keptIsFirst ? "The Office (US)" : "The Office";

      // Watched on the kept copy's server only: the match — and its pending
      // action — carry over to the other server's copy of the show.
      await prisma.mediaItem.updateMany({ where: { id: { in: kept.map((e) => e.id) } }, data: { playCount: 1 } });
      await processLifecycleRules(user.id);

      const [carried] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(carried.id).toBe(action.id);
      expect(other.map((e) => e.id)).toContain(carried.mediaItemId);
      expect(carried.mediaItemTitle).toBe(otherTitle);
      expect(carried.mediaItemExternalId).toBe("73244");

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      expect((await prisma.lifecycleAction.findUnique({ where: { id: action.id } }))?.status).toBe("COMPLETED");
      expect(identityWarnings()).toEqual([]);
    });

    it("MUSIC, track scope (seriesScope=false) — artist and track both still compare equal", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      await seedArtist(library.id);

      const ruleSet = await createTestRuleSet(user.id, {
        type: "MUSIC",
        seriesScope: false,
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });

      await processLifecycleRules(user.id);

      const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(pending).toHaveLength(2);
      expect(pending.map((a) => a.mediaItemParentTitle)).toEqual(["Radiohead", "Radiohead"]);

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      const statuses = await prisma.lifecycleAction.findMany({
        where: { ruleSetId: ruleSet.id },
        select: { status: true },
      });
      expect(statuses.map((s) => s.status)).toEqual(["COMPLETED", "COMPLETED"]);
      expect(identityWarnings()).toEqual([]);
    });
  });

  describe("still cancels an action whose item became a different work", () => {
    it("a grouped series action whose show was re-identified", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const episodes = await seedShow(library.id);

      const ruleSet = await createTestRuleSet(user.id, {
        type: "SERIES",
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });
      await processLifecycleRules(user.id);
      const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });

      // A show-level Fix Match rewrites every episode row of the same rating keys.
      await prisma.mediaItem.updateMany({
        where: { id: { in: episodes.map((e) => e.id) } },
        data: { parentTitle: "Better Call Saul" },
      });

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      expect(await prisma.lifecycleAction.findUnique({ where: { id: action.id } })).toBeNull();
      expect(identityWarnings()).toEqual([
        expect.stringContaining(`"Breaking Bad" is now "Better Call Saul"`),
      ]);
    });

    it("a grouped series action whose show's TVDB id changed under the same title", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const episodes = await seedShow(library.id, "Battlestar Galactica", "71173");

      const ruleSet = await createTestRuleSet(user.id, {
        type: "SERIES",
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });
      await processLifecycleRules(user.id);
      const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(action.mediaItemExternalId).toBe("71173");

      // Re-identified as the 2004 series: same title, a different Sonarr record.
      await prisma.mediaItemExternalId.updateMany({
        where: { mediaItemId: { in: episodes.map((e) => e.id) }, source: "TVDB" },
        data: { externalId: "73545" },
      });

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      expect(await prisma.lifecycleAction.findUnique({ where: { id: action.id } })).toBeNull();
      expect(identityWarnings()).toEqual([expect.stringContaining("TVDB id changed from 71173 to 73545")]);
    });

    it("a movie action whose row became a different film", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "The Matrix", year: 1999 });

      const ruleSet = await createTestRuleSet(user.id, {
        type: "MOVIE",
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });
      await processLifecycleRules(user.id);
      const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });

      await prisma.mediaItem.update({ where: { id: movie.id }, data: { title: "Hackers", year: 1995 } });

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      expect(await prisma.lifecycleAction.findUnique({ where: { id: action.id } })).toBeNull();
      expect(identityWarnings()).toEqual([expect.stringContaining(`"The Matrix" is now "Hackers"`)]);
    });

    it("a movie action whose row became a remake of the same title, then runs once detection re-schedules it", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Dune", year: 1984 });
      await createTestExternalId(movie.id, "TMDB", "841");

      const ruleSet = await createTestRuleSet(user.id, {
        type: "MOVIE",
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });
      await processLifecycleRules(user.id);
      const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      // The rules never loaded external ids here — scheduling reads it itself.
      expect(action.mediaItemExternalId).toBe("841");
      expect(action.mediaItemYear).toBe(1984);

      // Fix Match onto the 2021 film: the title alone cannot tell them apart.
      await prisma.mediaItem.update({ where: { id: movie.id }, data: { year: 2021 } });
      await prisma.mediaItemExternalId.updateMany({
        where: { mediaItemId: movie.id, source: "TMDB" },
        data: { externalId: "438631" },
      });

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      expect(await prisma.lifecycleAction.findUnique({ where: { id: action.id } })).toBeNull();
      expect(identityWarnings()).toEqual([expect.stringContaining("TMDB id changed from 841 to 438631")]);
      // The match described the 1984 film too: it goes with the action.
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);

      // The 2021 film still matches: the next detection matches and schedules
      // it afresh, against its own identity, and that action runs.
      await processLifecycleRules(user.id);
      const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
      expect((match.itemData as { year?: number }).year).toBe(2021);
      const [rescheduled] = await prisma.lifecycleAction.findMany({
        where: { ruleSetId: ruleSet.id, status: "PENDING" },
      });
      expect(rescheduled.mediaItemExternalId).toBe("438631");
      expect(rescheduled.mediaItemYear).toBe(2021);

      vi.mocked(logger.warn).mockClear();
      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);

      expect((await prisma.lifecycleAction.findUnique({ where: { id: rescheduled.id } }))?.status).toBe("COMPLETED");
      expect(identityWarnings()).toEqual([]);
    });
  });

  describe("a sticky rule set re-evaluates an item whose identity changed", () => {
    // A sticky rule set keeps a match that stopped matching and re-schedules
    // from its STORED snapshot. Were the match kept after the identity check
    // refused its action, every detection would schedule the old identity
    // again and every execution would cancel it — forever.
    async function stickyMovie() {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "The Matrix", year: 1999 });
      const ruleSet = await createTestRuleSet(user.id, {
        type: "MOVIE",
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });
      await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { stickyMatches: true } });
      await processLifecycleRules(user.id);
      return { prisma, user, movie, ruleSet };
    }

    it("schedules the new title afresh when it still matches", async () => {
      const { prisma, user, movie, ruleSet } = await stickyMovie();
      await prisma.mediaItem.update({ where: { id: movie.id }, data: { title: "Hackers", year: 1995 } });

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);
      expect(identityWarnings()).toHaveLength(1);

      await processLifecycleRules(user.id);
      const [rescheduled] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
      expect(rescheduled.mediaItemTitle).toBe("Hackers");

      vi.mocked(logger.warn).mockClear();
      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);
      expect((await prisma.lifecycleAction.findUnique({ where: { id: rescheduled.id } }))?.status).toBe("COMPLETED");
      expect(identityWarnings()).toEqual([]);
    });

    it("keeps the Arr id a stale match was made with, so a same-titled show is refused", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      // Episode scope and no Arr criteria: the engine returns no external ids.
      const [pilot, second] = await seedShow(library.id, "Battlestar Galactica", "71173");
      const ruleSet = await createTestRuleSet(user.id, {
        type: "SERIES",
        seriesScope: false,
        rules: UNPLAYED,
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DO_NOTHING",
        actionDelayDays: 0,
      });
      await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { stickyMatches: true } });
      await processLifecycleRules(user.id);

      // The match records the id it was made with.
      const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
      expect((match.itemData as { externalIds?: unknown }).externalIds).toEqual([
        { source: "TVDB", externalId: "71173" },
      ]);

      // Its action goes away before running (actions turned off and on), then a
      // Fix Match moves the row to the same-titled 2004 show, which the rules no
      // longer select. The sticky rule set keeps the old match and schedules it again.
      await prisma.lifecycleAction.deleteMany({ where: { ruleSetId: ruleSet.id } });
      for (const ep of [pilot, second]) {
        await prisma.mediaItemExternalId.updateMany({ where: { mediaItemId: ep.id, source: "TVDB" }, data: { externalId: "73545" } });
        await prisma.mediaItem.update({ where: { id: ep.id }, data: { playCount: 3 } });
      }
      await processLifecycleRules(user.id);
      const [rescheduled] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(rescheduled.mediaItemExternalId).toBe("71173");

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);
      expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
      expect(identityWarnings()).toHaveLength(1);
      expect(identityWarnings()[0]).toContain("73545");
    });

    it("drops the item when the new title does not match", async () => {
      const { prisma, user, movie, ruleSet } = await stickyMovie();
      await prisma.mediaItem.update({ where: { id: movie.id }, data: { title: "Hackers", year: 1995, playCount: 4 } });

      await makeDue(ruleSet.id);
      await executeLifecycleActions(user.id);
      await processLifecycleRules(user.id);

      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
      expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    });
  });

  describe("the one-time upgrade hold", () => {
    // A rule set with no delay has nothing pending between runs — the old guard
    // cancelled each action the moment it was scheduled — so the migration had
    // no row to move. Its actions are held when they are scheduled instead.
    it("holds a series action with no delay until the hold passes, and not a movie's", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const heldUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await prisma.appSettings.create({ data: { userId: user.id, groupedActionsHeldUntil: heldUntil } });
      const server = await createTestServer(user.id);
      const shows = await createTestLibrary(server.id, { type: "SERIES" });
      await seedShow(shows.id);
      const films = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(films.id, { type: "MOVIE", title: "Dune", year: 2021, playCount: 0 });

      const series = await createTestRuleSet(user.id, {
        type: "SERIES", seriesScope: true, rules: UNPLAYED, serverIds: [server.id],
        actionEnabled: true, actionType: "DO_NOTHING", actionDelayDays: 0,
      });
      const movies = await createTestRuleSet(user.id, {
        type: "MOVIE", rules: UNPLAYED, serverIds: [server.id],
        actionEnabled: true, actionType: "DO_NOTHING", actionDelayDays: 0,
      });

      await processLifecycleRules(user.id);
      const [showAction] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: series.id } });
      expect(showAction.scheduledFor.getTime()).toBe(heldUntil.getTime());

      await executeLifecycleActions(user.id);
      expect((await prisma.lifecycleAction.findUnique({ where: { id: showAction.id } }))?.status).toBe("PENDING");
      const [movieAction] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: movies.id } });
      expect(movieAction.status).toBe("COMPLETED");

      // The week is up.
      await prisma.appSettings.update({ where: { userId: user.id }, data: { groupedActionsHeldUntil: new Date(Date.now() - 1000) } });
      await makeDue(series.id);
      await executeLifecycleActions(user.id);
      expect((await prisma.lifecycleAction.findUnique({ where: { id: showAction.id } }))?.status).toBe("COMPLETED");
    });
  });
});
