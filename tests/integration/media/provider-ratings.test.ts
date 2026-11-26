/**
 * Plex's per-provider ratings against the real database: which rows wait for a
 * full sync to read them (the evaluability guard's input), the re-queue a
 * restore of an older backup runs, and the copy a Jellyfin/Emby item takes of
 * its Plex copy's scores in `recomputeCanonical`.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

import {
  countPendingProviderRatings,
  requeueProviderRatings,
  rowsPredateProviderRatings,
} from "@/lib/sync/provider-ratings";
import { checkLifecycleRuleEvaluability, checkProviderRatingsCompleteness } from "@/lib/lifecycle/evaluability";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import type { LifecycleRuleGroup } from "@/lib/rules/types";
import { ruleToWhere } from "@/lib/conditions/where-builder";
import { collectionSortValues, orderCollectionKeys } from "@/lib/lifecycle/collections";

const prisma = getTestPrisma();
const READ = new Date("2025-06-01T00:00:00.000Z");

const ratings = (row: { id: string }) =>
  prisma.mediaItem.findUniqueOrThrow({
    where: { id: row.id },
    select: { imdbRating: true, tmdbRating: true, rtCriticRating: true, rtAudienceRating: true },
  });

/** A stored item whose details a sync has read (`serverUpdatedAt` set), unless `pending`. */
async function item(
  libraryId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  extra: Record<string, unknown> = {},
  pending = false,
) {
  const row = await createTestMediaItem(libraryId, { type, title: `Item ${Math.random()}` });
  return prisma.mediaItem.update({
    where: { id: row.id },
    data: { serverUpdatedAt: pending ? null : READ, ...extra },
  });
}

const imdbRules = (negate = false): LifecycleRuleGroup[] => [{
  id: "g1",
  condition: "AND",
  rules: [{ id: "r1", field: "imdbRating", operator: "greaterThanOrEqual", value: "6", negate, condition: "AND" }],
  groups: [],
}];

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("countPendingProviderRatings", () => {
  it("counts only unread movies/episodes of the asked types on enabled Plex servers and libraries", async () => {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { name: "Plex", type: "PLEX" });
    const movies = await createTestLibrary(plex.id, { type: "MOVIE" });
    const shows = await createTestLibrary(plex.id, { type: "SERIES" });
    const music = await createTestLibrary(plex.id, { type: "MUSIC" });
    await item(movies.id, "MOVIE", {}, true);
    await item(movies.id, "MOVIE", {}, true);
    await item(movies.id, "MOVIE");
    await item(shows.id, "SERIES", {}, true);
    await item(music.id, "MUSIC", {}, true);
    // Not counted: a disabled library, a disabled Plex server, a Jellyfin server.
    const disabledLib = await createTestLibrary(plex.id, { type: "MOVIE", enabled: false });
    await item(disabledLib.id, "MOVIE", {}, true);
    const off = await createTestServer(user.id, { name: "Off", type: "PLEX", enabled: false });
    await item((await createTestLibrary(off.id, { type: "MOVIE" })).id, "MOVIE", {}, true);
    const jelly = await createTestServer(user.id, { name: "Jelly", type: "JELLYFIN" });
    await item((await createTestLibrary(jelly.id, { type: "MOVIE" })).id, "MOVIE", {}, true);

    expect(await countPendingProviderRatings(prisma, user.id, ["MOVIE"])).toEqual([{ name: "Plex", pending: 2 }]);
    expect(await countPendingProviderRatings(prisma, user.id, ["SERIES"])).toEqual([{ name: "Plex", pending: 1 }]);
    expect(await countPendingProviderRatings(prisma, user.id, ["MOVIE", "SERIES"])).toEqual([{ name: "Plex", pending: 3 }]);
    expect(await countPendingProviderRatings(prisma, user.id, [])).toEqual([]);
  });
});

describe("requeueProviderRatings", () => {
  it("clears serverUpdatedAt on Plex movies and episodes only", async () => {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { type: "PLEX" });
    const jelly = await createTestServer(user.id, { type: "JELLYFIN" });
    const movie = await item((await createTestLibrary(plex.id, { type: "MOVIE" })).id, "MOVIE");
    const episode = await item((await createTestLibrary(plex.id, { type: "SERIES" })).id, "SERIES");
    const track = await item((await createTestLibrary(plex.id, { type: "MUSIC" })).id, "MUSIC");
    const jellyMovie = await item((await createTestLibrary(jelly.id, { type: "MOVIE" })).id, "MOVIE");

    expect(await requeueProviderRatings(prisma)).toBe(2);

    const stamp = async (row: { id: string }) =>
      (await prisma.mediaItem.findUniqueOrThrow({ where: { id: row.id } })).serverUpdatedAt;
    expect(await stamp(movie)).toBeNull();
    expect(await stamp(episode)).toBeNull();
    expect(await stamp(track)).toEqual(READ);
    expect(await stamp(jellyMovie)).toEqual(READ);
  });

  it("tells a backup's rows from before the ratings by the missing column", () => {
    expect(rowsPredateProviderRatings([{ id: "a", title: "x" }])).toBe(true);
    expect(rowsPredateProviderRatings([{ id: "a", imdbRating: null }])).toBe(false);
    expect(rowsPredateProviderRatings([])).toBe(false);
  });
});

