/**
 * Per-episode (seriesScope=false) SERIES rule set whose group representative
 * is excepted: detection promotes a remaining member to stand for the group.
 * It took `remainingMembers[0]` — the engine's unordered row order — so a sync
 * rewriting one episode row (Postgres writes a new tuple version, which moves
 * in a sequential scan) re-keyed the match on the next run: the held match was
 * dropped as stale, its PENDING action cancelled and a new one scheduled
 * `actionDelayDays` out; a sticky rule set kept both and armed two actions
 * against one Sonarr series.
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

describe("excepted representative promotion", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  for (const sticky of [false, true]) {
    it(`keeps one stable match and one action across a row rewrite (sticky=${sticky})`, async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const eps = [];
      for (let n = 1; n <= 4; n++) {
        eps.push(await createTestMediaItem(library.id, {
          type: "SERIES", title: `Ep ${n}`, parentTitle: "The Show", seasonNumber: 1, episodeNumber: n, playCount: 0,
        }));
      }
      const sorted = [...eps].sort((a, b) => a.id.localeCompare(b.id));
      // The user protects the representative (lowest-id) episode.
      await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: sorted[0].id } });

      const ruleSet = await createTestRuleSet(user.id, {
        type: "SERIES", seriesScope: false, rules, serverIds: [server.id],
        actionEnabled: true, actionType: "DELETE_FILES_SONARR", actionDelayDays: 30, arrInstanceId: "sonarr-1",
      });
      await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { stickyMatches: sticky } });
      const cfg = { ...ruleSet, stickyMatches: sticky, type: "SERIES", rules, seriesScope: false, serverIds: [server.id] } as never;

      const run = async () => {
        const r = await detectAndSaveMatches(cfg, [server.id]);
        await scheduleActionsForRuleSet({ ...ruleSet, stickyMatches: sticky } as never, r.items, r.episodeIdMap);
      };

      await run();
      const firstMatch = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
      const firstAction = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
      expect(firstMatch).toHaveLength(1);
      expect(firstAction).toHaveLength(1);
      // The excepted representative is replaced by the LOWEST remaining member
      // id, never whichever row the engine happened to return first.
      expect(firstMatch[0].mediaItemId).toBe(sorted[1].id);
      expect(firstAction[0].mediaItemId).toBe(sorted[1].id);

      // A sync rewrites the promoted episode's row (e.g. a metadata refresh):
      // Postgres writes a new tuple version, so it moves in the scan order.
      // Repeated a few times, as successive syncs would. The title changes
      // too: it is indexed, so the update cannot be HOT and the new version
      // really does land at the end of the heap — a summary-only update stays
      // in place and would never reorder the engine's rows.
      for (let i = 0; i < 3; i++) {
        const [current] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
        await prisma.mediaItem.update({
          where: { id: current.mediaItemId },
          data: { summary: `refreshed ${i}`, title: `Ep refreshed ${i}` },
        });
        await run();
        const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
        const actions = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
        expect(matches.map((m) => m.mediaItemId)).toEqual([firstMatch[0].mediaItemId]);
        expect(actions.map((a) => a.id)).toEqual([firstAction[0].id]);
      }
    });
  }
});
