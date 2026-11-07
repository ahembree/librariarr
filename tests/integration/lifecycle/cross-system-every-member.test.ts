/**
 * Matched By Rule Set, Has Pending Action and Server Count at series and
 * artist scope: each episode or track has its own value, and a show or artist
 * matches only when the rule holds for EVERY member, each read with its own
 * values for these fields and the group's values for everything else.
 *
 * Regression: the three were folded into one value for the group — matched by
 * a rule set if any episode was, pending if any episode was, the highest
 * server count of its episodes — so one episode decided for the whole show:
 * "Matched By Rule Set = X" with Delete from Sonarr deleted a show one episode
 * of which X matched, and "Server Count >= 2" a show one episode of which was
 * on a second server. The protective forms ("NOT Matched By Rule Set = Keep",
 * "Has Pending Action = false") read the same either way and are unchanged.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
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
import { evaluateMusicScope, evaluateSeriesScope } from "@/lib/rules/lifecycle-engine";
import { POST as testItemPost } from "@/app/api/lifecycle/rules/test-item/route";

const prisma = getTestPrisma();

type Rule = { field: string; operator: string; value: string; negate?: boolean; condition?: "AND" | "OR" };

function groups(rules: Rule[]): LifecycleRuleGroup[] {
  return [{
    id: "g", condition: "AND", groups: [],
    rules: rules.map((r, i) => ({ id: `r${i + 1}`, condition: "AND" as const, ...r })),
  }];
}

const MATCHED_BY_X = { field: "matchedByRuleSet", operator: "equals", value: "X" };
const PENDING = { field: "hasPendingAction", operator: "equals", value: "true" };
const NOT_PENDING = { field: "hasPendingAction", operator: "equals", value: "false" };
const ON_TWO_SERVERS = { field: "serverCount", operator: "greaterThanOrEqual", value: "2" };

/**
 * One rule per case, and the groups each matches: "All" (every member matched
 * by X, pending, on two servers), "One" (one member that is not its
 * representative), "None" (no member).
 */
const CASES: Array<{ name: string; rule: Rule; matches: string[] }> = [
  { name: "Matched By Rule Set = X", rule: MATCHED_BY_X, matches: ["All"] },
  { name: "NOT Matched By Rule Set = X", rule: { ...MATCHED_BY_X, negate: true }, matches: ["None"] },
  { name: "Has Pending Action = true", rule: PENDING, matches: ["All"] },
  { name: "Has Pending Action = false", rule: NOT_PENDING, matches: ["None"] },
  { name: "Server Count >= 2", rule: ON_TWO_SERVERS, matches: ["All"] },
  { name: "NOT Server Count >= 2", rule: { ...ON_TWO_SERVERS, negate: true }, matches: ["None"] },
];

type Scope = "SERIES" | "MUSIC";

/**
 * Three groups of three members on the main server — "All", "One", "None" —
 * with the members flagged as their names say: matched by the per-member rule
 * set "X", an action of the rule set "Other" pending on them, and a copy on a
 * second server (shared dedupKey). "One" flags its second-lowest id only, so
 * the representative is never the one that differs.
 */
