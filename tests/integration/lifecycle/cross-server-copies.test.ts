/**
 * A title held on two servers is ONE record in the Arr app. Detection
 * collapses the copies onto one match (so one action, one deletion count) —
 * these tests pin down what must still hold for the copy it did not keep.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
  createTestExternalId,
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

vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
  buildSuccessSummaryEmbed: vi.fn(),
  buildFailureSummaryEmbed: vi.fn(),
  buildMatchChangeEmbed: vi.fn(),
  buildMaintenanceEmbed: vi.fn(),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));

import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";
import { findExceptedItemIds } from "@/lib/lifecycle/exception-guard";
import { arrExternalIdsOf } from "@/lib/lifecycle/cross-server-copies";

const prisma = getTestPrisma();

const UNWATCHED = [
  {
    id: "g1",
    condition: "AND",
    rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    groups: [],
  },
];

/** The same movie (TMDB 603) on two servers, plus an unrelated one. */
async function twoServerMovie() {
  const user = await createTestUser();
  const s1 = await createTestServer(user.id);
  const s2 = await createTestServer(user.id);
  const l1 = await createTestLibrary(s1.id, { type: "MOVIE" });
  const l2 = await createTestLibrary(s2.id, { type: "MOVIE" });
  const a = await createTestMediaItem(l1.id, { title: "The Matrix", type: "MOVIE", playCount: 0 });
  const b = await createTestMediaItem(l2.id, { title: "The Matrix", type: "MOVIE", playCount: 0 });
  for (const item of [a, b]) {
    await createTestExternalId(item.id, "TMDB", "603");
    await prisma.mediaItem.update({ where: { id: item.id }, data: { dedupKey: "movie:tmdb:603" } });
  }
  const ruleSet = await createTestRuleSet(user.id, {
    name: "Unwatched",
    type: "MOVIE",
    rules: UNWATCHED,
    serverIds: [s1.id, s2.id],
    actionEnabled: true,
    actionType: "DO_NOTHING",
    actionDelayDays: 0,
  });
  return { user, s1, s2, l1, l2, a, b, ruleSet };
}

