/**
 * E2E regression: `watchedByUser` rule criterion against real WatchHistory
 * rows. Exercises Phase 1 (Prisma `watchHistory: { some/none }` filter via
 * `evaluateLifecycleRules`) and Phase 2 (in-memory aggregate evaluation via
 * `evaluateSeriesScope` and `evaluateMusicScope`) end-to-end.
 *
 * "Watched by" means **any play by that user** — a single WatchHistory row
 * with the given `serverUsername` satisfies the positive predicate. Series-
 * and music-scope evaluations roll all child episode/track usernames into a
 * deduped `watchedByUsers` set so an artist matches when *any* track was
 * played by the user.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

const { evaluateLifecycleRules, evaluateSeriesScope, evaluateMusicScope } =
  await import("@/lib/rules/lifecycle-engine");

let serverId: string;
let movieAliceId: string;
let movieBobId: string;
let movieAliceBobId: string;
let movieUnwatchedId: string;

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();

  const user = await prisma.user.create({
    data: { username: "test-watched-by-user", passwordHash: "x" },
  });
  const server = await prisma.mediaServer.create({
    data: {
      userId: user.id,
      name: "Test",
      type: "PLEX",
      url: "http://test:32400",
      accessToken: "x",
      machineId: "watched-by-user-test",
    },
  });
  serverId = server.id;

  const movieLib = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });
  const seriesLib = await prisma.library.create({
    data: { mediaServerId: server.id, key: "2", title: "Shows", type: "SERIES" },
  });
  const musicLib = await prisma.library.create({
    data: { mediaServerId: server.id, key: "3", title: "Music", type: "MUSIC" },
  });

  // ─── Movies: 4 items with distinct watch-history patterns ─────────────
  const movies = await Promise.all([
    prisma.mediaItem.create({
      data: { libraryId: movieLib.id, ratingKey: "m-alice", title: "Watched by Alice", type: "MOVIE" },
    }),
    prisma.mediaItem.create({
      data: { libraryId: movieLib.id, ratingKey: "m-bob", title: "Watched by Bob", type: "MOVIE" },
    }),
    prisma.mediaItem.create({
      data: { libraryId: movieLib.id, ratingKey: "m-both", title: "Watched by Both", type: "MOVIE" },
    }),
    prisma.mediaItem.create({
      data: { libraryId: movieLib.id, ratingKey: "m-none", title: "Never Watched", type: "MOVIE" },
    }),
  ]);
  [movieAliceId, movieBobId, movieAliceBobId, movieUnwatchedId] = movies.map((m) => m.id);

  await prisma.watchHistory.createMany({
    data: [
      // Alice-only
      { mediaItemId: movieAliceId, mediaServerId: server.id, serverUsername: "alice" },
      // Alice watched twice (verifies dedup at distinct level)
      { mediaItemId: movieAliceId, mediaServerId: server.id, serverUsername: "alice" },
      // Bob-only
      { mediaItemId: movieBobId, mediaServerId: server.id, serverUsername: "bob" },
      // Both
      { mediaItemId: movieAliceBobId, mediaServerId: server.id, serverUsername: "alice" },
      { mediaItemId: movieAliceBobId, mediaServerId: server.id, serverUsername: "bob" },
      // movieUnwatchedId — no rows
    ],
  });

  // ─── Series: 2 series, each with 2 episodes ────────────────────────────
  const showA = await prisma.mediaItem.createMany({
    data: [
      {
        libraryId: seriesLib.id, ratingKey: "showA-S1E1", title: "S1E1", type: "SERIES",
        parentTitle: "Show A", seasonNumber: 1, episodeNumber: 1,
      },
      {
        libraryId: seriesLib.id, ratingKey: "showA-S1E2", title: "S1E2", type: "SERIES",
        parentTitle: "Show A", seasonNumber: 1, episodeNumber: 2,
      },
    ],
  });
  void showA;
  const showB = await prisma.mediaItem.createMany({
    data: [
      {
        libraryId: seriesLib.id, ratingKey: "showB-S1E1", title: "S1E1", type: "SERIES",
        parentTitle: "Show B", seasonNumber: 1, episodeNumber: 1,
      },
      {
        libraryId: seriesLib.id, ratingKey: "showB-S1E2", title: "S1E2", type: "SERIES",
        parentTitle: "Show B", seasonNumber: 1, episodeNumber: 2,
      },
    ],
  });
  void showB;
  const showAEpisodes = await prisma.mediaItem.findMany({
    where: { libraryId: seriesLib.id, parentTitle: "Show A" },
  });
  const showBEpisodes = await prisma.mediaItem.findMany({
    where: { libraryId: seriesLib.id, parentTitle: "Show B" },
  });
  // Show A: episode 1 watched by alice; episode 2 watched by bob.
  // Show B: nobody watched anything.
  await prisma.watchHistory.createMany({
    data: [
      { mediaItemId: showAEpisodes[0].id, mediaServerId: server.id, serverUsername: "alice" },
      { mediaItemId: showAEpisodes[1].id, mediaServerId: server.id, serverUsername: "bob" },
    ],
  });

  // ─── Music: 2 artists, each with 2 tracks ─────────────────────────────
  await prisma.mediaItem.createMany({
    data: [
      { libraryId: musicLib.id, ratingKey: "artist1-t1", title: "T1", type: "MUSIC", parentTitle: "Artist 1" },
      { libraryId: musicLib.id, ratingKey: "artist1-t2", title: "T2", type: "MUSIC", parentTitle: "Artist 1" },
      { libraryId: musicLib.id, ratingKey: "artist2-t1", title: "T1", type: "MUSIC", parentTitle: "Artist 2" },
      { libraryId: musicLib.id, ratingKey: "artist2-t2", title: "T2", type: "MUSIC", parentTitle: "Artist 2" },
    ],
  });
  const artist1Tracks = await prisma.mediaItem.findMany({
    where: { libraryId: musicLib.id, parentTitle: "Artist 1" },
  });
  // Artist 1: one track played by alice. Artist 2: nothing.
  await prisma.watchHistory.create({
    data: { mediaItemId: artist1Tracks[0].id, mediaServerId: server.id, serverUsername: "alice" },
  });
});

afterAll(async () => {
  await disconnectTestDb();
});

function group(operator: string, value: string, negate = false): LifecycleRuleGroup[] {
  return [{
    id: "g", condition: "AND",
    rules: [{ id: "r", field: "watchedByUser", operator, value, condition: "AND", negate }],
    groups: [],
  }];
}

async function movieTitles(rules: LifecycleRuleGroup[]) {
  const items = await evaluateLifecycleRules(rules, "MOVIE", [serverId]);
  return items.map((i) => i.title).sort();
}

// ---------------------------------------------------------------------------
// Phase 1 (Prisma WHERE) — movies via evaluateLifecycleRules
// ---------------------------------------------------------------------------

describe("evaluateLifecycleRules — watchedByUser on movies (Phase 1)", () => {
  it("equals returns only movies watched by that user (case-insensitive)", async () => {
    expect(await movieTitles(group("equals", "ALICE"))).toEqual(["Watched by Alice", "Watched by Both"]);
  });

  it("notEquals returns movies NOT watched by that user (including never-watched)", async () => {
    expect(await movieTitles(group("notEquals", "alice"))).toEqual(["Never Watched", "Watched by Bob"]);
  });

  it("contains multi-select returns movies watched by ANY of the listed users", async () => {
    expect(await movieTitles(group("contains", "alice|bob")))
      .toEqual(["Watched by Alice", "Watched by Bob", "Watched by Both"]);
  });

  it("contains with a username nobody has → no matches", async () => {
    expect(await movieTitles(group("contains", "ghost"))).toEqual([]);
  });

  it("notContains multi-select excludes movies watched by any listed user", async () => {
    expect(await movieTitles(group("notContains", "alice|bob"))).toEqual(["Never Watched"]);
  });

  it("isNotNull matches movies with any play history", async () => {
    expect(await movieTitles(group("isNotNull", "")))
      .toEqual(["Watched by Alice", "Watched by Bob", "Watched by Both"]);
  });

  it("isNull matches movies never played", async () => {
    expect(await movieTitles(group("isNull", ""))).toEqual(["Never Watched"]);
  });

  it("negate flips equals correctly (matches notEquals semantics)", async () => {
    const negated = await movieTitles(group("equals", "alice", true));
    const notEq = await movieTitles(group("notEquals", "alice"));
    expect(negated).toEqual(notEq);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — series scope aggregates episode history into watchedByUsers
// ---------------------------------------------------------------------------

describe("evaluateSeriesScope — watchedByUser aggregates across episodes", () => {
  it("equals 'alice' matches Show A (one episode watched by alice), not Show B", async () => {
    const series = await evaluateSeriesScope(group("equals", "alice"), [serverId]);
    expect(series.map((s) => s.title).sort()).toEqual(["Show A"]);
  });

  it("equals 'bob' matches Show A (different episode watched by bob)", async () => {
    const series = await evaluateSeriesScope(group("equals", "bob"), [serverId]);
    expect(series.map((s) => s.title).sort()).toEqual(["Show A"]);
  });

  it("contains 'alice|bob' matches Show A (either user counts as a play)", async () => {
    const series = await evaluateSeriesScope(group("contains", "alice|bob"), [serverId]);
    expect(series.map((s) => s.title).sort()).toEqual(["Show A"]);
  });

  it("notContains 'alice|bob' matches only Show B", async () => {
    const series = await evaluateSeriesScope(group("notContains", "alice|bob"), [serverId]);
    expect(series.map((s) => s.title).sort()).toEqual(["Show B"]);
  });

  it("isNull matches only series whose episodes nobody watched", async () => {
    const series = await evaluateSeriesScope(group("isNull", ""), [serverId]);
    expect(series.map((s) => s.title).sort()).toEqual(["Show B"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — music scope aggregates track history into watchedByUsers
// ---------------------------------------------------------------------------

describe("evaluateMusicScope — watchedByUser aggregates across tracks", () => {
  it("equals 'alice' matches Artist 1 (one track played by alice), not Artist 2", async () => {
    const artists = await evaluateMusicScope(group("equals", "alice"), [serverId]);
    expect(artists.map((a) => a.title).sort()).toEqual(["Artist 1"]);
  });

  it("isNull matches only artists with zero plays across all tracks", async () => {
    const artists = await evaluateMusicScope(group("isNull", ""), [serverId]);
    expect(artists.map((a) => a.title).sort()).toEqual(["Artist 2"]);
  });
});