async function seed(type: Scope, options: { playCounts?: Record<string, number> } = {}) {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { name: "Main" });
  const second = await createTestServer(user.id, { name: "Second" });
  const library = await createTestLibrary(server.id, { type });
  const copies = await createTestLibrary(second.id, { type });
  const x = await createTestRuleSet(user.id, { name: "X", type, seriesScope: false, serverIds: [server.id] });
  const other = await createTestRuleSet(user.id, { name: "Other", type, seriesScope: false, serverIds: [server.id] });

  const members: Record<string, string[]> = {};
  for (const name of ["All", "One", "None"]) {
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const item = await createTestMediaItem(library.id, {
        type,
        title: type === "SERIES" ? `${name} E${n}` : `${name} Track ${n}`,
        parentTitle: name,
        ...(type === "SERIES" ? { seasonNumber: 1, episodeNumber: n } : {}),
        playCount: options.playCounts?.[name] ?? 0,
      });
      ids.push(item.id);
    }
    members[name] = [...ids].sort();
  }
  const flagged = [...members.All, members.One[1]];
  for (const id of flagged) {
    await createTestRuleMatch(x.id, id, { id, title: "flagged", memberIds: [id] });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: id, ruleSetId: other.id, actionType: type === "SERIES" ? "DELETE_FILES_SONARR" : "DELETE_FILES_LIDARR",
        status: "PENDING", scheduledFor: new Date(Date.now() + 86_400_000), matchedMediaItemIds: [id],
      },
    });
    await prisma.mediaItem.update({ where: { id }, data: { dedupKey: `dedup-${id}` } });
    const copy = await createTestMediaItem(copies.id, { type, title: "Copy", parentTitle: "Copy elsewhere" });
    await prisma.mediaItem.update({ where: { id: copy.id }, data: { dedupKey: `dedup-${id}` } });
  }
  return { user, server, members };
}

async function evaluate(type: Scope, serverId: string, rules: LifecycleRuleGroup[], excludeRuleSetId?: string) {
  const items = type === "SERIES"
    ? await evaluateSeriesScope(rules, [serverId], undefined, undefined, false, { excludeRuleSetId })
    : await evaluateMusicScope(rules, [serverId], undefined, { excludeRuleSetId });
  return items.map((i) => i.title as string).sort();
}

