/**
 * Cross-system fields (Matched By Rule Set, Has Pending Action, Server Count)
 * were filled in by `fetchCrossSystemData` only on the per-item engine path,
 * and only for a match's representative. The series-scope (the default for
 * SERIES rule sets) and artist-scope engines and the query page's grouped
 * series view never enriched their records, so every show read "matched by no
 * rule set, no pending action, on one server" — and the other episodes of a
 * show held by a series match read unmatched on every path. An exclusion such
 * as "NOT Matched By Rule Set = Keep" on a DELETE rule set failed open.
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
import { executeQuery } from "@/lib/query/query-engine";
import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";
import { POST as testItemPost } from "@/app/api/lifecycle/rules/test-item/route";

describe("cross-system fields on grouped records", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("a show the 'Keep' rule set matched is not deleted by 'NOT Matched By Rule Set = Keep'", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 3; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Favourite Show", seasonNumber: 1, episodeNumber: n, playCount: 0,
      }));
    }
    // Control: an unwatched show Keep did not match, which the rule set must select.
    await createTestMediaItem(library.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Unkept Show", seasonNumber: 1, episodeNumber: 1, playCount: 0,
    });
    const repId = eps.map((e) => e.id).sort()[0];

    // "Keep" (series scope) matched the show — stored on its representative.
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Favourite Show", parentTitle: null, memberIds: eps.map((e) => e.id) });

    // The DELETE rule set: unwatched shows that "Keep" did NOT match.
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [
        { id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" },
        { id: "r2", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true },
      ],
    }];
    const cleanup = await createTestRuleSet(user.id, {
      name: "Cleanup", type: "SERIES", seriesScope: true, rules, serverIds: [server.id],
      actionEnabled: true, actionType: "DELETE_SONARR", arrInstanceId: "sonarr-1",
    });

    const { items } = await detectAndSaveMatches(
      { ...cleanup, type: "SERIES", rules, seriesScope: true, serverIds: [server.id] } as never,
      [server.id],
    );

    expect(items.map((i) => i.title)).toEqual(["Unkept Show"]);
    const stored = await getTestPrisma().ruleMatch.findMany({ where: { ruleSetId: cleanup.id } });
    expect(stored.map((m) => (m.itemData as { title: string }).title)).toEqual(["Unkept Show"]);
  });

  it("reports a series-scope cross-system rule among the matched criteria it matched on", async () => {
    // The Matches page, the preview and the diff explain a match from the
    // records the engine returns. The series-scope engine evaluated the folded
    // values on a copy, so the stored match said "Matched By Rule Set = Keep"
    // did NOT hold on a show selected because it did.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 2; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Favourite Show", seasonNumber: 1, episodeNumber: n,
      }));
    }
    const repId = eps.map((e) => e.id).sort()[0];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Favourite Show", parentTitle: null, memberIds: eps.map((e) => e.id) });
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND" }],
    }];
    const rs = await createTestRuleSet(user.id, { name: "Follow-up", type: "SERIES", seriesScope: true, rules, serverIds: [server.id] });

    const { items } = await detectAndSaveMatches(
      { ...rs, type: "SERIES", rules, seriesScope: true, serverIds: [server.id] } as never,
      [server.id],
    );

    expect(items.map((i) => i.title)).toEqual(["Favourite Show"]);
    const criteria = items[0].matchedCriteria as Array<{ ruleId: string }>;
    expect(criteria.map((c) => c.ruleId)).toEqual(["r1"]);
    const [stored] = await getTestPrisma().ruleMatch.findMany({ where: { ruleSetId: rs.id } });
    expect((stored.itemData as { matchedCriteria: Array<{ ruleId: string }> }).matchedCriteria.map((c) => c.ruleId)).toEqual(["r1"]);
  });

  it("reports an artist-scope cross-system rule among the matched criteria it matched on", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    const tracks = [];
    for (let n = 1; n <= 2; n++) {
      tracks.push(await createTestMediaItem(library.id, { type: "MUSIC", title: `Song ${n}`, parentTitle: "Kept Artist" }));
    }
    const repId = tracks.map((t) => t.id).sort()[0];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "MUSIC", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Kept Artist", parentTitle: null, memberIds: tracks.map((t) => t.id) });
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND" }],
    }];
    const rs = await createTestRuleSet(user.id, { name: "Follow-up", type: "MUSIC", seriesScope: true, rules, serverIds: [server.id] });

    const { items } = await detectAndSaveMatches(
      { ...rs, type: "MUSIC", rules, seriesScope: true, serverIds: [server.id] } as never,
      [server.id],
    );

    expect(items).toHaveLength(1);
    expect((items[0].matchedCriteria as Array<{ ruleId: string }>).map((c) => c.ruleId)).toEqual(["r1"]);
  });

  it("'Has Pending Action = false' does not match a show that has one", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 2; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Queued Show", seasonNumber: 1, episodeNumber: n,
      }));
    }
    // Control: a show nothing is pending on.
    await createTestMediaItem(library.id, { type: "SERIES", title: "Pilot", parentTitle: "Free Show", seasonNumber: 1, episodeNumber: 1 });
    const repId = eps.map((e) => e.id).sort()[0];
    const other = await createTestRuleSet(user.id, { name: "Other", type: "SERIES" });
    await getTestPrisma().lifecycleAction.create({
      data: { userId: user.id, mediaItemId: repId, ruleSetId: other.id, actionType: "DELETE_SONARR", status: "PENDING", scheduledFor: new Date(Date.now() + 86400000) },
    });

    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "hasPendingAction", operator: "equals", value: "false", condition: "AND" }],
    }];
    const rs = await createTestRuleSet(user.id, { name: "NoPending", type: "SERIES", seriesScope: true, rules, serverIds: [server.id] });
    const { items } = await detectAndSaveMatches(
      { ...rs, type: "SERIES", rules, seriesScope: true, serverIds: [server.id] } as never,
      [server.id],
    );
    expect(items.map((i) => i.title)).toEqual(["Free Show"]);
  });
  it("control: the same rule on a MOVIE rule set (per-item path) excludes the kept movie", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Favourite Movie", playCount: 0 });
    const unkept = await createTestMediaItem(library.id, { type: "MOVIE", title: "Other Movie", playCount: 0 });
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "MOVIE", serverIds: [server.id] });
    await createTestRuleMatch(keep.id, movie.id, { id: movie.id, title: "Favourite Movie" });
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [
        { id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" },
        { id: "r2", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true },
      ],
    }];
    const rs = await createTestRuleSet(user.id, { name: "Cleanup", type: "MOVIE", rules, serverIds: [server.id] });
    const { items } = await detectAndSaveMatches(
      { ...rs, type: "MOVIE", rules, seriesScope: false, serverIds: [server.id] } as never,
      [server.id],
    );
    expect(items.map((i) => i.id)).toEqual([unkept.id]);
  });

  it("query page (grouped series view) does not list a show 'Keep' matched for 'NOT Matched By Rule Set = Keep'", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 2; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Favourite Show", seasonNumber: 1, episodeNumber: n, playCount: 0,
      }));
    }
    // Control: a show Keep did not match.
    await createTestMediaItem(library.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Other Show", seasonNumber: 1, episodeNumber: 1, playCount: 0,
    });
    const repId = eps.map((e) => e.id).sort()[0];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Favourite Show", parentTitle: null, memberIds: eps.map((e) => e.id) });

    const result = await executeQuery({
      mediaTypes: ["SERIES"], serverIds: [server.id], sortBy: "title", sortOrder: "asc",
      groups: [{
        id: "g", condition: "AND", groups: [],
        rules: [{ id: "r", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true }],
      }] as never,
    }, user.id, 1, 0);
    expect(result.items.map((i) => i.title)).toEqual(["Other Show"]);
  });
  it("per-episode scope: episodes of a show 'Keep' matched (stored on its representative) also read as kept", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 3; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Favourite Show", seasonNumber: 1, episodeNumber: n, playCount: 0,
      }));
    }
    // Control: an unwatched episode of a show Keep did not match.
    await createTestMediaItem(library.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Other Show", seasonNumber: 1, episodeNumber: 1, playCount: 0,
    });
    const sorted = [...eps].sort((a, b) => a.id.localeCompare(b.id));
    // The representative episode was watched, so the cleanup group below does not include it.
    await getTestPrisma().mediaItem.update({ where: { id: sorted[0].id }, data: { playCount: 1 } });
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, sorted[0].id, { id: sorted[0].id, title: "Favourite Show", parentTitle: null, memberIds: eps.map((e) => e.id) });

    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [
        { id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" },
        { id: "r2", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true },
      ],
    }];
    const rs = await createTestRuleSet(user.id, {
      name: "Cleanup", type: "SERIES", seriesScope: false, rules, serverIds: [server.id],
      actionEnabled: true, actionType: "DELETE_FILES_SONARR", arrInstanceId: "sonarr-1",
    });
    const { items } = await detectAndSaveMatches(
      { ...rs, type: "SERIES", rules, seriesScope: false, serverIds: [server.id] } as never,
      [server.id],
    );
    expect(items.map((i) => i.title)).toEqual(["Other Show"]);
  });
  it("series scope forced by an aggregate field: each episode is judged on its own cross-system values", async () => {
    // seriesScope off, but a series-aggregate field routes detection through
    // evaluateSeriesScope, which then keeps as members only the episodes that
    // match on their own. Those per-episode records carried no cross-system
    // values, so a positive "Matched By Rule Set" read false for every episode
    // and the show was stored with no members at all.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 3; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Tagged Show", seasonNumber: 1, episodeNumber: n,
      }));
    }
    // "Tagged" (per-episode) matched episode 2 alone.
    const tagged = await createTestRuleSet(user.id, { name: "Tagged", type: "SERIES", seriesScope: false, serverIds: [server.id] });
    await createTestRuleMatch(tagged.id, eps[1].id, { id: eps[1].id, title: "Tagged Show", parentTitle: null, memberIds: [eps[1].id] });

    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [
        { id: "r1", field: "availableEpisodeCount", operator: "greaterThan", value: "0", condition: "AND" },
        { id: "r2", field: "matchedByRuleSet", operator: "equals", value: "Tagged", condition: "AND" },
      ],
    }];
    const rs = await createTestRuleSet(user.id, { name: "Follow-up", type: "SERIES", seriesScope: false, rules, serverIds: [server.id] });
    const { episodeIdMap } = await detectAndSaveMatches(
      { ...rs, type: "SERIES", rules, seriesScope: false, serverIds: [server.id] } as never,
      [server.id],
    );

    const [match] = await getTestPrisma().ruleMatch.findMany({ where: { ruleSetId: rs.id } });
    expect((match.itemData as { memberIds?: string[] }).memberIds).toEqual([eps[1].id]);
    expect([...episodeIdMap.values()]).toEqual([[eps[1].id]]);
  });

  it("query page (series aggregate path) does not list a show 'Keep' matched for 'NOT Matched By Rule Set = Keep'", async () => {
    // A series-aggregate field sends the grouped query through
    // `computeAggregateSurvivingEpisodeIds`, whose aggregate records carried no
    // cross-system values — every show read "matched by no rule set".
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 2; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Favourite Show", seasonNumber: 1, episodeNumber: n, playCount: 0,
      }));
    }
    await createTestMediaItem(library.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Other Show", seasonNumber: 1, episodeNumber: 1, playCount: 0,
    });
    const repId = eps.map((e) => e.id).sort()[0];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Favourite Show", parentTitle: null, memberIds: eps.map((e) => e.id) });

    const result = await executeQuery({
      mediaTypes: ["SERIES"], serverIds: [server.id], sortBy: "title", sortOrder: "asc",
      groups: [{
        id: "g", condition: "AND", groups: [],
        rules: [
          { id: "r1", field: "availableEpisodeCount", operator: "greaterThan", value: "0", condition: "AND" },
          { id: "r2", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true },
        ],
      }] as never,
    }, user.id, 1, 0);
    expect(result.items.map((i) => i.title)).toEqual(["Other Show"]);
  });

  it("Test Media reads a single item's cross-system values as detection does", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Favourite Movie" });
    const unkept = await createTestMediaItem(library.id, { type: "MOVIE", title: "Other Movie" });
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "MOVIE", serverIds: [server.id] });
    await createTestRuleMatch(keep.id, movie.id, { id: movie.id, title: "Favourite Movie" });
    const rules = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true }],
    }];

    setMockSession({ isLoggedIn: true, userId: user.id });
    const testOne = async (mediaItemId: string) =>
      (
        await expectJson<{ matches: boolean }>(
          await callRoute(testItemPost, {
            url: "/api/lifecycle/rules/test-item",
            method: "POST",
            body: { rules, type: "MOVIE", mediaItemId, serverIds: [server.id] },
          }),
          200,
        )
      ).matches;
    expect(await testOne(movie.id)).toBe(false);
    expect(await testOne(unkept.id)).toBe(true);
  });

  it("counts a grouped match's members as matched by its rule set", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const [rep, member, outsider] = [
      await createTestMediaItem(library.id, { type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 }),
      await createTestMediaItem(library.id, { type: "SERIES", title: "E2", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2 }),
      await createTestMediaItem(library.id, { type: "SERIES", title: "E3", parentTitle: "Show", seasonNumber: 1, episodeNumber: 3 }),
    ];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: false });
    await createTestRuleMatch(keep.id, rep.id, { id: rep.id, title: "Show", parentTitle: null, memberIds: [rep.id, member.id] });

    const cross = await fetchCrossSystemData([rep.id, member.id, outsider.id]);

    expect(cross.get(rep.id)?.matchedRuleSets).toEqual(["Keep"]);
    expect(cross.get(member.id)?.matchedRuleSets).toEqual(["Keep"]);
    expect(cross.get(outsider.id)?.matchedRuleSets).toEqual([]);
  });

  it("counts a grouped action's members as having a pending action", async () => {
    // A show action is stored against one representative episode and names
    // the episodes it acts on in matchedMediaItemIds; only the representative
    // read as pending, so every other episode looked free.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const [rep, member, outsider] = [
      await createTestMediaItem(library.id, { type: "SERIES", title: "E1", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 }),
      await createTestMediaItem(library.id, { type: "SERIES", title: "E2", parentTitle: "Show", seasonNumber: 1, episodeNumber: 2 }),
      await createTestMediaItem(library.id, { type: "SERIES", title: "E3", parentTitle: "Show", seasonNumber: 1, episodeNumber: 3 }),
    ];
    const other = await createTestRuleSet(user.id, { name: "Other", type: "SERIES" });
    const prisma = getTestPrisma();
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: rep.id, ruleSetId: other.id, actionType: "DELETE_FILES_SONARR", status: "PENDING",
        scheduledFor: new Date(Date.now() + 86400000), matchedMediaItemIds: [rep.id, member.id],
      },
    });
    // A settled action's members are not pending.
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: rep.id, ruleSetId: other.id, actionType: "DELETE_FILES_SONARR", status: "COMPLETED",
        scheduledFor: new Date(), matchedMediaItemIds: [outsider.id],
      },
    });

    const cross = await fetchCrossSystemData([rep.id, member.id, outsider.id]);

    expect(cross.get(rep.id)?.hasPendingAction).toBe(true);
    expect(cross.get(member.id)?.hasPendingAction).toBe(true);
    expect(cross.get(outsider.id)?.hasPendingAction).toBe(false);
  });

  it("per-episode scope: an episode another rule set's show action covers does not match 'Has Pending Action = false'", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 3; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Queued Show", seasonNumber: 1, episodeNumber: n,
      }));
    }
    const sorted = [...eps].sort((a, b) => a.id.localeCompare(b.id));
    const other = await createTestRuleSet(user.id, { name: "Other", type: "SERIES" });
    await getTestPrisma().lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: sorted[0].id, ruleSetId: other.id, actionType: "DELETE_FILES_SONARR", status: "PENDING",
        scheduledFor: new Date(Date.now() + 86400000), matchedMediaItemIds: [sorted[0].id, sorted[1].id],
      },
    });

    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "hasPendingAction", operator: "equals", value: "false", condition: "AND" }],
    }];
    const rs = await createTestRuleSet(user.id, { name: "NoPending", type: "SERIES", seriesScope: false, rules, serverIds: [server.id] });
    const { items } = await detectAndSaveMatches(
      { ...rs, type: "SERIES", rules, seriesScope: false, serverIds: [server.id] } as never,
      [server.id],
    );

    const memberIds = items.flatMap((i) => ((i as { memberIds?: string[] }).memberIds ?? [i.id]));
    expect(memberIds).toEqual([sorted[2].id]);
  });

  it("answers a whole library past Postgres' bind-parameter limit", async () => {
    // The series- and artist-scope engines pass every episode or track of the
    // rule set's servers. The server-count groupBy and the pending lookup sent
    // each id as its own bind parameter, and past 32,767 Postgres refused the
    // query, so every such rule set threw on every detection run.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const server2 = await createTestServer(user.id);
    const library2 = await createTestLibrary(server2.id, { type: "SERIES" });
    // Each title (dedupKey) on both servers: even ids on the first, odd on the second.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MediaItem" ("id","libraryId","ratingKey","title","type","dedupKey","updatedAt")
       SELECT 'ep-' || n, CASE WHEN n % 2 = 0 THEN $1 ELSE $2 END, 'rk-' || n, 'E' || n, 'SERIES', 'key-' || (n / 2), now()
         FROM generate_series(0, 39999) AS n`,
      library.id,
      library2.id,
    );
    const other = await createTestRuleSet(user.id, { name: "Other", type: "SERIES" });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: "ep-100", ruleSetId: other.id, actionType: "DELETE_FILES_SONARR",
        status: "PENDING", scheduledFor: new Date(Date.now() + 86400000),
      },
    });

    const ids = Array.from({ length: 40_000 }, (_, n) => `ep-${n}`);
    const cross = await fetchCrossSystemData(ids);

    expect(cross.get("ep-0")?.serverCount).toBe(2);
    expect(cross.get("ep-100")?.hasPendingAction).toBe(true);
    // ep-101 is the same title (same dedupKey) as ep-100 on the other server, backed by the one Arr record.
    expect(cross.get("ep-101")?.hasPendingAction).toBe(true);
    expect(cross.get("ep-102")?.hasPendingAction).toBe(false);
  });

  it("leaves the evaluating rule set's own pending actions out of Has Pending Action", async () => {
    // Counted, a rule set reading "Has Pending Action = false" saw the action
    // it scheduled last run, dropped the match and cancelled it.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Film" });
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "hasPendingAction", operator: "equals", value: "false", condition: "AND" }],
    }];
    const own = await createTestRuleSet(user.id, {
      name: "Cleanup", type: "MOVIE", rules, serverIds: [server.id],
      actionEnabled: true, actionType: "DELETE_RADARR", arrInstanceId: "radarr-1",
    });
    await createTestRuleMatch(own.id, movie.id, { id: movie.id, title: "Film" });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: movie.id, ruleSetId: own.id, actionType: "DELETE_RADARR",
        status: "PENDING", scheduledFor: new Date(Date.now() + 30 * 86400000),
      },
    });

    expect((await fetchCrossSystemData([movie.id])).get(movie.id)?.hasPendingAction).toBe(true);
    expect((await fetchCrossSystemData([movie.id], { excludeRuleSetId: own.id })).get(movie.id)?.hasPendingAction).toBe(false);

    const { items } = await detectAndSaveMatches(
      { ...own, type: "MOVIE", rules, seriesScope: false, serverIds: [server.id] } as never,
      [server.id],
    );
    expect(items.map((i) => i.id)).toEqual([movie.id]);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: own.id } })).toBe(1);

    // Another rule set's action still counts.
    const other = await createTestRuleSet(user.id, { name: "Other", type: "MOVIE" });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: movie.id, ruleSetId: other.id, actionType: "DELETE_RADARR",
        status: "PENDING", scheduledFor: new Date(Date.now() + 86400000),
      },
    });
    expect((await fetchCrossSystemData([movie.id], { excludeRuleSetId: own.id })).get(movie.id)?.hasPendingAction).toBe(true);
  });

  it("counts another server's copy of a held match as having its pending action", async () => {
    // A title matched on two servers is held on one copy, the other listed in
    // copyIds; the action acts on the one Arr record both are backed by, so a
    // rule set on the second server must not schedule the title again.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const s1 = await createTestServer(user.id, { name: "S1" });
    const s2 = await createTestServer(user.id, { name: "S2" });
    const lib1 = await createTestLibrary(s1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(s2.id, { type: "MOVIE" });
    const c1 = await createTestMediaItem(lib1.id, { type: "MOVIE", title: "Film A" });
    const c2 = await createTestMediaItem(lib2.id, { type: "MOVIE", title: "Film A (2)" });
    await prisma.mediaItem.update({ where: { id: c1.id }, data: { dedupKey: "film-a-s1" } });
    await prisma.mediaItem.update({ where: { id: c2.id }, data: { dedupKey: "film-a-s2" } });
    const a = await createTestRuleSet(user.id, { name: "A", type: "MOVIE", serverIds: [s1.id, s2.id] });
    await prisma.ruleMatch.create({
      data: { ruleSetId: a.id, mediaItemId: c1.id, itemData: { id: c1.id, title: "Film A" }, copyIds: [c2.id] },
    });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: c1.id, ruleSetId: a.id, actionType: "DELETE_RADARR",
        status: "PENDING", scheduledFor: new Date(Date.now() + 86400000),
      },
    });

    const cross = await fetchCrossSystemData([c1.id, c2.id]);
    expect(cross.get(c1.id)?.hasPendingAction).toBe(true);
    expect(cross.get(c2.id)?.hasPendingAction).toBe(true);

    // Once the action is no longer pending, neither copy has one.
    await prisma.lifecycleAction.updateMany({ data: { status: "COMPLETED" } });
    expect((await fetchCrossSystemData([c2.id])).get(c2.id)?.hasPendingAction).toBe(false);
  });

  it("records a flat-path cross-system rule among the criteria a match matched on", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Kept Film" });
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "MOVIE", serverIds: [server.id] });
    await createTestRuleMatch(keep.id, movie.id, { id: movie.id, title: "Kept Film" });
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND" }],
    }];
    const rs = await createTestRuleSet(user.id, { name: "Follow-up", type: "MOVIE", rules, serverIds: [server.id] });

    const { items } = await detectAndSaveMatches(
      { ...rs, type: "MOVIE", rules, seriesScope: false, serverIds: [server.id] } as never,
      [server.id],
    );

    expect(items.map((i) => i.id)).toEqual([movie.id]);
    expect((items[0].matchedCriteria as Array<{ ruleId: string }>).map((c) => c.ruleId)).toEqual(["r1"]);
  });

  it("plans its raw member lookup below Postgres' JIT threshold for a whole library's ids", async () => {
    // The series- and artist-scope engines pass every episode/track of the
    // library. Joined in SQL against `unnest($1)`, the member lookup was
    // estimated in the millions, so Postgres JIT-compiled it on every
    // detection run: ~0.7 s of compilation for a 28k-episode request,
    // ~4 s for 150k (measured against postgres:18-alpine), for a lookup the
    // planner otherwise answers in tens of milliseconds.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    // 1,000 series matches of 30 episodes each, one representative per show.
    await prisma.mediaItem.createMany({
      data: Array.from({ length: 1000 }, (_, s) => ({
        id: `rep-${s}`, libraryId: library.id, ratingKey: `rk-${s}`, type: "SERIES" as const,
        title: "E1", parentTitle: `Show ${s}`, seasonNumber: 1, episodeNumber: 1,
      })),
    });
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true });
    await prisma.ruleMatch.createMany({
      data: Array.from({ length: 1000 }, (_, s) => ({
        ruleSetId: keep.id,
        mediaItemId: `rep-${s}`,
        itemData: {
          id: `rep-${s}`, title: `Show ${s}`, parentTitle: null,
          memberIds: [`rep-${s}`, ...Array.from({ length: 29 }, (_, e) => `episode-${s * 30 + e}`)],
        },
      })),
    });
    await prisma.$executeRawUnsafe(`ANALYZE "RuleMatch"`);
    await prisma.$executeRawUnsafe(`ANALYZE "RuleSet"`);
    const [{ jit_above_cost: jitAboveCost }] = await prisma.$queryRawUnsafe<{ jit_above_cost: string }[]>("SHOW jit_above_cost");

    const raw = vi.spyOn(prisma, "$queryRawUnsafe");
    const ids = ["rep-0", ...Array.from({ length: 30_000 }, (_, i) => `episode-${i}`)];
    const cross = await fetchCrossSystemData(ids);
    const calls = raw.mock.calls.map(([sql, ...params]) => ({ sql: String(sql), params }));
    raw.mockRestore();

    expect(cross.get("rep-0")?.matchedRuleSets).toEqual(["Keep"]);
    expect(cross.get("episode-31")?.matchedRuleSets).toEqual(["Keep"]);
    expect(cross.get("episode-29999")?.matchedRuleSets).toEqual([]);
    for (const { sql, params } of calls) {
      const [{ "QUERY PLAN": plan }] = await prisma.$queryRawUnsafe<{ "QUERY PLAN": Array<{ Plan: { "Total Cost": number } }> }[]>(
        `EXPLAIN (FORMAT JSON) ${sql}`,
        ...params,
      );
      expect(plan[0].Plan["Total Cost"]).toBeLessThan(Number(jitAboveCost));
    }
  });

  it("artist scope: an artist 'Keep' matched is not matched by 'NOT Matched By Rule Set = Keep'", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    const tracks = [];
    for (let n = 1; n <= 2; n++) {
      tracks.push(await createTestMediaItem(library.id, { type: "MUSIC", title: `Song ${n}`, parentTitle: "Kept Artist", playCount: 0 }));
    }
    // Control: an artist Keep did not match.
    await createTestMediaItem(library.id, { type: "MUSIC", title: "Track", parentTitle: "Other Artist", playCount: 0 });
    const repId = tracks.map((t) => t.id).sort()[0];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "MUSIC", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Kept Artist", parentTitle: null, memberIds: tracks.map((t) => t.id) });
    const rules: LifecycleRuleGroup[] = [{
      id: "g", condition: "AND", groups: [],
      rules: [
        { id: "r1", field: "playCount", operator: "equals", value: "0", condition: "AND" },
        { id: "r2", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND", negate: true },
      ],
    }];
    const rs = await createTestRuleSet(user.id, { name: "Cleanup", type: "MUSIC", seriesScope: true, rules, serverIds: [server.id] });
    const { items } = await detectAndSaveMatches(
      { ...rs, type: "MUSIC", rules, seriesScope: true, serverIds: [server.id] } as never,
      [server.id],
    );
    expect(items.map((i) => i.title)).toEqual(["Other Artist"]);
  });

  it("Test Media answers a series-scope cross-system rule as detection does", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const eps = [];
    for (let n = 1; n <= 2; n++) {
      eps.push(await createTestMediaItem(library.id, {
        type: "SERIES", title: `Ep ${n}`, parentTitle: "Favourite Show", seasonNumber: 1, episodeNumber: n,
      }));
    }
    const repId = eps.map((e) => e.id).sort()[0];
    const keep = await createTestRuleSet(user.id, { name: "Keep", type: "SERIES", seriesScope: true, serverIds: [server.id] });
    await createTestRuleMatch(keep.id, repId, { id: repId, title: "Favourite Show", parentTitle: null, memberIds: eps.map((e) => e.id) });
    const rules = [{
      id: "g", condition: "AND", groups: [],
      rules: [{ id: "r", field: "matchedByRuleSet", operator: "equals", value: "Keep", condition: "AND" }],
    }];

    setMockSession({ isLoggedIn: true, userId: user.id });
    const body = await expectJson<{ matches: boolean }>(
      await callRoute(testItemPost, {
        url: "/api/lifecycle/rules/test-item",
        method: "POST",
        body: { rules, type: "SERIES", seriesScope: true, mediaItemId: eps.find((e) => e.id !== repId)!.id, serverIds: [server.id] },
      }),
      200,
    );
    expect(body.matches).toBe(true);
  });
});
