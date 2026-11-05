/**
 * Per-episode criteria — Season Number, Episode Number, Seasons Behind Latest —
 * against a real database, through both engines.
 *
 *  - `seasonsBehindLatest` is measured per show (seriesKey) within a library,
 *    against the newest numbered season; specials and unnumbered episodes
 *    have no value.
 *  - `seasonNumber` / `episodeNumber` read NULL on anything but an episode (a
 *    music track keeps its disc/track numbers in the same columns), in Phase 1
 *    and Phase 2 alike.
 *  - A series aggregate has no season or episode: the aggregate gate passes
 *    those rules and the per-episode pass decides, so the members are the
 *    matching episodes.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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
  attachSeasonsBehindLatest,
  latestSeasonKey,
  loadLatestSeasons,
} from "@/lib/conditions/episode-fields";
import {
  evaluateLifecycleRules,
  evaluateSeriesScope,
  groupSeriesResults,
  getMatchedCriteriaForItems,
  getActualValuesForAllRules,
} from "@/lib/rules/lifecycle-engine";
import { executeQuery } from "@/lib/query/query-engine";

type Rule = { field: string; operator: string; value: string | number; negate?: boolean };

function groups(...rules: Rule[]): LifecycleRuleGroup[] {
  return [
    {
      id: "g1",
      condition: "AND",
      rules: rules.map((r, i) => ({ id: `r${i}`, condition: "AND" as const, ...r })),
      groups: [],
    },
  ];
}

function query(serverId: string, rules: Rule[], opts: Partial<QueryDefinition> = {}): QueryDefinition {
  return {
    mediaTypes: ["SERIES"],
    serverIds: [serverId],
    groups: groups(...rules) as unknown as QueryGroup[],
    sortBy: "title",
    sortOrder: "asc",
    ...opts,
  };
}

interface Seeded {
  userId: string;
  serverId: string;
  libraryId: string;
  /** episode id by "<show>-S<season>E<episode>" */
  ep: Record<string, string>;
  movieId: string;
  trackId: string;
}

/**
 * One server, three libraries:
 *  - SERIES: "Long Show" seasons 1–4 (two episodes each) plus a special (S0E1);
 *            "Short Show" season 1 only (two episodes).
 *  - MOVIE:  one movie (no season).
 *  - MUSIC:  one track on disc 1, track 1 (seasonNumber 1, episodeNumber 1).
 */
async function seed(): Promise<Seeded> {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "SERIES" });
  const movies = await createTestLibrary(server.id, { type: "MOVIE" });
  const music = await createTestLibrary(server.id, { type: "MUSIC" });
  const ep: Record<string, string> = {};
  for (let s = 1; s <= 4; s++) {
    for (let e = 1; e <= 2; e++) {
      const row = await createTestMediaItem(library.id, {
        type: "SERIES", title: `Long S${s}E${e}`, parentTitle: "Long Show",
        seasonNumber: s, episodeNumber: e, playCount: s <= 2 ? 1 : 0,
      });
      ep[`Long-S${s}E${e}`] = row.id;
    }
  }
  const special = await createTestMediaItem(library.id, {
    type: "SERIES", title: "Long Special", parentTitle: "Long Show", seasonNumber: 0, episodeNumber: 1,
  });
  ep["Long-S0E1"] = special.id;
  for (let e = 1; e <= 2; e++) {
    const row = await createTestMediaItem(library.id, {
      type: "SERIES", title: `Short S1E${e}`, parentTitle: "Short Show", seasonNumber: 1, episodeNumber: e,
    });
    ep[`Short-S1E${e}`] = row.id;
  }
  const movie = await createTestMediaItem(movies.id, { type: "MOVIE", title: "A Movie" });
  const track = await createTestMediaItem(music.id, {
    type: "MUSIC", title: "Track One", parentTitle: "Artist", albumTitle: "Album",
    seasonNumber: 1, episodeNumber: 1,
  });
  return { userId: user.id, serverId: server.id, libraryId: library.id, ep, movieId: movie.id, trackId: track.id };
}

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();