// File-level: the client is shared by every describe below, so it is closed
// once they have all run rather than after the first one.
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("cross-server copies of one title", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  it("matches the title once, recording the other copy", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();

    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches).toHaveLength(1);
    const kept = [a.id, b.id].sort()[0];
    const other = kept === a.id ? b : a;
    expect(matches[0].mediaItemId).toBe(kept);
    const copies = (matches[0].itemData as { copies?: Array<{ id: string; libraryId: string; ratingKey: string }> }).copies;
    expect(copies).toEqual([
      expect.objectContaining({ id: other.id, libraryId: other.libraryId, ratingKey: other.ratingKey }),
    ]);
    expect(matches[0].copyIds).toEqual([other.id]);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(1);

    // "Matched By Rule Set" holds for the copy that was not kept, too.
    const cross = await fetchCrossSystemData([a.id, b.id]);
    expect(cross.get(a.id)?.matchedRuleSets).toEqual(["Unwatched"]);
    expect(cross.get(b.id)?.matchedRuleSets).toEqual(["Unwatched"]);
  });

  it("carries the match and its pending action over when the kept copy stops matching", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const kept = match.mediaItemId === a.id ? a : b;
    const other = kept === a ? b : a;
    const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(action.mediaItemId).toBe(kept.id);

    // Played on its own server: the kept copy no longer matches, the other does.
    await prisma.mediaItem.update({ where: { id: kept.id }, data: { playCount: 1 } });
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([other.id]);
    expect(matches[0].copyIds).toEqual([]);
    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    // The same action, moved — not cancelled and rescheduled.
    expect(pending.map((p) => [p.id, p.mediaItemId])).toEqual([[action.id, other.id]]);
    expect(pending[0].scheduledFor.getTime()).toBe(action.scheduledFor.getTime());
  });

  it("carries over on a sticky rule set without arming a second action", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { stickyMatches: true } });
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const kept = match.mediaItemId === a.id ? a : b;
    const other = kept === a ? b : a;

    await prisma.mediaItem.update({ where: { id: kept.id }, data: { playCount: 1 } });
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([other.id]);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(1);
  });

  it("carries the match over when the rule set is narrowed to the other copy's server", async () => {
    const { user, a, b, s1, s2, ruleSet } = await twoServerMovie();
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const kept = match.mediaItemId === a.id ? a : b;
    const other = kept === a ? b : a;
    const [action] = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });

    const otherServer = other.libraryId === (await prisma.library.findFirst({ where: { mediaServerId: s1.id } }))!.id ? s1 : s2;
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { serverIds: [otherServer.id] } });
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([other.id]);
    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(pending.map((p) => [p.id, p.mediaItemId])).toEqual([[action.id, other.id]]);
  });

  it("an exception on the copy detection did not keep disarms the title", async () => {
    const { user, a, b, ruleSet } = await twoServerMovie();
    await processLifecycleRules(user.id);
    const [match] = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const other = match.mediaItemId === a.id ? b : a;

    // Filed directly (as a bulk scope or an older app version would), so the
    // executor's own check is what stands in the way.
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: other.id } });

    await executeLifecycleActions(user.id);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);

    // …and detection no longer matches either copy.
    await processLifecycleRules(user.id);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
  });

  it("findExceptedItemIds protects every copy of an excepted item, and nothing else", async () => {
    const { user, a, b, l2 } = await twoServerMovie();
    const unrelated = await createTestMediaItem(l2.id, { title: "Other", type: "MOVIE" });
    await prisma.mediaItem.update({ where: { id: unrelated.id }, data: { dedupKey: "movie:tmdb:604" } });
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: a.id } });

    const excepted = await findExceptedItemIds(user.id, [a.id, b.id, unrelated.id]);

    expect([...excepted].sort()).toEqual([a.id, b.id].sort());
  });

  it("reads 'Matched By Rule Set' through malformed copies without failing", async () => {
    const { user, a, b } = await twoServerMovie();
    const ruleSet = await createTestRuleSet(user.id, { name: "Odd", type: "MOVIE" });
    await createTestRuleMatch(ruleSet.id, a.id, { copies: { id: b.id } });

    const cross = await fetchCrossSystemData([a.id, b.id]);

    expect(cross.get(a.id)?.matchedRuleSets).toEqual(["Odd"]);
    expect(cross.get(b.id)?.matchedRuleSets).toEqual([]);
  });
});

