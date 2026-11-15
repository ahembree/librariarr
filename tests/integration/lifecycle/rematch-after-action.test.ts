/**
 * A non-destructive action that completed on an item suppresses the same
 * action while the item keeps matching — but once the item stops matching
 * (detection drops its match) and later matches again, the same action is
 * scheduled again: detection releases the settled action (`releasedAt`).
 * Reported: a quality-profile change ran, the profile was changed back by
 * hand, the movie matched again and no action was ever scheduled.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
} from "../../setup/test-helpers";
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

import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { scheduleActionsForRuleSet } from "@/lib/lifecycle/processor";

const rules: LifecycleRuleGroup[] = [
  {
    id: "g", condition: "AND", groups: [],
    rules: [{ id: "r", field: "playCount", operator: "equals", value: "0", condition: "AND" }],
  },
];

describe("re-match after a completed non-destructive action", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  async function setup({ stickyMatches = false }: { stickyMatches?: boolean } = {}) {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { type: "MOVIE", title: "Heat", playCount: 0 });
    const created = await createTestRuleSet(user.id, {
      type: "MOVIE", rules, serverIds: [server.id],
      actionEnabled: true, actionType: "CHANGE_QUALITY_PROFILE_RADARR", targetQualityProfileId: 4,
    });
    const ruleSet = await prisma.ruleSet.update({ where: { id: created.id }, data: { stickyMatches } });
    const cfg = { ...ruleSet, type: "MOVIE", rules, serverIds: [server.id] } as never;
    const detectAndSchedule = async (fullReEval = false) => {
      const result = await detectAndSaveMatches(cfg, [server.id], undefined, undefined, fullReEval);
      if ("discarded" in result) throw new Error("discarded");
      await scheduleActionsForRuleSet(cfg, result.items, result.episodeIdMap);
    };
    const complete = async () => {
      await prisma.lifecycleAction.updateMany({
        where: { ruleSetId: ruleSet.id, status: "PENDING" },
        data: { status: "COMPLETED", executedAt: new Date() },
      });
    };
    const pending = () => prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    return { prisma, item, ruleSet, detectAndSchedule, complete, pending };
  }

  it("does not re-schedule while the item stays matched", async () => {
    const { detectAndSchedule, complete, pending } = await setup();
    await detectAndSchedule();
    expect(await pending()).toHaveLength(1);
    await complete();

    await detectAndSchedule();
    expect(await pending()).toHaveLength(0);
  });

  it("schedules the same action again once the item stopped matching and matches again", async () => {
    const { prisma, item, ruleSet, detectAndSchedule, complete, pending } = await setup();
    await detectAndSchedule();
    await complete();

    // Stops matching: the match is dropped and the completed action released.
    await prisma.mediaItem.update({ where: { id: item.id }, data: { playCount: 1 } });
    await detectAndSchedule();
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    const settled = await prisma.lifecycleAction.findFirstOrThrow({ where: { ruleSetId: ruleSet.id, status: "COMPLETED" } });
    expect(settled.releasedAt).not.toBeNull();
    expect(await pending()).toHaveLength(0);

    // Matches again (e.g. changed back by hand): a new action is scheduled.
    await prisma.$executeRaw`UPDATE "MediaItem" SET "playCount" = 0 WHERE id = ${item.id}`;
    await detectAndSchedule();
    const again = await pending();
    expect(again.map((a) => [a.mediaItemId, a.actionType])).toEqual([[item.id, "CHANGE_QUALITY_PROFILE_RADARR"]]);

    // And that one, once completed, suppresses again while the item stays matched.
    await complete();
    await detectAndSchedule();
    expect(await pending()).toHaveLength(0);
  });

  it("releases on a full re-evaluation that drops the item too", async () => {
    const { prisma, item, ruleSet, detectAndSchedule, complete, pending } = await setup();
    await detectAndSchedule();
    await complete();

    await prisma.mediaItem.update({ where: { id: item.id }, data: { playCount: 1 } });
    await detectAndSchedule(true);
    await prisma.$executeRaw`UPDATE "MediaItem" SET "playCount" = 0 WHERE id = ${item.id}`;
    await detectAndSchedule(true);
    expect((await pending()).map((a) => a.mediaItemId)).toEqual([item.id]);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, releasedAt: { not: null } } })).toBe(1);
  });

  it("does not release when sticky matches keep the item matched", async () => {
    const { prisma, item, ruleSet, detectAndSchedule, complete, pending } = await setup({ stickyMatches: true });
    await detectAndSchedule();
    await complete();

    await prisma.mediaItem.update({ where: { id: item.id }, data: { playCount: 1 } });
    await detectAndSchedule();
    await prisma.$executeRaw`UPDATE "MediaItem" SET "playCount" = 0 WHERE id = ${item.id}`;
    await detectAndSchedule();
    expect(await pending()).toHaveLength(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, releasedAt: { not: null } } })).toBe(0);
  });

  it("keeps a show's episode coverage when its representative episode moves", async () => {
    // A show's match is stored against its lowest-id episode. When that
    // episode is excepted the match moves to the next one: the old row is
    // dropped, but the show never stopped matching, so the action that
    // covered its other episodes must keep suppressing them.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (const ep of [1, 2, 3]) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `E${ep}`, parentTitle: "Lost", seriesKey: "tvdb:1",
        seasonNumber: 1, episodeNumber: ep, playCount: 0,
      }));
    }
    const created = await createTestRuleSet(user.id, {
      type: "SERIES", rules, serverIds: [server.id], seriesScope: false,
      actionEnabled: true, actionType: "UNMONITOR_SONARR",
    });
    const cfg = { ...created, type: "SERIES", rules, serverIds: [server.id] } as never;
    const run = async () => {
      const result = await detectAndSaveMatches(cfg, [server.id]);
      if ("discarded" in result) throw new Error("discarded");
      await scheduleActionsForRuleSet(cfg, result.items, result.episodeIdMap);
    };
    await run();
    await prisma.lifecycleAction.updateMany({
      where: { ruleSetId: created.id, status: "PENDING" },
      data: { status: "COMPLETED", executedAt: new Date() },
    });
    const representative = (await prisma.ruleMatch.findFirstOrThrow({ where: { ruleSetId: created.id } })).mediaItemId;

    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: representative } });
    await run();

    const moved = await prisma.ruleMatch.findFirstOrThrow({ where: { ruleSetId: created.id } });
    expect(moved.mediaItemId).not.toBe(representative);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: created.id, status: "PENDING" } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: created.id, releasedAt: { not: null } } })).toBe(0);
  });

  it("schedules a show's action again once the whole show stopped matching and matches again", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    for (const ep of [1, 2]) {
      await createTestMediaItem(library.id, {
        type: "SERIES", title: `E${ep}`, parentTitle: "Lost", seriesKey: "tvdb:1",
        seasonNumber: 1, episodeNumber: ep, playCount: 0,
      });
    }
    const created = await createTestRuleSet(user.id, {
      type: "SERIES", rules, serverIds: [server.id], seriesScope: false,
      actionEnabled: true, actionType: "UNMONITOR_SONARR",
    });
    const cfg = { ...created, type: "SERIES", rules, serverIds: [server.id] } as never;
    const run = async () => {
      const result = await detectAndSaveMatches(cfg, [server.id]);
      if ("discarded" in result) throw new Error("discarded");
      await scheduleActionsForRuleSet(cfg, result.items, result.episodeIdMap);
    };
    const pending = () => prisma.lifecycleAction.findMany({ where: { ruleSetId: created.id, status: "PENDING" } });
    await run();
    await prisma.lifecycleAction.updateMany({
      where: { ruleSetId: created.id, status: "PENDING" },
      data: { status: "COMPLETED", executedAt: new Date() },
    });

    await prisma.mediaItem.updateMany({ where: { libraryId: library.id }, data: { playCount: 1 } });
    await run();
    expect(await pending()).toHaveLength(0);
    await prisma.$executeRaw`UPDATE "MediaItem" SET "playCount" = 0 WHERE "libraryId" = ${library.id}`;
    await run();
    const again = await pending();
    expect(again).toHaveLength(1);
    expect(again[0].matchedMediaItemIds).toHaveLength(2);
  });

  it("does not release an item whose server the run left out (disabled), so it does not re-fire on return", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const s1 = await createTestServer(user.id);
    const s2 = await createTestServer(user.id);
    const lib1 = await createTestLibrary(s1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(s2.id, { type: "MOVIE" });
    await createTestMediaItem(lib1.id, { type: "MOVIE", title: "Heat", playCount: 0 });
    const other = await createTestMediaItem(lib2.id, { type: "MOVIE", title: "Ronin", playCount: 0 });
    const created = await createTestRuleSet(user.id, {
      type: "MOVIE", rules, serverIds: [s1.id, s2.id],
      actionEnabled: true, actionType: "SEARCH_RADARR",
    });
    const cfg = { ...created, type: "MOVIE", rules, serverIds: [s1.id, s2.id] } as never;
    const run = async (serverIds: string[]) => {
      const result = await detectAndSaveMatches(cfg, serverIds);
      if ("discarded" in result) throw new Error("discarded");
      await scheduleActionsForRuleSet(cfg, result.items, result.episodeIdMap);
    };
    await run([s1.id, s2.id]);
    await prisma.lifecycleAction.updateMany({
      where: { ruleSetId: created.id, status: "PENDING" },
      data: { status: "COMPLETED", executedAt: new Date() },
    });

    // Server 2 disabled: the processor evaluates server 1 alone.
    await run([s1.id]);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: created.id, mediaItemId: other.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: created.id, releasedAt: { not: null } } })).toBe(0);

    // Enabled again: matched again, but never stopped matching — no new search.
    await run([s1.id, s2.id]);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: created.id, status: "PENDING" } })).toBe(0);
  });
});
