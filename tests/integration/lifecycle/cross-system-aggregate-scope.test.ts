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

    expect(items.map((i) => i.title)).toEqual([]);
    const stored = await getTestPrisma().ruleMatch.count({ where: { ruleSetId: cleanup.id } });
    expect(stored).toBe(0);
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
    expect(items.map((i) => i.title)).toEqual([]);
  });
  it("control: the same rule on a MOVIE rule set (per-item path) excludes the kept movie", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Favourite Movie", playCount: 0 });
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
    expect(items).toEqual([]);
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
    expect(result.items.map((i) => i.title)).toEqual([]);
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
    expect(items.map((i) => i.title)).toEqual([]);
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

  it("artist scope: an artist 'Keep' matched is not matched by 'NOT Matched By Rule Set = Keep'", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    const tracks = [];
    for (let n = 1; n <= 2; n++) {
      tracks.push(await createTestMediaItem(library.id, { type: "MUSIC", title: `Song ${n}`, parentTitle: "Kept Artist", playCount: 0 }));
    }
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
    expect(items).toEqual([]);
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
