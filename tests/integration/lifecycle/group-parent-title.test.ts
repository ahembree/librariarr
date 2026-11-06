/**
 * "Artist / Series" (`parentTitle`) on a show or artist evaluated as a group.
 *
 * Regression: the series- and artist-scope engines (and the query engine's
 * series-aggregate path) built each group with `title` = the show or artist and
 * `parentTitle: null`. A NULL parentTitle meant `parentTitle equals "X"` matched
 * no show at all, and every negated form — Not Equals, Not Contains, a NOT group
 * — matched EVERY show and artist, so a Delete from Sonarr / Lidarr rule set
 * meant to spare one show deleted it with everything else. Converting a working
 * grouped query (per-episode, where parentTitle is set) into a rule set
 * (`seriesScope: true`) inverted it.
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
import type { QueryDefinition, QueryGroup } from "@/lib/query/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  evaluateSeriesScope,
  evaluateMusicScope,
  evaluateLifecycleRules,
  groupSeriesResults,
  getMatchedCriteriaForItems,
  getActualValuesForAllRules,
} from "@/lib/rules/lifecycle-engine";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { executeQuery } from "@/lib/query/query-engine";

type Rule = { field: string; operator: string; value: string };

function groups(rules: Rule[], negate = false): LifecycleRuleGroup[] {
  return [
    {
      id: "g1",
      condition: "AND",
      ...(negate ? { negate: true } : {}),
      rules: rules.map((r, i) => ({ id: `r${i}`, condition: "AND" as const, ...r })),
      groups: [],
    },
  ];
}

const titlesOf = (records: Array<Record<string, unknown>>) =>
  records.map((r) => r.title as string).sort();

describe("parentTitle on group records", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seedShows() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const ids: Record<string, string[]> = { "Alpha Show": [], "Beta Show": [] };
    for (const show of Object.keys(ids)) {
      for (let e = 1; e <= 2; e++) {
        const ep = await createTestMediaItem(library.id, {
          type: "SERIES", title: `${show} Episode ${e}`, parentTitle: show,
          seasonNumber: 1, episodeNumber: e,
        });
        ids[show].push(ep.id);
      }
    }
    return { user, server, library, ids };
  }

  async function seedArtists() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    for (const artist of ["Alpha Band", "Beta Band"]) {
      for (let t = 1; t <= 2; t++) {
        await createTestMediaItem(library.id, {
          type: "MUSIC", title: `${artist} Track ${t}`, parentTitle: artist, albumTitle: "Album",
        });
      }
    }
    return { serverId: server.id };
  }

  describe("series scope (evaluateSeriesScope)", () => {
    it("matches the show by its own name with equals", async () => {
      const { server } = await seedShows();
      const matched = await evaluateSeriesScope(
        groups([{ field: "parentTitle", operator: "equals", value: "Alpha Show" }]), [server.id],
      );
      expect(titlesOf(matched)).toEqual(["Alpha Show"]);
    });

    it("excludes the named show under Not Equals, Not Contains and a NOT group", async () => {
      const { server } = await seedShows();
      for (const rules of [
        groups([{ field: "parentTitle", operator: "notEquals", value: "Alpha Show" }]),
        groups([{ field: "parentTitle", operator: "notContains", value: "Alpha" }]),
        groups([{ field: "parentTitle", operator: "contains", value: "Alpha" }], true),
      ]) {
        const matched = await evaluateSeriesScope(rules, [server.id]);
        expect(titlesOf(matched)).toEqual(["Beta Show"]);
      }
    });

    it("keeps a matched show's snapshot as its group (parentTitle cleared) and reports the criterion", async () => {
      const { server } = await seedShows();
      const rules = groups([{ field: "parentTitle", operator: "notEquals", value: "Alpha Show" }]);
      const matched = (await evaluateSeriesScope(rules, [server.id])) as unknown as Array<Record<string, unknown>>;
      expect(matched).toHaveLength(1);
      // The returned record is the match's snapshot: named by the show, no
      // parent — the shape the identity check and the action snapshot expect.
      expect(matched[0].title).toBe("Beta Show");
      expect(matched[0].parentTitle).toBeNull();

      const criteria = getMatchedCriteriaForItems(matched, rules, "SERIES").get(matched[0].id as string);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([["Artist / Series", "Beta Show"]]);
      const values = getActualValuesForAllRules(matched, rules, "SERIES").get(matched[0].id as string);
      expect(values?.get("r0")).toBe("Beta Show");
    });

    it("excludes the named show when the aggregate path is forced with series scope off", async () => {
      const { server, ids } = await seedShows();
      const rules = groups([
        { field: "availableEpisodeCount", operator: "greaterThan", value: "0" },
        { field: "parentTitle", operator: "notEquals", value: "Alpha Show" },
      ]);
      const matched = (await evaluateSeriesScope(rules, [server.id], undefined, undefined, true)) as unknown as Array<{
        title: string; memberIds: string[];
      }>;
      expect(matched.map((m) => m.title)).toEqual(["Beta Show"]);
      expect([...matched[0].memberIds].sort()).toEqual([...ids["Beta Show"]].sort());
    });
  });

  describe("artist scope (evaluateMusicScope)", () => {
    it("matches the artist by name and excludes it when negated", async () => {
      const { serverId } = await seedArtists();
      const equal = await evaluateMusicScope(
        groups([{ field: "parentTitle", operator: "equals", value: "Alpha Band" }]), [serverId],
      );
      expect(titlesOf(equal)).toEqual(["Alpha Band"]);

      const notEqual = await evaluateMusicScope(
        groups([{ field: "parentTitle", operator: "notEquals", value: "Alpha Band" }]), [serverId],
      );
      expect(titlesOf(notEqual)).toEqual(["Beta Band"]);
    });
  });

  describe("episode scope (groupSeriesResults)", () => {
    it("reports the criterion each grouped match was selected on", async () => {
      const { server } = await seedShows();
      const rules = groups([{ field: "parentTitle", operator: "equals", value: "Alpha Show" }]);
      const grouped = groupSeriesResults(
        await evaluateLifecycleRules(rules, "SERIES", [server.id]),
      ) as unknown as Array<Record<string, unknown>>;
      expect(titlesOf(grouped)).toEqual(["Alpha Show"]);
      const criteria = getMatchedCriteriaForItems(grouped, rules, "SERIES").get(grouped[0].id as string);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([["Artist / Series", "Alpha Show"]]);
    });
  });

  describe("detection (detectAndSaveMatches)", () => {
    it("never matches the show a Delete from Sonarr rule set excludes by name", async () => {
      const { user, server } = await seedShows();
      const rules = groups([{ field: "parentTitle", operator: "notEquals", value: "Alpha Show" }]);
      const ruleSet = await createTestRuleSet(user.id, {
        type: "SERIES", rules, seriesScope: true, serverIds: [server.id],
        actionEnabled: true, actionType: "DELETE_SONARR",
      });

      const { items } = await detectAndSaveMatches(
        {
          id: ruleSet.id, name: ruleSet.name, userId: user.id, type: "SERIES", rules,
          seriesScope: true, serverIds: [server.id], actionEnabled: true, actionType: "DELETE_SONARR",
          actionDelayDays: 7, arrInstanceId: null, addImportExclusion: false, addArrTags: [],
          removeArrTags: [], stickyMatches: false,
        },
        [server.id],
      );

      expect(titlesOf(items)).toEqual(["Beta Show"]);
      const stored = await getTestPrisma().ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(stored).toHaveLength(1);
      const data = stored[0].itemData as Record<string, unknown>;
      expect(data.title).toBe("Beta Show");
      expect(data.parentTitle).toBeNull();
    });
  });

  describe("query engine (series-aggregate path)", () => {
    function query(serverId: string, includeEpisodes: boolean, rules: Rule[]): QueryDefinition {
      return {
        mediaTypes: ["SERIES"],
        serverIds: [serverId],
        includeEpisodes,
        sortBy: "title",
        sortOrder: "asc",
        groups: groups([
          { field: "availableEpisodeCount", operator: "greaterThan", value: "0" },
          ...rules,
        ]) as unknown as QueryGroup[],
      };
    }

    it("matches the show by its own name with equals, in both views", async () => {
      const { user, server, ids } = await seedShows();
      const rules = [{ field: "parentTitle", operator: "equals", value: "Alpha Show" }];

      const grouped = await executeQuery(query(server.id, false, rules), user.id, 1, 0);
      expect(grouped.items.map((i) => i.title)).toEqual(["Alpha Show"]);

      const episodes = await executeQuery(query(server.id, true, rules), user.id, 1, 0);
      expect(episodes.items.map((i) => i.id).sort()).toEqual([...ids["Alpha Show"]].sort());
    });

    it("excludes the named show under Not Equals, in both views", async () => {
      const { user, server, ids } = await seedShows();
      const rules = [{ field: "parentTitle", operator: "notEquals", value: "Alpha Show" }];

      const grouped = await executeQuery(query(server.id, false, rules), user.id, 1, 0);
      expect(grouped.items.map((i) => i.title)).toEqual(["Beta Show"]);

      const episodes = await executeQuery(query(server.id, true, rules), user.id, 1, 0);
      expect(episodes.items.map((i) => i.id).sort()).toEqual([...ids["Beta Show"]].sort());
    });
  });
});