// A track's Arr-family id is its ARTIST's MusicBrainz id, shared by every track
// of the artist. Keyed on it alone, distinct tracks of one artist on two
// servers collapsed into one match — a file delete acted on one track per
// cycle — while on one server an artist-level action was scheduled once per
// track, the first succeeding and the rest failing "not found".
describe("track-scope music", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  /** Three tracks of one artist on server A (the first also on server B). */
  async function artistTracks(opts: { servers: 1 | 2; actionType: string }) {
    const user = await createTestUser();
    const s1 = await createTestServer(user.id);
    const s2 = await createTestServer(user.id);
    const l1 = await createTestLibrary(s1.id, { type: "MUSIC" });
    const l2 = await createTestLibrary(s2.id, { type: "MUSIC" });
    const track = async (libraryId: string, n: number) => {
      const t = await createTestMediaItem(libraryId, {
        type: "MUSIC", title: `Song ${n}`, parentTitle: "The Artist", albumTitle: "Album", episodeNumber: n, playCount: 0,
      });
      await createTestExternalId(t.id, "MUSICBRAINZ", "a74b1b7f-71a5-4011-9441-d0b5e4122711");
      await prisma.mediaItem.update({ where: { id: t.id }, data: { dedupKey: `music:the artist:song ${n}` } });
      return t;
    };
    const tracks = [await track(l1.id, 1), await track(l1.id, 2), await track(l1.id, 3)];
    const copy = opts.servers === 2 ? await track(l2.id, 1) : null;
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Unplayed tracks", type: "MUSIC", seriesScope: false, rules: UNWATCHED,
      serverIds: opts.servers === 2 ? [s1.id, s2.id] : [s1.id],
      actionEnabled: true, actionType: opts.actionType, arrInstanceId: "lidarr-1",
    });
    return { user, tracks, copy, ruleSet };
  }

  it("keeps one match per track for a track file delete, folding only another server's copy of the same track", async () => {
    const { user, tracks, copy, ruleSet } = await artistTracks({ servers: 2, actionType: "DELETE_FILES_LIDARR" });

    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId).sort()).toEqual(tracks.map((t) => t.id).sort());
    expect(matches.find((m) => m.mediaItemId === tracks[0].id)?.copyIds).toEqual([copy!.id]);
    const actions = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(actions.map((a) => a.mediaItemId).sort()).toEqual(tracks.map((t) => t.id).sort());
  });

  it("folds the per-track matches an older version stored onto the lowest-id track, keeping its countdown", async () => {
    const { user, tracks, ruleSet } = await artistTracks({ servers: 1, actionType: "DELETE_LIDARR" });
    // Before the fold, every track had its own match and PENDING action.
    const scheduledFor = new Date(Date.now() + 10 * 86_400_000);
    const before = new Map<string, string>();
    for (const t of tracks) {
      await createTestRuleMatch(ruleSet.id, t.id, { id: t.id, title: t.title, parentTitle: "The Artist" });
      const action = await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: t.id, ruleSetId: ruleSet.id, actionType: "DELETE_LIDARR", status: "PENDING",
          scheduledFor, arrInstanceId: "lidarr-1", mediaItemTitle: t.title, mediaItemParentTitle: "The Artist",
        },
      });
      before.set(t.id, action.id);
    }

    await processLifecycleRules(user.id);

    const kept = tracks.map((t) => t.id).sort()[0];
    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches.map((m) => m.mediaItemId)).toEqual([kept]);
    const actions = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(actions.map((a) => a.id)).toEqual([before.get(kept)]);
    expect(actions[0].scheduledFor.getTime()).toBe(scheduledFor.getTime());
  });

  it("schedules an artist-level action once per artist, on a single server too", async () => {
    const { user, tracks, ruleSet } = await artistTracks({ servers: 1, actionType: "DELETE_LIDARR" });

    await processLifecycleRules(user.id);

    const actions = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    expect(actions).toHaveLength(1);
    expect([...actions[0].matchedMediaItemIds].sort()).toEqual(tracks.map((t) => t.id).sort());
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(1);
  });
});

describe("arrExternalIdsOf", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reads the Arr family's id from the item, and loads it for items the engine returned without ids", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const bare = await createTestMediaItem(library.id, { title: "Dune", type: "MOVIE" });
    await createTestExternalId(bare.id, "TMDB", "438631");
    await createTestExternalId(bare.id, "IMDB", "tt1160419");
    const none = await createTestMediaItem(library.id, { title: "No Id", type: "MOVIE" });

    const ids = await arrExternalIdsOf("MOVIE", [
      // Carried ids win over the row, and only the Arr family's source counts.
      { id: "carried", externalIds: [{ source: "IMDB", externalId: "tt0133093" }, { source: "TMDB", externalId: "603" }] },
      { id: "carried-empty", externalIds: [] },
      { id: bare.id },
      { id: none.id },
    ]);

    expect(Object.fromEntries(ids)).toEqual({ carried: "603", [bare.id]: "438631" });
    expect(Object.fromEntries(await arrExternalIdsOf("MOVIE", [{ id: bare.id }], { loadMissing: false }))).toEqual({});
  });
});
