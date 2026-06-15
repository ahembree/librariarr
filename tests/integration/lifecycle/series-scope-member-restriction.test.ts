/**
 * Regression: a SERIES rule with `seriesScope=false` that references a
 * series-aggregate field is forced through the series-aggregate path. Its
 * member episodes must then be restricted to the episodes that individually
 * satisfy the per-episode conditions — otherwise a member-scoped file delete
 * (DELETE_FILES_SONARR) would delete EVERY episode file of the series, not just
 * the matching ones. With `seriesScope=true` (whole-series intent) every
 * episode stays a member.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

import { evaluateSeriesScope } from "@/lib/rules/lifecycle-engine";

// availableEpisodeCount (aggregate, forces the series path) AND year=2020
// (per-episode). The aggregate evaluates `year` against the representative
// episode, so the series matches when the representative is 2020.
const mixedRule: LifecycleRuleGroup[] = [
  {
    id: "g1",
    condition: "AND",
    rules: [
      { id: "r1", field: "availableEpisodeCount", operator: "greaterThan", value: "0", condition: "AND" },
      { id: "r2", field: "year", operator: "equals", value: "2020", condition: "AND" },
    ],
    groups: [],
  },
];

describe("evaluateSeriesScope — member restriction for seriesScope=false + aggregate", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seedShow() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let e = 1; e <= 3; e++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `S1E${e}`, parentTitle: "ShowX",
        seasonNumber: 1, episodeNumber: e, year: 2010,
      }));
    }
    // The representative is the lowest-id episode; make it the 2020 match so the
    // series matches at the aggregate level. The other two stay 2010.
    const repId = eps.map((e) => e.id).sort()[0];
    const prisma = getTestPrisma();
    await prisma.mediaItem.update({ where: { id: repId }, data: { year: 2020 } });
    return { serverId: server.id, repId, allIds: eps.map((e) => e.id) };
  }

  it("restricts members to per-episode matches when seriesScope is false", async () => {
    const { serverId, repId } = await seedShow();

    const matched = await evaluateSeriesScope(mixedRule, [serverId], undefined, undefined, true);

    expect(matched).toHaveLength(1);
    const members = (matched[0] as unknown as { memberIds: string[] }).memberIds;
    // Only the representative episode (year 2020) — NOT the two 2010 episodes.
    expect(members).toEqual([repId]);
  });

  it("keeps every episode as a member when seriesScope is true", async () => {
    const { serverId, allIds } = await seedShow();

    const matched = await evaluateSeriesScope(mixedRule, [serverId], undefined, undefined, false);

    expect(matched).toHaveLength(1);
    const members = (matched[0] as unknown as { memberIds: string[] }).memberIds;
    expect(new Set(members)).toEqual(new Set(allIds));
  });
});