describe("the evaluability guard", () => {
  it("refuses rules reading Plex ratings while a Plex movie is unread, naming the server", async () => {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { name: "Plex Home", type: "PLEX" });
    const movie = await item((await createTestLibrary(plex.id, { type: "MOVIE" })).id, "MOVIE", {}, true);

    const ratingsCheck = await checkProviderRatingsCompleteness(user.id, "MOVIE");
    expect(ratingsCheck.complete).toBe(false);
    const result = await checkLifecycleRuleEvaluability(user.id, "MOVIE", imdbRules(true), [], null, false);
    expect(result).toMatchObject({ evaluable: false, permanent: false });
    expect(result.evaluable === false && result.reason).toContain('"Plex Home" (1 movie(s))');

    // A Series rule set does not wait for movies; other rules never wait.
    expect(await checkProviderRatingsCompleteness(user.id, "SERIES")).toEqual({ complete: true });
    expect(await checkProviderRatingsCompleteness(user.id, "MUSIC")).toEqual({ complete: true });
    const plain: LifecycleRuleGroup[] = [{
      id: "g1", condition: "AND", groups: [],
      rules: [{ id: "r1", field: "year", operator: "greaterThan", value: "2000", condition: "AND" }],
    }];
    expect(await checkLifecycleRuleEvaluability(user.id, "MOVIE", plain, [], null, false)).toEqual({ evaluable: true });

    await prisma.mediaItem.update({ where: { id: movie.id }, data: { serverUpdatedAt: READ } });
    expect(await checkLifecycleRuleEvaluability(user.id, "MOVIE", imdbRules(true), [], null, false)).toEqual({ evaluable: true });
  });

  it("waits for Plex even for a rule set scoped to a Jellyfin server, whose copies carry Plex's scores", async () => {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { type: "PLEX" });
    const jelly = await createTestServer(user.id, { type: "JELLYFIN" });
    await item((await createTestLibrary(plex.id, { type: "MOVIE" })).id, "MOVIE", {}, true);

    const result = await checkLifecycleRuleEvaluability(user.id, "MOVIE", imdbRules(), [jelly.id], null, false);
    expect(result.evaluable).toBe(false);
  });
});

