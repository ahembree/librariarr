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
});