describe("cross-system criteria at series and artist scope are judged through every member", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  describe.each(["SERIES", "MUSIC"] as const)("%s scope", (type) => {
    it.each(CASES)("$name matches $matches", async ({ rule, matches }) => {
      const { server } = await seed(type);
      expect(await evaluate(type, server.id, groups([rule]))).toEqual(matches);
    });

    it("never lets one member decide: a group whose one member has the value is not matched by the positive form", async () => {
      // The fold read "One" as matched by X, pending and on two servers.
      const { server } = await seed(type);
      for (const rule of [MATCHED_BY_X, PENDING, ON_TWO_SERVERS]) {
        expect(await evaluate(type, server.id, groups([rule])), rule.field).not.toContain("One");
      }
    });

    it("reads the group's own value for a group field beside it: AND", async () => {
      // "All" is matched by X on every member; unwatched as a whole it matches.
      const unwatched = await seed(type);
      const rules = groups([MATCHED_BY_X, { field: "playCount", operator: "equals", value: "0" }]);
      expect(await evaluate(type, unwatched.server.id, rules)).toEqual(["All"]);

      await cleanDatabase();
      const watched = await seed(type, { playCounts: { All: 1 } });
      expect(await evaluate(type, watched.server.id, rules)).toEqual([]);
    });

    it("reads the group's own value for a group field beside it: OR, every member passing either way", async () => {
      const rules = groups([MATCHED_BY_X, { field: "playCount", operator: "equals", value: "0", condition: "OR" }]);
      // Unwatched groups pass on their play total, whatever their members' X.
      const unwatched = await seed(type);
      expect(await evaluate(type, unwatched.server.id, rules)).toEqual(["All", "None", "One"]);

      // Watched, only a group every member of which X matched still passes:
      // "One" has members X did not match.
      await cleanDatabase();
      const watched = await seed(type, { playCounts: { All: 2, One: 2, None: 2 } });
      expect(await evaluate(type, watched.server.id, rules)).toEqual(["All"]);
    });
  });

  /**
   * The rule set the docs describe: delete unwatched shows, never one any
   * episode of which the Keep rule set matched or another rule set has already
   * scheduled. Folded or per episode, it selects the same shows.
   */
  async function protectiveRuleSet() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const shows: Record<string, string[]> = {};
    for (const name of ["Kept Show", "Queued Show", "Free Show"]) {
      shows[name] = [];
      for (let n = 1; n <= 3; n++) {
        const ep = await createTestMediaItem(library.id, {
          type: "SERIES", title: `E${n}`, parentTitle: name, seasonNumber: 1, episodeNumber: n, playCount: 0,
        });
        shows[name].push(ep.id);
      }
      shows[name].sort();
    }
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: false, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, shows["Kept Show"][2], { id: shows["Kept Show"][2], title: "Kept Show", memberIds: [shows["Kept Show"][2]] });
    const other = await createTestRuleSet(user.id, { name: "Other", type: "SERIES" });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: shows["Queued Show"][1], ruleSetId: other.id, actionType: "DELETE_FILES_SONARR",
        status: "PENDING", scheduledFor: new Date(Date.now() + 86_400_000), matchedMediaItemIds: [shows["Queued Show"][1]],
      },
    });
    const rules = groups([
      { field: "playCount", operator: "equals", value: "0" },
      { field: "matchedByRuleSet", operator: "equals", value: "Keep", negate: true },
      NOT_PENDING,
    ]);
    const cleanup = await createTestRuleSet(user.id, {
      name: "Cleanup", type: "SERIES", seriesScope: true, rules, serverIds: [server.id],
      actionEnabled: true, actionType: "DELETE_SONARR", arrInstanceId: "sonarr-1",
    });

    const { items } = await detectAndSaveMatches(
      { ...cleanup, type: "SERIES", rules, seriesScope: true, serverIds: [server.id] } as never,
      [server.id],
    );
    return { items, cleanup };
  }

  it("keeps an existing protective rule set's matches: unwatched shows Keep did not match and nothing is pending on", async () => {
    const { items, cleanup } = await protectiveRuleSet();

    expect(items.map((i) => i.title)).toEqual(["Free Show"]);
    const stored = await prisma.ruleMatch.findMany({ where: { ruleSetId: cleanup.id } });
    expect(stored.map((m) => (m.itemData as { title: string }).title)).toEqual(["Free Show"]);
    expect((items[0].matchedCriteria as Array<{ ruleId: string }>).map((c) => c.ruleId)).toEqual(["r1", "r2", "r3"]);
  });

  it("reports the protective rule set's criteria with every episode's values", async () => {
    const { items } = await protectiveRuleSet();
    const criteria = (items[0].matchedCriteria as Array<{ ruleId: string; actualValue?: string }>);
    expect(criteria.map((c) => [c.ruleId, c.actualValue])).toEqual([["r1", "0"], ["r2", "none"], ["r3", "false"]]);
  });

  describe("what a match reports", () => {
    it("names a cross-system criterion matched only when every member holds it, with the members' own values", async () => {
      const { user, server } = await seed("SERIES", { playCounts: { All: 0, One: 0, None: 1 } });
      const rules = groups([
        MATCHED_BY_X,
        { field: "playCount", operator: "equals", value: "0", condition: "OR" },
        { ...ON_TWO_SERVERS, condition: "OR" },
      ]);
      const rs = await createTestRuleSet(user.id, { name: "Report", type: "SERIES", seriesScope: true, rules, serverIds: [server.id] });
      const { items } = await detectAndSaveMatches(
        { ...rs, type: "SERIES", rules, seriesScope: true, serverIds: [server.id] } as never,
        [server.id],
      );
      const byTitle = new Map(items.map((i) => [i.title as string, i]));
      expect([...byTitle.keys()].sort()).toEqual(["All", "One"]);

      const all = byTitle.get("All")!;
      expect((all.matchedCriteria as Array<{ ruleId: string; actualValue?: string }>).map((c) => [c.ruleId, c.actualValue])).toEqual([
        ["r1", "X"], ["r2", "0"], ["r3", "2"],
      ]);
      // "One" matched on its play total alone: X matched one of its three
      // episodes and one is on a second server, so neither criterion holds for
      // the show, and its values say how many episodes have which.
      const one = byTitle.get("One")!;
      expect((one.matchedCriteria as Array<{ ruleId: string }>).map((c) => c.ruleId)).toEqual(["r2"]);
      expect(one.actualValues).toEqual({ r1: "none (2 of 3); X (1 of 3)", r2: "0", r3: "1 (2 of 3); 2 (1 of 3)" });

      // Stored as reported, and never with a folded value for the show.
      const stored = await prisma.ruleMatch.findMany({ where: { ruleSetId: rs.id } });
      const storedOne = stored.find((m) => (m.itemData as { title: string }).title === "One")!.itemData as Record<string, unknown>;
      expect(storedOne.actualValues).toEqual(one.actualValues);
      expect(storedOne).not.toHaveProperty("serverCount");
      expect(storedOne).not.toHaveProperty("matchedRuleSets");
      expect(storedOne).not.toHaveProperty("hasPendingAction");
    });

    it("reports a single item's Matched By Rule Set by name", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Kept Film" });
      for (const name of ["Keep", "Archive"]) {
        const rs = await createTestRuleSet(user.id, { name, type: "MOVIE", serverIds: [server.id] });
        await createTestRuleMatch(rs.id, movie.id, { id: movie.id, title: "Kept Film" });
      }
      const rules = groups([{ field: "matchedByRuleSet", operator: "equals", value: "Keep" }]);
      const rs = await createTestRuleSet(user.id, { name: "Follow-up", type: "MOVIE", rules, serverIds: [server.id] });
      const { items } = await detectAndSaveMatches(
        { ...rs, type: "MOVIE", rules, seriesScope: false, serverIds: [server.id] } as never,
        [server.id],
      );
      expect((items[0].matchedCriteria as Array<{ actualValue?: string }>)[0].actualValue).toBe("Archive, Keep");
    });
  });

  describe("Test Media", () => {
    async function testItem(body: Record<string, unknown>) {
      return expectJson<{ matches: boolean; matchedCriteria: Array<{ ruleId: string }>; actualValues: Record<string, string> }>(
        await callRoute(testItemPost, { url: "/api/lifecycle/rules/test-item", method: "POST", body }),
        200,
      );
    }

    it.each(["SERIES", "MUSIC"] as const)("answers %s scope as detection does, through every member", async (type) => {
      const { user, server, members } = await seed(type);
      setMockSession({ isLoggedIn: true, userId: user.id });
      for (const { rule, matches } of CASES) {
        for (const name of ["All", "One", "None"]) {
          // Tested through its representative and through the member that differs.
          for (const mediaItemId of [members[name][0], members[name][1]]) {
            const body = await testItem({ rules: groups([rule]), type, seriesScope: true, mediaItemId, serverIds: [server.id] });
            expect(body.matches, `${rule.field}${rule.negate ? " (NOT)" : ""} on ${name}`).toBe(matches.includes(name));
          }
        }
      }
      // The values it reports are each member's.
      const one = await testItem({ rules: groups([MATCHED_BY_X]), type, seriesScope: true, mediaItemId: members.One[0], serverIds: [server.id] });
      expect(one.matchedCriteria).toEqual([]);
      expect(one.actualValues).toEqual({ r1: "none (2 of 3); X (1 of 3)" });
    });

    it("reads one episode's own values with series scope off", async () => {
      const { user, server, members } = await seed("SERIES");
      setMockSession({ isLoggedIn: true, userId: user.id });
      const flagged = await testItem({ rules: groups([MATCHED_BY_X]), type: "SERIES", seriesScope: false, mediaItemId: members.One[1], serverIds: [server.id] });
      const plain = await testItem({ rules: groups([MATCHED_BY_X]), type: "SERIES", seriesScope: false, mediaItemId: members.One[0], serverIds: [server.id] });
      expect([flagged.matches, plain.matches]).toEqual([true, false]);
    });
  });
});