describe("recomputeCanonical copies Plex's scores onto Jellyfin/Emby copies", () => {
  async function copies() {
    const user = await createTestUser();
    const plex = await createTestServer(user.id, { name: "Plex", type: "PLEX" });
    const jelly = await createTestServer(user.id, { name: "Jelly", type: "JELLYFIN" });
    const emby = await createTestServer(user.id, { name: "Emby", type: "EMBY" });
    const scores = { imdbRating: 7.4, tmdbRating: 7.5, rtCriticRating: 9.4, rtAudienceRating: 9.2 };
    const plexMovie = await item((await createTestLibrary(plex.id, { type: "MOVIE" })).id, "MOVIE", { dedupKey: "movie:k", ...scores });
    const jellyMovie = await item((await createTestLibrary(jelly.id, { type: "MOVIE" })).id, "MOVIE", { dedupKey: "movie:k" });
    const embyMovie = await item((await createTestLibrary(emby.id, { type: "MOVIE" })).id, "MOVIE", { dedupKey: "movie:k" });
    const loneJelly = await item((await createTestLibrary(jelly.id, { type: "MOVIE" })).id, "MOVIE", { dedupKey: "movie:lone", imdbRating: 3 });
    return { user, plex, scores, plexMovie, jellyMovie, embyMovie, loneJelly };
  }

  it("writes the group's Plex scores onto its other copies, and clears a copy with no Plex twin", async () => {
    const { user, scores, plexMovie, jellyMovie, embyMovie, loneJelly } = await copies();

    await recomputeCanonical(user.id);

    expect(await ratings(jellyMovie)).toEqual(scores);
    expect(await ratings(embyMovie)).toEqual(scores);
    expect(await ratings(plexMovie)).toEqual(scores);
    expect(await ratings(loneJelly)).toEqual({ imdbRating: null, tmdbRating: null, rtCriticRating: null, rtAudienceRating: null });
  });

  it("follows the Plex copy's changes and its removal", async () => {
    const { user, plexMovie, jellyMovie } = await copies();
    await recomputeCanonical(user.id);

    await prisma.mediaItem.update({ where: { id: plexMovie.id }, data: { imdbRating: 8.1, rtCriticRating: null } });
    await recomputeCanonical(user.id, { dedupKeys: ["movie:k"] });
    expect(await ratings(jellyMovie)).toMatchObject({ imdbRating: 8.1, rtCriticRating: null, tmdbRating: 7.5 });

    await prisma.mediaItem.delete({ where: { id: plexMovie.id } });
    await recomputeCanonical(user.id, { dedupKeys: ["movie:k"] });
    expect(await ratings(jellyMovie)).toEqual({ imdbRating: null, tmdbRating: null, rtCriticRating: null, rtAudienceRating: null });
  });

  it("leaves groups outside a scoped recompute alone", async () => {
    const { user, jellyMovie } = await copies();

    await recomputeCanonical(user.id, { dedupKeys: ["movie:other"] });

    expect((await ratings(jellyMovie)).imdbRating).toBeNull();
  });

  it("prefers an enabled Plex copy's score when two Plex copies disagree", async () => {
    const { user, jellyMovie } = await copies();
    const off = await createTestServer(user.id, { name: "Old Plex", type: "PLEX", enabled: false });
    await item((await createTestLibrary(off.id, { type: "MOVIE" })).id, "MOVIE", { dedupKey: "movie:k", imdbRating: 1 });

    await recomputeCanonical(user.id);

    expect((await ratings(jellyMovie)).imdbRating).toBe(7.4);
  });
});

describe("Phase 1 against the database", () => {
  it("leaves an unrated item out of a negated comparison and a not-equals", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" });
    const low = await item(lib.id, "MOVIE", { imdbRating: 5 });
    const high = await item(lib.id, "MOVIE", { imdbRating: 8 });
    const unrated = await item(lib.id, "MOVIE");
    const ids = async (where: ReturnType<typeof ruleToWhere>) =>
      (await prisma.mediaItem.findMany({ where, select: { id: true } })).map((r) => r.id).sort();

    expect(await ids(ruleToWhere({ id: "r", field: "imdbRating", operator: "greaterThanOrEqual", value: "6", negate: true, condition: "AND" })))
      .toEqual([low.id]);
    expect(await ids(ruleToWhere({ id: "r", field: "imdbRating", operator: "notEquals", value: "8", condition: "AND" })))
      .toEqual([low.id]);
    expect(await ids(ruleToWhere({ id: "r", field: "imdbRating", operator: "isNull", value: "", condition: "AND" })))
      .toEqual([unrated.id]);
    expect(await ids(ruleToWhere({ id: "r", field: "imdbRating", operator: "isNotNull", value: "", negate: true, condition: "AND" })))
      .toEqual([unrated.id]);
    expect(high.id).toBeDefined();
  });
});

describe("Plex collection order by a per-provider rating", () => {
  it("orders by each provider's score, an unrated item last", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" });
    const a = await item(lib.id, "MOVIE", { ratingKey: "a", imdbRating: 6, tmdbRating: 9, rtCriticRating: 5, rtAudienceRating: 8 });
    const b = await item(lib.id, "MOVIE", { ratingKey: "b", imdbRating: 8, tmdbRating: 5, rtCriticRating: 9, rtAudienceRating: 4 });
    const c = await item(lib.id, "MOVIE", { ratingKey: "c" });
    const keys = [a.ratingKey, b.ratingKey, c.ratingKey];
    const plan = {
      desiredSet: new Set(keys), desiredKeys: keys, copyKeysByItemId: new Map(),
      seriesKeyByTitle: null, showTitleSortByKey: null, showTitleByKey: null, libItemCount: 3,
    };
    const order = async (field: Parameters<typeof collectionSortValues>[0]) =>
      orderCollectionKeys(keys, await collectionSortValues(field, lib.id, plan, [], new Map()), "desc", keys);

    expect(await order("IMDB_RATING")).toEqual(["b", "a", "c"]);
    expect(await order("TMDB_RATING")).toEqual(["a", "b", "c"]);
    expect(await order("RT_CRITIC_RATING")).toEqual(["b", "a", "c"]);
    expect(await order("RT_AUDIENCE_RATING")).toEqual(["a", "b", "c"]);
  });
});