describe("per-episode criteria", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("seasons behind latest", () => {
    it("loads each show's newest numbered season per library", async () => {
      const s = await seed();
      const latest = await loadLatestSeasons([s.libraryId]);
      expect(latest.get(latestSeasonKey(s.libraryId, "title:long show"))).toBe(4);
      expect(latest.get(latestSeasonKey(s.libraryId, "title:short show"))).toBe(1);
      expect(await loadLatestSeasons([])).toEqual(new Map());
    });

    it("measures each episode against its own show, and gives specials and non-episodes no value", async () => {
      const s = await seed();
      const { getTestPrisma } = await import("../../setup/test-db");
      const rows = await getTestPrisma().mediaItem.findMany({
        select: { id: true, type: true, libraryId: true, seriesKey: true, parentTitle: true, seasonNumber: true },
      });
      await attachSeasonsBehindLatest(rows);
      const value = (id: string) => (rows.find((r) => r.id === id) as unknown as { seasonsBehindLatest: number | null }).seasonsBehindLatest;
      expect(value(s.ep["Long-S4E1"])).toBe(0);
      expect(value(s.ep["Long-S3E2"])).toBe(1);
      expect(value(s.ep["Long-S1E1"])).toBe(3);
      expect(value(s.ep["Short-S1E1"])).toBe(0);
      expect(value(s.ep["Long-S0E1"])).toBeNull();
      expect(value(s.movieId)).toBeNull();
      expect(value(s.trackId)).toBeNull();
    });
  });

  describe("lifecycle engine (series scope off)", () => {
    it("matches every episode outside each show's two newest seasons", async () => {
      const s = await seed();
      const raw = await evaluateLifecycleRules(
        groups({ field: "seasonsBehindLatest", operator: "greaterThanOrEqual", value: "2" }),
        "SERIES", [s.serverId],
      );
      expect(ids(raw)).toEqual([s.ep["Long-S1E1"], s.ep["Long-S1E2"], s.ep["Long-S2E1"], s.ep["Long-S2E2"]].sort());

      const grouped = groupSeriesResults(raw, { summarizeEpisodeFields: true });
      expect(grouped).toHaveLength(1);
      expect([...grouped[0].memberIds].sort()).toEqual(ids(raw));
      expect(grouped[0].episodeFieldValues).toEqual({
        seasonNumber: [1, 2],
        episodeNumber: [1, 2],
        seasonsBehindLatest: [2, 3],
      });
    });

    it("reads specials as empty", async () => {
      const s = await seed();
      const raw = await evaluateLifecycleRules(
        groups({ field: "seasonsBehindLatest", operator: "isNull", value: "" }),
        "SERIES", [s.serverId],
      );
      expect(ids(raw)).toEqual([s.ep["Long-S0E1"]]);
    });

    it("compiles season and episode numbers in the WHERE", async () => {
      const s = await seed();
      const raw = await evaluateLifecycleRules(
        groups(
          { field: "seasonNumber", operator: "between", value: "2,3" },
          { field: "episodeNumber", operator: "equals", value: "2" },
        ),
        "SERIES", [s.serverId],
      );
      expect(ids(raw)).toEqual([s.ep["Long-S2E2"], s.ep["Long-S3E2"]].sort());
    });

    it("reports the matched episodes' values as a grouped match's criteria", async () => {
      const s = await seed();
      const rules = groups({ field: "seasonsBehindLatest", operator: "greaterThanOrEqual", value: "2" });
      const raw = await evaluateLifecycleRules(rules, "SERIES", [s.serverId]);
      const grouped = groupSeriesResults(raw, { summarizeEpisodeFields: true });
      const records = grouped as unknown as Array<Record<string, unknown>>;
      const criteria = getMatchedCriteriaForItems(records, rules, "SERIES");
      const actual = getActualValuesForAllRules(records, rules, "SERIES");
      const id = grouped[0].id;
      expect(criteria.get(id)).toEqual([
        expect.objectContaining({ field: "Seasons Behind Latest", actualValue: "2–3" }),
      ]);
      expect(actual.get(id)?.get("r0")).toBe("2–3");
    });

    it("judges per-episode rules on the episodes when a series aggregate forces the series path", async () => {
      const s = await seed();
      // Long Show: 9 episodes, 4 played (44%); Short Show: 0%. The aggregate
      // qualifies Long Show only; the per-episode rule then keeps its seasons
      // 1–2. Not negated, a series record (no season) would match nothing.
      const rules = groups(
        { field: "watchedEpisodePercentage", operator: "greaterThan", value: "40" },
        { field: "seasonsBehindLatest", operator: "greaterThanOrEqual", value: "2" },
      );
      for (const restrict of [true, false]) {
        const matched = await evaluateSeriesScope(rules, [s.serverId], undefined, undefined, restrict);
        expect(matched).toHaveLength(1);
        const m = matched[0] as unknown as { memberIds: string[]; episodeFieldValues: Record<string, unknown> };
        expect([...m.memberIds].sort()).toEqual(
          [s.ep["Long-S1E1"], s.ep["Long-S1E2"], s.ep["Long-S2E1"], s.ep["Long-S2E2"]].sort(),
        );
        expect(m.episodeFieldValues).toMatchObject({ seasonNumber: [1, 2] });
      }
    });

    it("never lets a negated per-episode rule sweep whole shows through the aggregate", async () => {
      const s = await seed();
      // NOT (season number = 1): on a series record (season NULL) this would
      // read true for every show. Judged per episode it keeps seasons 0, 2–4
      // of Long Show and nothing of Short Show (season 1 only).
      const rules = groups(
        { field: "availableEpisodeCount", operator: "greaterThan", value: "0" },
        { field: "seasonNumber", operator: "equals", value: "1", negate: true },
      );
      const matched = await evaluateSeriesScope(rules, [s.serverId], undefined, undefined, false);
      expect(matched).toHaveLength(1);
      const members = (matched[0] as unknown as { memberIds: string[] }).memberIds;
      expect(members).toHaveLength(7);
      expect(members).not.toContain(s.ep["Long-S1E1"]);
    });
  });

  describe("phase agreement", () => {
    // Every operator, plain and negated, over episodes, a movie and a music
    // track: Phase 1 alone must select what Phase 2 selects (forced by an
    // always-true resolution rule, which only Phase 2 evaluates).
    const cases: Rule[] = [
      { field: "seasonNumber", operator: "equals", value: "1" },
      { field: "seasonNumber", operator: "notEquals", value: "1" },
      { field: "seasonNumber", operator: "greaterThan", value: "2" },
      { field: "seasonNumber", operator: "lessThanOrEqual", value: "1" },
      { field: "seasonNumber", operator: "between", value: "0,2" },
      { field: "seasonNumber", operator: "isNull", value: "" },
      { field: "seasonNumber", operator: "isNotNull", value: "" },
      { field: "episodeNumber", operator: "equals", value: "1" },
      { field: "episodeNumber", operator: "greaterThanOrEqual", value: "2" },
      { field: "episodeNumber", operator: "lessThan", value: "2" },
    ];

    it.each(cases.flatMap((c) => [c, { ...c, negate: true }]))(
      "%o",
      async (rule) => {
        const s = await seed();
        const def = (rules: Rule[]) => query(s.serverId, rules, { mediaTypes: [], includeEpisodes: true });
        const phase1 = await executeQuery(def([rule]), s.userId, 1, 0);
        const phase2 = await executeQuery(
          def([rule, { field: "resolution", operator: "isNotNull", value: "" }]),
          s.userId, 1, 0,
        );
        expect(ids(phase1.items as Array<{ id: string }>)).toEqual(ids(phase2.items as Array<{ id: string }>));
      },
    );

    it("never matches a music track's disc or track number", async () => {
      const s = await seed();
      const result = await executeQuery(
        query(s.serverId, [{ field: "seasonNumber", operator: "equals", value: "1" }], { mediaTypes: [], includeEpisodes: true }),
        s.userId, 1, 0,
      );
      const found = ids(result.items as Array<{ id: string }>);
      expect(found).toEqual([s.ep["Long-S1E1"], s.ep["Long-S1E2"], s.ep["Short-S1E1"], s.ep["Short-S1E2"]].sort());
      expect(found).not.toContain(s.trackId);
    });
  });

  describe("query engine", () => {
    const behind2: Rule = { field: "seasonsBehindLatest", operator: "greaterThanOrEqual", value: 2 };

    it("returns the older seasons' episodes in episode mode", async () => {
      const s = await seed();
      const result = await executeQuery(query(s.serverId, [behind2], { includeEpisodes: true }), s.userId, 1, 0);
      expect(ids(result.items as Array<{ id: string }>)).toEqual(
        [s.ep["Long-S1E1"], s.ep["Long-S1E2"], s.ep["Long-S2E1"], s.ep["Long-S2E2"]].sort(),
      );
    });

    it("groups the older seasons' episodes by show", async () => {
      const s = await seed();
      const result = await executeQuery(query(s.serverId, [behind2]), s.userId, 1, 0);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ title: "Long Show", matchedEpisodes: 4, seasonCount: 2 });
    });

    it("keeps only matching episodes when a series aggregate is in the query", async () => {
      const s = await seed();
      const rules: Rule[] = [{ field: "watchedEpisodePercentage", operator: "greaterThan", value: 40 }, behind2];
      const episodes = await executeQuery(query(s.serverId, rules, { includeEpisodes: true }), s.userId, 1, 0);
      expect(ids(episodes.items as Array<{ id: string }>)).toEqual(
        [s.ep["Long-S1E1"], s.ep["Long-S1E2"], s.ep["Long-S2E1"], s.ep["Long-S2E2"]].sort(),
      );
      const grouped = await executeQuery(query(s.serverId, rules), s.userId, 1, 0);
      expect(grouped.items).toHaveLength(1);
      expect(grouped.items[0]).toMatchObject({ title: "Long Show", matchedEpisodes: 4 });
    });
  });
});
