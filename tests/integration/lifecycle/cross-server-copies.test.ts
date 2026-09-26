/**
 * A title held on two servers is ONE record in the Arr app. Detection
 * collapses the copies onto one match (so one action, one deletion count) —
 * these tests pin down what must still hold for the copy it did not keep.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
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
import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";
import { findExceptedItemIds } from "@/lib/lifecycle/exception-guard";

const prisma = getTestPrisma();

const UNWATCHED = [
  {
    id: "g1",
    condition: "AND",
    rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    groups: [],
  },
];

/** The same movie (TMDB 603) on two servers, plus an unrelated one. */
async function twoServerMovie() {
  const user = await createTestUser();
  const s1 = await createTestServer(user.id);
  const s2 = await createTestServer(user.id);
  const l1 = await createTestLibrary(s1.id, { type: "MOVIE" });
  const l2 = await createTestLibrary(s2.id, { type: "MOVIE" });
  const a = await createTestMediaItem(l1.id, { title: "The Matrix", type: "MOVIE", playCount: 0 });
  const b = await createTestMediaItem(l2.id, { title: "The Matrix", type: "MOVIE", playCount: 0 });
  for (const item of [a, b]) {
    await createTestExternalId(item.id, "TMDB", "603");
    await prisma.mediaItem.update({ where: { id: item.id }, data: { dedupKey: "movie:tmdb:603" } });
  }
  const ruleSet = await createTestRuleSet(user.id, {
    name: "Unwatched",
    type: "MOVIE",
    rules: UNWATCHED,
    serverIds: [s1.id, s2.id],
    actionEnabled: true,
    actionType: "DO_NOTHING",
    actionDelayDays: 0,
  });
  return { user, s1, s2, l1, l2, a, b, ruleSet };
}

describe("cross-server copies of one title", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("matches the title once, recording the other copy", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();

    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches).toHaveLength(1);
    const kept = [a.id, b.id].sort()[0];
    const other = kept === a.id ? b : a;
    expect(matches[0].mediaItemId).toBe(kept);
    const copies = (matches[0].itemData as { copies?: Array<{ id: string; libraryId: string; ratingKey: string }> }).copies;
    expect(copies).toEqual([
      expect.objectContaining({ id: other.id, libraryId: other.libraryId, ratingKey: other.ratingKey }),
    ]);
    expect(matches[0].copyIds).toEqual([other.id]);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(1);

    // "Matched By Rule Set" holds for the copy that was not kept, too.
    const cross = await fetchCrossSystemData([a.id, b.id]);
    expect(cross.get(a.id)?.matchedRuleSets).toEqual(["Unwatched"]);
    expect(cross.get(b.id)?.matchedRuleSets).toEqual(["Unwatched"]);
  });

  it("carries the match and its pending action over when the kept copy stops matching", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const kept = match.mediaItemId === a.id ? a : b;
    const other = kept === a ? b : a;
    const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(action.mediaItemId).toBe(kept.id);

    // Played on its own server: the kept copy no longer matches, the other does.
    await prisma.mediaItem.update({ where: { id: kept.id }, data: { playCount: 1 } });
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([other.id]);
    expect(matches[0].copyIds).toEqual([]);
    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    // The same action, moved — not cancelled and rescheduled.
    expect(pending.map((p) => [p.id, p.mediaItemId])).toEqual([[action.id, other.id]]);
    expect(pending[0].scheduledFor.getTime()).toBe(action.scheduledFor.getTime());
  });

  it("carries over on a sticky rule set without arming a second action", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { stickyMatches: true } });
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const kept = match.mediaItemId === a.id ? a : b;
    const other = kept === a ? b : a;

    await prisma.mediaItem.update({ where: { id: kept.id }, data: { playCount: 1 } });
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([other.id]);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(1);
  });

  it("carries the match over when the rule set is narrowed to the other copy's server", async () => {
    const { user, a, b, s1, s2, ruleSet } = await twoServerMovie();
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const kept = match.mediaItemId === a.id ? a : b;
    const other = kept === a ? b : a;
    const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });

    const otherServer = other.libraryId === (await prisma.library.findFirst({ where: { mediaServerId: s1.id } }))!.id ? s1 : s2;
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { serverIds: [otherServer.id] } });
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([other.id]);
    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(pending.map((p) => [p.id, p.mediaItemId])).toEqual([[action.id, other.id]]);
  });

  it("an exception on the copy detection did not keep disarms the title", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const other = match.mediaItemId === a.id ? b : a;

    // Filed directly (as a bulk scope or an older app version would), so the
    // executor's own check is what stands in the way.
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: other.id } });

    await executeLifecycleActions(user.id);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);

    // …and detection no longer matches either copy.
    await processLifecycleRules(user.id);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
  });

  it("findExceptedItemIds protects every copy of an excepted item, and nothing else", async () => {
    const { user, a, b, l2 } = await twoServerMovie();
    const unrelated = await createTestMediaItem(l2.id, { title: "Other", type: "MOVIE" });
    await prisma.mediaItem.update({ where: { id: unrelated.id }, data: { dedupKey: "movie:tmdb:604" } });
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: a.id } });

    const excepted = await findExceptedItemIds(user.id, [a.id, b.id, unrelated.id]);

    expect([...excepted].sort()).toEqual([a.id, b.id].sort());
  });

  it("reads 'Matched By Rule Set' through malformed copies without failing", async () => {
    const { user, a, b } = await twoServerMovie();
    const ruleSet = await createTestRuleSet(user.id, { name: "Odd", type: "MOVIE" });
    await createTestRuleMatch(ruleSet.id, a.id, { copies: { id: b.id } });

    const cross = await fetchCrossSystemData([a.id, b.id]);

    expect(cross.get(a.id)?.matchedRuleSets).toEqual(["Odd"]);
    expect(cross.get(b.id)?.matchedRuleSets).toEqual([]);
  });
});
