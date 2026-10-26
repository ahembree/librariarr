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
  createTestCollection,
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
const mockRemoveItemsFromCollections = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/lifecycle/collections", () => ({
  removeItemsFromCollections: mockRemoveItemsFromCollections,
}));

/** Every removal the route asked for, as `[userId, ...entry]` like the old one-at-a-time calls. */
function removalCalls(): unknown[][] {
  return (mockRemoveItemsFromCollections.mock.calls as Array<[
    string,
    Array<{ type: string; collectionName: string; itemRatingKey: string; seriesTitle: string | null; libraryId?: string }>,
  ]>).flatMap(([userId, removals]) =>
    removals.map((r) => [userId, r.type, r.collectionName, r.itemRatingKey, r.seriesTitle, r.libraryId]),
  );
}

import { POST, DELETE as BULK_DELETE, PATCH as BULK_PATCH } from "@/app/api/lifecycle/exceptions/route";

const prisma = getTestPrisma();

async function musicSetup() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const lib = await createTestLibrary(server.id, { type: "MUSIC" });
  const track = (title: string, parentTitle: string | null, albumTitle?: string) =>
    createTestMediaItem(lib.id, { type: "MUSIC", title, parentTitle, ...(albumTitle ? { albumTitle } : {}) });
  return { user, server, lib, track };
}

const post = (body: unknown) => callRoute(POST, { url: "/api/lifecycle/exceptions", method: "POST", body });

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("POST /api/lifecycle/exceptions — bulk scopes", () => {
  it("refuses a series scope on an item with no series title", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: null });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ error: string }>(await post({ mediaItemId: ep.id, scope: "series" }), 400);
    expect(body.error).toBe("Media item has no series title");
    expect(await prisma.lifecycleException.count()).toBe(0);
  });

  it("refuses artist and album scopes on a track missing the artist or album", async () => {
    const { user, track } = await musicSetup();
    const orphan = await track("Untitled", null);
    const noAlbum = await track("Song", "Artist");
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect((await expectJson<{ error: string }>(await post({ mediaItemId: orphan.id, scope: "artist" }), 400)).error)
      .toBe("Media item has no artist");
    expect((await expectJson<{ error: string }>(await post({ mediaItemId: noAlbum.id, scope: "album" }), 400)).error)
      .toBe("Media item has no album or artist");
    expect(await prisma.lifecycleException.count()).toBe(0);
  });

  it("artist scope excepts every track of the artist and nobody else's", async () => {
    const { user, track } = await musicSetup();
    const a1 = await track("One", "Radiohead", "OK Computer");
    const a2 = await track("Two", "Radiohead", "Kid A");
    const other = await track("Yellow", "Coldplay", "Parachutes");
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await post({ mediaItemId: a1.id, scope: "artist", reason: "favourite" });
    expect(await expectJson(res, 201)).toEqual({ count: 2, scope: "artist" });

    const rows = await prisma.lifecycleException.findMany({ select: { mediaItemId: true, reason: true } });
    expect(rows.map((r) => r.mediaItemId).sort()).toEqual([a1.id, a2.id].sort());
    expect(rows.every((r) => r.reason === "favourite")).toBe(true);
    expect(rows.some((r) => r.mediaItemId === other.id)).toBe(false);
  });

  it("album scope excepts only that album's tracks", async () => {
    const { user, track } = await musicSetup();
    const a1 = await track("One", "Radiohead", "OK Computer");
    const a2 = await track("Two", "Radiohead", "OK Computer");
    const otherAlbum = await track("Three", "Radiohead", "Kid A");
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect(await expectJson(await post({ mediaItemId: a2.id, scope: "album" }), 201)).toEqual({ count: 2, scope: "album" });

    const ids = (await prisma.lifecycleException.findMany({ select: { mediaItemId: true } })).map((r) => r.mediaItemId);
    expect(ids.sort()).toEqual([a1.id, a2.id].sort());
    expect(ids).not.toContain(otherAlbum.id);
  });

  it("artist scope disarms the artist-scope match and takes it out of its collection", async () => {
    const { user, lib, track } = await musicSetup();
    const rep = await track("One", "Radiohead", "OK Computer");
    await track("Two", "Radiohead", "Kid A");
    const collection = await createTestCollection(user.id, { name: "Leaving", type: "MUSIC" });
    const ruleSet = await createTestRuleSet(user.id, { type: "MUSIC", seriesScope: true, collectionId: collection.id });
    await createTestRuleMatch(ruleSet.id, rep.id, {
      title: "Radiohead",
      copies: [{ id: "elsewhere", libraryId: "lib-other", ratingKey: "rk-other", title: "Radiohead" }, { id: "bad" }],
    });
    await prisma.lifecycleAction.create({
      data: { userId: user.id, mediaItemId: rep.id, ruleSetId: ruleSet.id, actionType: "DELETE_LIDARR", status: "PENDING", scheduledFor: new Date() },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect(await expectJson(await post({ mediaItemId: rep.id, scope: "artist" }), 201)).toEqual({ count: 2, scope: "artist" });

    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { status: "PENDING" } })).toBe(0);
    // The kept copy in its own library, and the listed copy in ITS library; the
    // malformed copy entry is skipped. Music is never removed by series title.
    expect(mockRemoveItemsFromCollections).toHaveBeenCalledTimes(1);
    expect(removalCalls()).toEqual(
      expect.arrayContaining([
        [user.id, "MUSIC", "Leaving", rep.ratingKey, null, lib.id],
        [user.id, "MUSIC", "Leaving", "rk-other", null, "lib-other"],
      ]),
    );
    expect(removalCalls()).toHaveLength(2);
  });

  it("does not fail the exclusion when collection removal throws", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 1 });
    const collection = await createTestCollection(user.id, { name: "Leaving", type: "SERIES" });
    const ruleSet = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: true, collectionId: collection.id });
    await createTestRuleMatch(ruleSet.id, ep.id, { title: "Lost" });
    mockRemoveItemsFromCollections.mockRejectedValueOnce(new Error("plex down"));
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect(await expectJson(await post({ mediaItemId: ep.id, scope: "series" }), 201)).toEqual({ count: 1, scope: "series" });

    // Series scope resolves the show by its title.
    expect(removalCalls()).toEqual([[user.id, "SERIES", "Leaving", ep.ratingKey, "Lost", lib.id]]);
    expect(await prisma.lifecycleException.count()).toBe(1);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
  });
});

