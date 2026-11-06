/**
 * A show or artist evaluated as a whole matches a rule when at least one of
 * its members satisfies the whole rule, each member seen as the group carrying
 * its own per-member values.
 *
 * Every per-member field is a criterion of one episode or track, which series
 * and artist scope do not allow (`groupScopeViolation`): not only Resolution,
 * the codecs and Year, but Content Rating, Studio, Genre, Label and Is
 * Watchlisted too, which the sync stores per episode or track and does not
 * keep alike across a show or artist — matched through any member, "NOT
 * Content Rating = TV-MA" matched a show with one TV-14 episode. The
 * group-scope engines and Test Media refuse them, so a show or artist is only
 * ever judged on its own values, once. Series scope off, forced through the
 * series path by an aggregate field, still checks every criterion per episode.
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
/** A per-member field series scope allows: the show's metadata on each episode. */
const MATURE = groups([{ field: "contentRating", operator: "equals", value: "TV-MA" }]);
const NOT_MATURE_RULE = groups([{ field: "contentRating", operator: "equals", value: "TV-MA", negate: true }]);
const NOT_MATURE_GROUP = groups([{ field: "contentRating", operator: "equals", value: "TV-MA" }], true);
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
   *  - "Mixed Show": the lowest-id episode (the representative) 1080p and
   *    TV-14, the other two 4K and TV-MA; the representative watched, the
   *    others not.
   *  - "HD Show": every episode 1080p, TV-14.
   *  - "UHD Show": every episode 4K, TV-MA.
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
          contentRating: show === "UHD Show" ? "TV-MA" : "TV-14",
        }));
      }
      ids[show] = created.map((ep) => ep.id).sort(compareIds);
    }
    const [mixedRep, ...mixedRest] = ids["Mixed Show"];
    await prisma.mediaItem.updateMany({ where: { id: { in: mixedRest } }, data: { resolution: "4k", contentRating: "TV-MA" } });
    await prisma.mediaItem.update({ where: { id: mixedRep }, data: { playCount: 4, year: 2001 } });
    await prisma.mediaItem.update({ where: { id: mixedRest[0] }, data: { year: 2002 } });
    return { user, server, library, ids, mixedRep, mixedFourK: mixedRest };
  }

  /** "Fading Show": the lowest-id episode TV-MA, the other two TV-14. */
  async function addFadingShow(libraryId: string) {
    const created = [];
    for (let e = 1; e <= 3; e++) {
      created.push(await createTestMediaItem(libraryId, {
        type: "SERIES", title: `Fading E${e}`, parentTitle: "Fading Show", seasonNumber: 1, episodeNumber: e,
        contentRating: "TV-14",
      }));
    }
    const [first, ...rest] = created.map((ep) => ep.id).sort(compareIds);
    await prisma.mediaItem.update({ where: { id: first }, data: { contentRating: "TV-MA" } });
    return { fadingRep: first, fadingRest: rest };
  }

  describe("series scope on", () => {
    it("matches nothing for a criterion that describes one episode, which series scope does not allow", async () => {
      const { server } = await seedShows();

      // Mixed and UHD Show each have a 4K episode: judged through any episode,
      // both would match and a whole-series action take every 1080p episode.
      expect(await evaluateSeriesScope(FOURK, [server.id])).toEqual([]);
      expect(await evaluateSeriesScope(groups([{ field: "year", operator: "equals", value: "2002" }]), [server.id])).toEqual([]);
      expect(evaluations.group).toEqual([]);
    });

    it("matches nothing for Content Rating either: each episode carries its own", async () => {
      const { server, library } = await seedShows();
      // "Fading Show": its first episode TV-MA, the other two TV-14. Matched
      // through any episode, NOT Content Rating = TV-MA took it (and Mixed
      // Show) whole on one TV-14 episode, beside the TV-MA ones.
      await addFadingShow(library.id);

      for (const rules of [MATURE, NOT_MATURE_RULE, NOT_MATURE_GROUP]) {
        expect(await evaluateSeriesScope(rules, [server.id])).toEqual([]);
      }
      expect(evaluations.group).toEqual([]);
    });

    it("evaluates each show once: every criterion series scope allows is the show's own", async () => {
      const { server, ids, mixedRep } = await seedShows();

      for (const rule of [
        { field: "playCount", operator: "equals", value: "0" },
        { field: "title", operator: "contains", value: "Show" },
        { field: "availableEpisodeCount", operator: "greaterThanOrEqual", value: "3" },
      ]) {
        evaluations.group.length = 0;
        const matched = (await evaluateSeriesScope(groups([rule]), [server.id])) as unknown as Record_[];
        expect(evaluations.group, rule.field).toEqual([1, 1, 1]);
        if (rule.field === "title") {
          // Still the show: stored against its representative, every episode a member.
          const mixed = matched.find((m) => m.title === "Mixed Show")!;
          expect(mixed.id).toBe(mixedRep);
          expect(mixed.parentTitle).toBeNull();
          expect([...(mixed.memberIds as string[])].sort(compareIds)).toEqual(ids["Mixed Show"]);
          const criteria = getMatchedCriteriaForItems(matched, groups([rule]), "SERIES").get(mixedRep);
          expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([["Title", "Mixed Show"]]);
          expect(getActualValuesForAllRules(matched, groups([rule]), "SERIES").get(mixedRep)?.get("r0")).toBe("Mixed Show");
        }
      }
    });

    it("stores a show-level match against its representative", async () => {
      const { user, server, ids, mixedRep } = await seedShows();
      const rules = groups([{ field: "title", operator: "equals", value: "Mixed Show" }]);
      const rs = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: true, rules, serverIds: [server.id] });

      await detectAndSaveMatches(
        { ...rs, type: "SERIES", rules, seriesScope: true, serverIds: [server.id] } as never,
        [server.id],
      );

      const stored = await prisma.ruleMatch.findMany({ where: { ruleSetId: rs.id } });
      expect(stored.map((m) => m.mediaItemId)).toEqual([mixedRep]);
      const itemData = stored[0].itemData as Record_;
      expect(itemData).toMatchObject({ title: "Mixed Show", parentTitle: null });
      expect([...(itemData.memberIds as string[])].sort(compareIds)).toEqual(ids["Mixed Show"]);
      expect(itemData.actualValues).toEqual({ r0: "Mixed Show" });
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
     * "Mixed Band": the lowest-id track MP3 (2001, Indie Records), the others
     * FLAC (2010, Big Records). "Indie Band": every track MP3, Indie Records.
     * "Big Band": every track FLAC, Big Records.
     */
    async function seedArtists() {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const ids: Record<string, string[]> = {};
      for (const artist of ["Mixed Band", "Indie Band", "Big Band"]) {
        const created = [];
        for (let t = 1; t <= 3; t++) {
          created.push(await createTestMediaItem(library.id, {
            type: "MUSIC", title: `${artist} T${t}`, parentTitle: artist, albumTitle: "Album",
            audioCodec: artist === "Big Band" ? "flac" : "mp3", year: artist === "Big Band" ? 2010 : 2001,
            studio: artist === "Big Band" ? "Big Records" : "Indie Records",
          }));
        }
        ids[artist] = created.map((t) => t.id).sort(compareIds);
      }
      const [, ...mixedRest] = ids["Mixed Band"];
      await prisma.mediaItem.updateMany({
        where: { id: { in: mixedRest } },
        data: { audioCodec: "flac", year: 2010, studio: "Big Records" },
      });
      return { user, server, library, ids };
    }

    it("matches nothing for a criterion that describes one track, which artist scope does not allow", async () => {
      const { server } = await seedArtists();

      for (const rule of [
        { field: "audioCodec", operator: "equals", value: "flac" },
        { field: "year", operator: "greaterThanOrEqual", value: "2005" },
        { field: "albumTitle", operator: "equals", value: "Album" },
        // A track's own label, genres and ids: Mixed Band's tracks disagree.
        { field: "studio", operator: "equals", value: "Big Records" },
        { field: "studio", operator: "equals", value: "Big Records", negate: true },
        { field: "genre", operator: "contains", value: "Rock", negate: true },
        { field: "hasExternalId", operator: "equals", value: "MUSICBRAINZ" },
      ]) {
        expect(await evaluateMusicScope(groups([rule]), [server.id]), rule.field).toEqual([]);
      }
      expect(evaluations.group).toEqual([]);
    });

    it("evaluates each artist once: every criterion artist scope allows is the artist's own", async () => {
      const { server, ids } = await seedArtists();

      await evaluateMusicScope(groups([{ field: "playCount", operator: "equals", value: "0" }]), [server.id]);
      expect(evaluations.group).toEqual([1, 1, 1]);

      evaluations.group.length = 0;
      const rules = groups([{ field: "parentTitle", operator: "equals", value: "Mixed Band" }]);
      const matched = (await evaluateMusicScope(rules, [server.id])) as unknown as Record_[];
      expect(evaluations.group).toEqual([1, 1, 1]);
      expect(titlesOf(matched)).toEqual(["Mixed Band"]);
      expect(matched[0].id).toBe(ids["Mixed Band"][0]);
      expect([...(matched[0].memberIds as string[])].sort(compareIds)).toEqual(ids["Mixed Band"]);
      const criteria = getMatchedCriteriaForItems(matched, rules, "MUSIC").get(ids["Mixed Band"][0]);
      expect(criteria?.map((c) => [c.field, c.actualValue])).toEqual([["Artist / Series", "Mixed Band"]]);
    });
  });

  describe("Test Media", () => {
    async function testItem(body: Record_) {
      const response = await callRoute(testItemPost, { url: "/api/lifecycle/rules/test-item", method: "POST", body });
      return expectJson<{ matches: boolean; actualValues: Record<string, string> }>(response, 200);
    }

    it("judges a show in series scope on its own values, and answers Content Rating with the reason", async () => {
      const { user, server, mixedRep, ids } = await seedShows();
      setMockSession({ isLoggedIn: true, userId: user.id });
      const base = { type: "SERIES", seriesScope: true, serverIds: [server.id] };

      const byName = groups([{ field: "title", operator: "equals", value: "Mixed Show" }]);
      expect(await testItem({ ...base, mediaItemId: ids["Mixed Show"][2], rules: byName })).toMatchObject({
        matches: true, actualValues: { r0: "Mixed Show" },
      });
      expect((await testItem({ ...base, mediaItemId: ids["HD Show"][0], rules: byName })).matches).toBe(false);

      for (const rules of [MATURE, NOT_MATURE_RULE, NOT_MATURE_GROUP]) {
        const refused = await callRoute(testItemPost, {
          url: "/api/lifecycle/rules/test-item", method: "POST", body: { ...base, mediaItemId: mixedRep, rules },
        });
        expect((await expectJson<{ error: string }>(refused, 400)).error).toMatch(/^This rule set uses per-episode criteria \(Content Rating\)/);
      }
    });

    it("answers a per-episode criterion in series scope with the reason instead of evaluating it", async () => {
      const { user, server, mixedRep } = await seedShows();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(testItemPost, {
        url: "/api/lifecycle/rules/test-item",
        method: "POST",
        body: { type: "SERIES", seriesScope: true, serverIds: [server.id], mediaItemId: mixedRep, rules: FOURK },
      });
      const refused = await expectJson<{ error: string }>(response, 400);
      expect(refused.error).toMatch(/^This rule set uses per-episode criteria \(Resolution\) with "Match against entire series" on/);
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

    it("answers a per-track criterion in artist scope with the reason, and checks it per track with the scope off", async () => {
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
      await prisma.mediaItem.update({ where: { id: second }, data: { audioCodec: "flac", studio: "Big Records" } });
      setMockSession({ isLoggedIn: true, userId: user.id });
      const base = { type: "MUSIC", seriesScope: true, serverIds: [server.id], mediaItemId: first };

      // A per-track criterion — Studio, one track's label, as much as Audio
      // Codec: refused with the reason, in artist scope only.
      for (const [field, value, label] of [["audioCodec", "flac", "Audio Codec"], ["studio", "Big Records", "Studio"]] as const) {
        const refused = await callRoute(testItemPost, {
          url: "/api/lifecycle/rules/test-item",
          method: "POST",
          body: { ...base, rules: groups([{ field, operator: "equals", value }]) },
        });
        expect((await expectJson<{ error: string }>(refused, 400)).error).toMatch(new RegExp(`^This rule set uses per-track criteria \\(${label}\\)`));
      }
      expect(await testItem({
        ...base,
        seriesScope: false,
        mediaItemId: second,
        rules: groups([{ field: "audioCodec", operator: "equals", value: "flac" }]),
      })).toMatchObject({ matches: true, actualValues: { r0: "flac" } });
    });
  });
});
