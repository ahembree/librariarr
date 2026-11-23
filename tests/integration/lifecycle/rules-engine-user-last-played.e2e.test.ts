/**
 * E2E: the `userLastPlayedAt` criterion (User Last Played) against real
 * WatchHistory rows — the date one named user last played an item. Exercises
 * the flat engine (`evaluateLifecycleRules`, Phase 2 forced over an empty
 * Phase 1 clause), the series- and artist-scope engines (each user's latest
 * play across the group's members) and the query engine.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope } =
  await import("@/lib/rules/lifecycle-engine");

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

let serverId: string;

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();
  const user = await prisma.user.create({ data: { username: "test-user-last-played", passwordHash: "x" } });
  const server = await prisma.mediaServer.create({
    data: { userId: user.id, name: "Test", type: "PLEX", url: "http://test:32400", accessToken: "x", machineId: "ulp-test" },
  });
  serverId = server.id;
  const movieLib = await prisma.library.create({ data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" } });
  const seriesLib = await prisma.library.create({ data: { mediaServerId: server.id, key: "2", title: "Shows", type: "SERIES" } });
  const musicLib = await prisma.library.create({ data: { mediaServerId: server.id, key: "3", title: "Music", type: "MUSIC" } });

  const movie = (ratingKey: string, title: string) =>
    prisma.mediaItem.create({ data: { libraryId: movieLib.id, ratingKey, title, type: "MOVIE", year: 2020 } });
  const [recent, old, bobOnly, none, undated] = await Promise.all([
    movie("m-recent", "Alice Recent"),
    movie("m-old", "Alice Old, Bob Recent"),
    movie("m-bob", "Bob Only"),
    movie("m-none", "Never Watched"),
    movie("m-undated", "Alice Undated"),
  ]);
  const play = (mediaItemId: string, serverUsername: string, watchedAt: Date | null) =>
    ({ mediaItemId, mediaServerId: server.id, serverUsername, watchedAt });
  await prisma.watchHistory.createMany({
    data: [
      play(recent.id, "Alice", daysAgo(5)),
      play(recent.id, "alice", daysAgo(400)),
      play(old.id, "alice", daysAgo(200)),
      play(old.id, "bob", daysAgo(3)),
      play(bobOnly.id, "bob", daysAgo(10)),
      play(undated.id, "alice", null),
      // A Tracearr play that stopped short of completion never counts.
      { ...play(none.id, "alice", daysAgo(1)), source: "TRACEARR", watched: false },
    ],
  });

  // Show A: alice watched episode 1 long ago and episode 2 last week.
  // Show B: alice only long ago.
  const ep = (show: string, n: number) =>
    prisma.mediaItem.create({
      data: { libraryId: seriesLib.id, ratingKey: `${show}-${n}`, title: `E${n}`, type: "SERIES", parentTitle: show, seasonNumber: 1, episodeNumber: n },
    });
  const [a1, a2, b1] = await Promise.all([ep("Show A", 1), ep("Show A", 2), ep("Show B", 1)]);
  await prisma.watchHistory.createMany({
    data: [play(a1.id, "alice", daysAgo(300)), play(a2.id, "alice", daysAgo(6)), play(b1.id, "alice", daysAgo(300))],
  });

  const track = (artist: string, n: number) =>
    prisma.mediaItem.create({ data: { libraryId: musicLib.id, ratingKey: `${artist}-${n}`, title: `T${n}`, type: "MUSIC", parentTitle: artist } });
  const [t1, t2] = await Promise.all([track("Artist 1", 1), track("Artist 2", 1)]);
  await prisma.watchHistory.createMany({ data: [play(t1.id, "alice", daysAgo(2)), play(t2.id, "bob", daysAgo(2))] });
});

afterAll(async () => {
  await disconnectTestDb();
});

function rules(overrides: Partial<LifecycleRule> = {}, extra: LifecycleRule[] = []): LifecycleRuleGroup[] {
  return [{
    id: "g", condition: "AND",
    rules: [{ id: "r", field: "userLastPlayedAt", operator: "inLastDays", value: "30", condition: "AND", user: "alice", ...overrides }, ...extra],
    groups: [],
  }];
}

async function movieTitles(groups: LifecycleRuleGroup[]) {
  return (await evaluateLifecycleRules(groups, "MOVIE", [serverId])).map((i) => i.title).sort();
}

describe("evaluateLifecycleRules — User Last Played on movies", () => {
  it("matches only movies the named user played within the window", async () => {
    expect(await movieTitles(rules())).toEqual(["Alice Recent"]);
    expect(await movieTitles(rules({ user: "BOB" }))).toEqual(["Alice Old, Bob Recent", "Bob Only"]);
  });

  it("reads the user's latest play for More Than X Days Ago", async () => {
    expect(await movieTitles(rules({ operator: "notInLastDays" }))).toEqual(["Alice Old, Bob Recent"]);
  });

  it("reads a user with no dated counted play as empty", async () => {
    expect(await movieTitles(rules({ operator: "isNull", value: "" })))
      .toEqual(["Alice Undated", "Bob Only", "Never Watched"]);
    expect(await movieTitles(rules({ negate: true })))
      .toEqual(["Alice Old, Bob Recent", "Alice Undated", "Bob Only", "Never Watched"]);
  });

  it("combines with Phase-1 criteria", async () => {
    const year = { id: "y", field: "year", operator: "equals", value: "2020", condition: "AND" as const };
    expect(await movieTitles(rules({}, [year]))).toEqual(["Alice Recent"]);
    expect(await movieTitles(rules({}, [{ ...year, value: "1999" }]))).toEqual([]);
  });

  it("matches nothing without a user", async () => {
    expect(await movieTitles(rules({ user: undefined }))).toEqual([]);
    expect(await movieTitles(rules({ user: undefined, negate: true }))).toEqual([]);
  });
});

describe("group scopes — the user's latest play of any member", () => {
  it("series scope matches a show alice watched any episode of recently", async () => {
    const shows = await evaluateSeriesScope(rules(), [serverId]);
    expect(shows.map((s) => s.title)).toEqual(["Show A"]);
    const stale = await evaluateSeriesScope(rules({ operator: "notInLastDays" }), [serverId]);
    expect(stale.map((s) => s.title)).toEqual(["Show B"]);
  });

  it("artist scope matches an artist alice played a track of recently", async () => {
    const artists = await evaluateMusicScope(rules(), [serverId]);
    expect(artists.map((a) => a.title)).toEqual(["Artist 1"]);
  });
});