describe("bulk DELETE / PATCH", () => {
  it("require a session", async () => {
    expect((await callRoute(BULK_DELETE, { url: "/api/lifecycle/exceptions", method: "DELETE", body: { ids: ["x"] } })).status).toBe(401);
    expect((await callRoute(BULK_PATCH, { url: "/api/lifecycle/exceptions", method: "PATCH", body: { ids: ["x"] } })).status).toBe(401);
  });

  it("validate the body", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const del = await expectJson<{ error: string }>(
      await callRoute(BULK_DELETE, { url: "/api/lifecycle/exceptions", method: "DELETE", body: { ids: [] } }),
      400,
    );
    expect(del.error).toBe("Validation failed");
    const patch = await expectJson<{ error: string }>(
      await callRoute(BULK_PATCH, { url: "/api/lifecycle/exceptions", method: "PATCH", body: { nope: true } }),
      400,
    );
    expect(patch.error).toBe("Validation failed");
  });

  it("clears the reason when PATCH sends none", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id);
    const m = await createTestMediaItem(lib.id);
    const ex = await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: m.id, reason: "old" } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ updated: number }>(
      await callRoute(BULK_PATCH, { url: "/api/lifecycle/exceptions", method: "PATCH", body: { ids: [ex.id] } }),
      200,
    );
    expect(body.updated).toBe(1);
    expect((await prisma.lifecycleException.findUniqueOrThrow({ where: { id: ex.id } })).reason).toBeNull();
  });
});
