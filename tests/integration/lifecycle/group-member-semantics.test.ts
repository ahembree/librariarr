/**
 * A show or artist evaluated as a whole matches a rule when at least one of
 * its members satisfies the whole rule, each member seen as the group carrying
 * its own per-member values.
 *
 * Regression: the group record copied every per-item field (resolution,
 * codecs, year, …) from ONE representative member, the lowest-id episode or
 * track. "Resolution = 4K" in series scope matched a show only when its first
 * episode was 4K, and a show whose first episode is 1080p and the rest 4K
 * never qualified. With series scope off and a series-aggregate field forcing
 * the series path, the show's record (the representative's values) gated the
 * per-episode narrowing, so the same show matched no episode at all. The
 * reported criteria named the representative's value.
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
} from "../../setup/test-helpers";
import { compareIds } from "@/lib/conditions/compare-ids";
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

// How many records each group is evaluated through — the regression that a
// rule reading only group-level fields still evaluates a group once.
const evaluations = vi.hoisted(() => ({ group: [] as number[], episodes: [] as number[] }));
vi.mock("@/lib/conditions/series-aggregates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions/series-aggregates")>();
  return {
    ...actual,
    matchGroupThroughMembers: (...[group, members, matches, perMember]: Parameters<typeof actual.matchGroupThroughMembers>) => {
      let calls = 0;
      const selected = actual.matchGroupThroughMembers(group, members, (record) => {
        calls++;
        return matches(record);
      }, perMember);
      evaluations.group.push(calls);
      return selected;
    },
    episodesMatchingIndividually: (
      ...[episodes, aggregate, matches, perEpisode]: Parameters<typeof actual.episodesMatchingIndividually>
    ) => {
      let calls = 0;
      const ids = actual.episodesMatchingIndividually(episodes, aggregate, (episode, seriesFields) => {
        calls++;
        return matches(episode, seriesFields);
      }, perEpisode);
      evaluations.episodes.push(calls);
      return ids;
    },
  };
});

import {
  evaluateSeriesScope,
  evaluateMusicScope,
  getMatchedCriteriaForItems,
  getActualValuesForAllRules,
} from "@/lib/rules/lifecycle-engine";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { POST as testItemPost } from "@/app/api/lifecycle/rules/test-item/route";

type Rule = { field: string; operator: string; value: string; negate?: boolean };

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

type Record_ = Record<string, unknown>;
const titlesOf = (records: unknown[]) => (records as Record_[]).map((r) => r.title as string).sort();

const FOURK = groups([{ field: "resolution", operator: "equals", value: "4K" }]);
const NOT_FOURK_RULE = groups([{ field: "resolution", operator: "equals", value: "4K", negate: true }]);
const NOT_FOURK_GROUP = groups([{ field: "resolution", operator: "equals", value: "4K" }], true);
const AGGREGATE_AND_FOURK = groups([
  { field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3" },
  { field: "resolution", operator: "equals", value: "4K" },
]);

describe("a group matches through any of its members", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    evaluations.group.length = 0;
    evaluations.episodes.length = 0;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /**
   * Three shows of three episodes:
   *  - "Mixed Show": the lowest-id episode (the representative) 1080p, the
   *    other two 4K; the representative watched, the others not.
   *  - "HD Show": every episode 1080p.
   *  - "UHD Show": every episode 4K.
   */
  async function seedShows() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const ids: Record<string, string[]> = {};
    for (const show of ["Mixed Show", "HD Show", "UHD Show"]) {
      const created = [];
      for (let e = 1; e <= 3; e++) {
        created.push(await createTestMediaItem(library.id, {
          type: "SERIES", title: `${show} E${e}`, parentTitle: show, seasonNumber: 1, episodeNumber: e,
          resolution: show === "UHD Show" ? "4k" : "1080",
        }));
      }
      ids[show] = created.map((ep) => ep.id).sort(compareIds);
    }
    const [mixedRep, ...mixedRest] = ids["Mixed Show"];
    await prisma.mediaItem.updateMany({ where: { id: { in: mixedRest } }, data: { resolution: "4k" } });
    await prisma.mediaItem.update({ where: { id: mixedRep }, data: { playCount: 4, year: 2001 } });
    await prisma.mediaItem.update({ where: { id: mixedRest[0] }, data: { year: 2002 } });
    return { user, server, library, ids, mixedRep, mixedFourK: mixedRest };
  }

  /** "Fading Show": the lowest-id episode 4K, the other two 1080p. */
  async function addFadingShow(libraryId: string) {
    const created = [];
    for (let e = 1; e <= 3; e++) {
      created.push(await createTestMediaItem(libraryId, {
        type: "SERIES", title: `Fading E${e}`, parentTitle: "Fading Show", seasonNumber: 1, episodeNumber: e,
        resolution: "1080",
      }));
    }
    const [first, ...rest] = created.map((ep) => ep.id).sort(compareIds);
    await prisma.mediaItem.update({ where: { id: first }, data: { resolution: "4k" } });
    return { fadingRep: first, fadingHd: rest };
  }

  describe("series scope on", () => {
    it("matches a show whose first episode is 1080p and another 4K, and no show without a 4K episode", async () => {
      const { server, ids, mixedRep } = await seedShows();

      const matched = (await evaluateSeriesScope(FOURK, [server.id])) as unknown as Record_[];

      expect(titlesOf(matched)).toEqual(["Mixed Show", "UHD Show"]);
      const mixed = matched.find((m) => m.title === "Mixed Show")!;
      // Still the show: stored against its representative, every episode a member.
      expect(mixed.id).toBe(mixedRep);
      expect(mixed.parentTitle).toBeNull();
      expect([...(mixed.memberIds as string[])].sort(compareIds)).toEqual(ids["Mixed Show"]);
      // With the values it was selected on: the first 4K episode's.
      expect(mixed).toMatchObject({ resolution: "4k", year: 2002 });
    });

    it("matches NOT Resolution = 4K for a show with any episode that is not 4K, and not an all-4K show", async () => {
      const { server, library } = await seedShows();
      // Its first episode is 4K: read off that one alone, the show was left out.
      const { fadingRep } = await addFadingShow(library.id);

      for (const rules of [NOT_FOURK_RULE, NOT_FOURK_GROUP]) {
        const matched = (await evaluateSeriesScope(rules, [server.id])) as unknown as Record_[];
        expect(titlesOf(matched)).toEqual(["Fading Show", "HD Show", "Mixed Show"]);
        const fading = matched.find((m) => m.title === "Fading Show")!;
        expect(fading).toMatchObject({ id: fadingRep, resolution: "1080" });
      }
    });

    it("reports the matching episode's value, not the representative's", async () => {
      const { server } = await seedShows();

      const matched = (await evaluateSeriesScope(FOURK, [server.id])) as unknown as Record_[];
      const mixed = matched.find((m) => m.title === "Mixed Show")!;

      const criteria = getMatchedCriteriaForItems(matched, FOURK, "SERIES").get(mixed.id as string);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([["Resolution", "4k"]]);
      expect(getActualValuesForAllRules(matched, FOURK, "SERIES").get(mixed.id as string)?.get("r0")).toBe("4k");
    });

    it("stores the match with the values it was selected on, against its representative", async () => {
      const { user, server, ids, mixedRep } = await seedShows();
      const rs = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: true, rules: FOURK, serverIds: [server.id] });

      await detectAndSaveMatches(
        { ...rs, type: "SERIES", rules: FOURK, seriesScope: true, serverIds: [server.id] } as never,
        [server.id],
      );

      const stored = await prisma.ruleMatch.findMany({ where: { ruleSetId: rs.id } });
      const mixed = stored.find((m) => m.mediaItemId === mixedRep)!;
      const itemData = mixed.itemData as Record_;
      expect(itemData).toMatchObject({ title: "Mixed Show", parentTitle: null, resolution: "4k" });
      expect([...(itemData.memberIds as string[])].sort(compareIds)).toEqual(ids["Mixed Show"]);
      expect(itemData.actualValues).toEqual({ r0: "4k" });
      expect((itemData.matchedCriteria as Array<{ actualValue: string }>).map((c) => c.actualValue)).toEqual(["4k"]);
    });

    it("evaluates each show once when no rule reads a per-episode value", async () => {
      const { server } = await seedShows();

      await evaluateSeriesScope(groups([{ field: "playCount", operator: "equals", value: "0" }]), [server.id]);
      expect(evaluations.group).toEqual([1, 1, 1]);

      // A per-episode field: the all-1080p show is tried through every episode.
      evaluations.group.length = 0;
      await evaluateSeriesScope(FOURK, [server.id]);
      expect([...evaluations.group].sort()).toEqual([1, 2, 3]);
    });
  });

  describe("series scope off, forced onto the series path by an aggregate field", () => {
    it("matches a show whose first episode is 1080p through its 4K episodes, which alone are members", async () => {
      const { server, mixedFourK, ids } = await seedShows();

      const matched = (await evaluateSeriesScope(AGGREGATE_AND_FOURK, [server.id], undefined, undefined, true)) as unknown as Record_[];

      expect(titlesOf(matched)).toEqual(["Mixed Show", "UHD Show"]);
      const mixed = matched.find((m) => m.title === "Mixed Show")!;
      expect([...(mixed.memberIds as string[])].sort(compareIds)).toEqual(mixedFourK);
      const uhd = matched.find((m) => m.title === "UHD Show")!;
      expect([...(uhd.memberIds as string[])].sort(compareIds)).toEqual(ids["UHD Show"]);

      const criteria = getMatchedCriteriaForItems(matched, AGGREGATE_AND_FOURK, "SERIES").get(mixed.id as string);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([
        ["Available Episode Count", "3"],
        ["Resolution", "4k"],
      ]);
    });

    it("judges an episode's own play count and reports it, not the show's total", async () => {
      const { server, mixedFourK } = await seedShows();
      // The show's total is 4 (its first episode's plays); the others are unwatched.
      const rules = groups([
        { field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3" },
        { field: "playCount", operator: "equals", value: "0" },
      ]);

      const matched = (await evaluateSeriesScope(rules, [server.id], undefined, undefined, true)) as unknown as Record_[];
      const mixed = matched.find((m) => m.title === "Mixed Show")!;

      expect([...(mixed.memberIds as string[])].sort(compareIds)).toEqual(mixedFourK);
      // Stored as the show (its total) …
      expect(mixed.playCount).toBe(4);
      // … and reported from the episode it was selected through.
      const criteria = getMatchedCriteriaForItems(matched, rules, "SERIES").get(mixed.id as string);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([
        ["Available Episode Count", "3"],
        ["Play Count", "0"],
      ]);
      expect(getActualValuesForAllRules(matched, rules, "SERIES").get(mixed.id as string)?.get("r1")).toBe("0");
    });

    it("stores only the matching episodes as the match's members", async () => {
      const { user, server, mixedFourK, mixedRep } = await seedShows();
      const rs = await createTestRuleSet(user.id, {
        type: "SERIES", seriesScope: false, rules: AGGREGATE_AND_FOURK, serverIds: [server.id],
      });

      const { episodeIdMap } = await detectAndSaveMatches(
        { ...rs, type: "SERIES", rules: AGGREGATE_AND_FOURK, seriesScope: false, serverIds: [server.id] } as never,
        [server.id],
      );

      const stored = await prisma.ruleMatch.findMany({ where: { ruleSetId: rs.id } });
      const mixed = stored.find((m) => m.mediaItemId === mixedRep)!;
      const itemData = mixed.itemData as Record_;
      expect([...(itemData.memberIds as string[])].sort(compareIds)).toEqual(mixedFourK);
      expect([...(episodeIdMap.get(mixedRep) ?? [])].sort(compareIds)).toEqual(mixedFourK);
      expect(itemData).toMatchObject({ title: "Mixed Show", parentTitle: null, resolution: "4k" });
      expect(itemData.actualValues).toEqual({ r0: "3", r1: "4k" });
    });

    it("evaluates each show once when the rule reads only series-level fields", async () => {
      const { server } = await seedShows();

      const matched = await evaluateSeriesScope(
        groups([{ field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3" }]),
        [server.id], undefined, undefined, true,
      );

      expect(matched).toHaveLength(3);
      expect(matched.every((m) => m.memberIds.length === 3)).toBe(true);
      expect(evaluations.episodes).toEqual([1, 1, 1]);
    });
  });

  describe("artist scope on", () => {
    /**
     * "Mixed Band": the lowest-id track MP3 (2001), the others FLAC (2010).
     * "MP3 Band": every track MP3. "FLAC Band": every track FLAC.
     */
    async function seedArtists() {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const ids: Record<string, string[]> = {};
      for (const artist of ["Mixed Band", "MP3 Band", "FLAC Band"]) {
        const created = [];
        for (let t = 1; t <= 3; t++) {
          created.push(await createTestMediaItem(library.id, {
            type: "MUSIC", title: `${artist} T${t}`, parentTitle: artist, albumTitle: "Album",
            audioCodec: artist === "FLAC Band" ? "flac" : "mp3", year: artist === "FLAC Band" ? 2010 : 2001,
          }));
        }
        ids[artist] = created.map((t) => t.id).sort(compareIds);
      }
      const [, ...mixedRest] = ids["Mixed Band"];
      await prisma.mediaItem.updateMany({ where: { id: { in: mixedRest } }, data: { audioCodec: "flac", year: 2010 } });
      return { user, server, library, ids };
    }

    it("matches an artist through any track, by audio codec and by year", async () => {
      const { server, ids } = await seedArtists();

      const flac = (await evaluateMusicScope(groups([{ field: "audioCodec", operator: "equals", value: "flac" }]), [server.id])) as unknown as Record_[];
      expect(titlesOf(flac)).toEqual(["FLAC Band", "Mixed Band"]);
      const mixed = flac.find((m) => m.title === "Mixed Band")!;
      expect(mixed.id).toBe(ids["Mixed Band"][0]);
      expect(mixed).toMatchObject({ audioCodec: "flac", year: 2010 });
      expect([...(mixed.memberIds as string[])].sort(compareIds)).toEqual(ids["Mixed Band"]);

      const recent = await evaluateMusicScope(groups([{ field: "year", operator: "greaterThanOrEqual", value: "2005" }]), [server.id]);
      expect(titlesOf(recent)).toEqual(["FLAC Band", "Mixed Band"]);
    });

    it("matches NOT Audio Codec = FLAC for an artist with any track that is not FLAC, and not an all-FLAC artist", async () => {
      const { server, library } = await seedArtists();
      // "Fading Band": its lowest-id track FLAC, the other MP3. Read off that
      // one alone, the artist was left out.
      const fading = [];
      for (let t = 1; t <= 2; t++) {
        fading.push(await createTestMediaItem(library.id, {
          type: "MUSIC", title: `Fading Band T${t}`, parentTitle: "Fading Band", albumTitle: "Album", audioCodec: "mp3",
        }));
      }
      const [first] = fading.map((t) => t.id).sort(compareIds);
      await prisma.mediaItem.update({ where: { id: first }, data: { audioCodec: "flac" } });

      for (const rules of [
        groups([{ field: "audioCodec", operator: "equals", value: "flac", negate: true }]),
        groups([{ field: "audioCodec", operator: "equals", value: "flac" }], true),
      ]) {
        expect(titlesOf(await evaluateMusicScope(rules, [server.id]))).toEqual(["Fading Band", "MP3 Band", "Mixed Band"]);
      }
    });

    it("reports the matching track's value", async () => {
      const { server, ids } = await seedArtists();
      const rules = groups([{ field: "year", operator: "greaterThanOrEqual", value: "2005" }]);

      const matched = (await evaluateMusicScope(rules, [server.id])) as unknown as Record_[];

      const criteria = getMatchedCriteriaForItems(matched, rules, "MUSIC").get(ids["Mixed Band"][0]);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([["Year", "2010"]]);
    });

    it("evaluates each artist once when no rule reads a per-track value", async () => {
      const { server } = await seedArtists();

      await evaluateMusicScope(groups([{ field: "playCount", operator: "equals", value: "0" }]), [server.id]);
      expect(evaluations.group).toEqual([1, 1, 1]);
    });
  });

  describe("Test Media", () => {
    async function testItem(body: Record_) {
      const response = await callRoute(testItemPost, { url: "/api/lifecycle/rules/test-item", method: "POST", body });
      return expectJson<{ matches: boolean; actualValues: Record<string, string> }>(response, 200);
    }

    it("matches a show in series scope through another episode and reports that episode's value", async () => {
      const { user, server, mixedRep, ids } = await seedShows();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const base = { type: "SERIES", seriesScope: true, serverIds: [server.id] };

      const mixed = await testItem({ ...base, mediaItemId: mixedRep, rules: FOURK });
      expect(mixed).toMatchObject({ matches: true, actualValues: { r0: "4k" } });
      expect((await testItem({ ...base, mediaItemId: mixedRep, rules: NOT_FOURK_RULE })).matches).toBe(true);

      expect((await testItem({ ...base, mediaItemId: ids["HD Show"][0], rules: FOURK })).matches).toBe(false);
      expect((await testItem({ ...base, mediaItemId: ids["UHD Show"][1], rules: NOT_FOURK_GROUP })).matches).toBe(false);
    });

    it("answers a forced-aggregate run per episode, with no show-level gate", async () => {
      const { user, server, mixedRep, mixedFourK } = await seedShows();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const base = { type: "SERIES", seriesScope: false, serverIds: [server.id] };

      expect(await testItem({ ...base, rules: AGGREGATE_AND_FOURK, mediaItemId: mixedFourK[0] })).toMatchObject({
        matches: true, actualValues: { r0: "3", r1: "4k" },
      });
      expect((await testItem({ ...base, rules: AGGREGATE_AND_FOURK, mediaItemId: mixedRep })).matches).toBe(false);

      // The show's play total (4, its first episode's) gated the unwatched
      // episodes, which detection matches on their own.
      const unwatched = groups([
        { field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3" },
        { field: "playCount", operator: "equals", value: "0" },
      ]);
      expect(await testItem({ ...base, rules: unwatched, mediaItemId: mixedFourK[0] })).toMatchObject({
        matches: true, actualValues: { r0: "3", r1: "0" },
      });
      expect((await testItem({ ...base, rules: unwatched, mediaItemId: mixedRep })).matches).toBe(false);
    });

    it("matches an artist in artist scope through another track", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const tracks = [];
      for (let t = 1; t <= 2; t++) {
        tracks.push(await createTestMediaItem(library.id, {
          type: "MUSIC", title: `T${t}`, parentTitle: "Mixed Band", albumTitle: "Album", audioCodec: "mp3",
        }));
      }
      const [first, second] = tracks.map((t) => t.id).sort(compareIds);
      await prisma.mediaItem.update({ where: { id: second }, data: { audioCodec: "flac" } });
      setMockSession({ isLoggedIn: true, userId: user.id });

      expect(await testItem({
        type: "MUSIC", seriesScope: true, serverIds: [server.id], mediaItemId: first,
        rules: groups([{ field: "audioCodec", operator: "equals", value: "flac" }]),
      })).toMatchObject({ matches: true, actualValues: { r0: "flac" } });
    });
  });
});
