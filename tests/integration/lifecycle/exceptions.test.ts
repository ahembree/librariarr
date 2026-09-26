import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRemoveItemFromCollections = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/lifecycle/collections", () => ({
  removeItemFromCollections: mockRemoveItemFromCollections,
}));

// Route imports — MUST come AFTER vi.mock() calls
import { GET, POST } from "@/app/api/lifecycle/exceptions/route";
import { DELETE } from "@/app/api/lifecycle/exceptions/[id]/route";

const prisma = getTestPrisma();

/** Helper to set up a user with a server, library, and media item */
async function createUserWithMediaItem(type: "MOVIE" | "SERIES" | "MUSIC" = "MOVIE") {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type });
  const mediaItem = await createTestMediaItem(library.id, { type });
  return { user, server, library, mediaItem };
}

describe("Lifecycle Exceptions API", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ── GET /api/lifecycle/exceptions ──

  describe("GET /api/lifecycle/exceptions", () => {
    it("returns 401 when not authenticated", async () => {
      const response = await callRoute(GET);
      await expectJson(response, 401);
    });

    it("returns empty array when user has no exceptions", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(GET);
      const body = await expectJson<{ exceptions: unknown[] }>(response, 200);
      expect(body.exceptions).toEqual([]);
    });

    it("returns exceptions belonging to authenticated user", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await prisma.lifecycleException.create({
        data: { userId: user.id, mediaItemId: mediaItem.id, reason: "Keep forever" },
      });

      const response = await callRoute(GET);
      const body = await expectJson<{ exceptions: Array<{ id: string; reason: string | null; mediaItem: { id: string } }> }>(response, 200);
      expect(body.exceptions).toHaveLength(1);
      expect(body.exceptions[0].reason).toBe("Keep forever");
      expect(body.exceptions[0].mediaItem.id).toBe(mediaItem.id);
    });

    it("does not return exceptions belonging to another user", async () => {
      const { user: user1 } = await createUserWithMediaItem();
      const { user: user2, mediaItem: item2 } = await createUserWithMediaItem();

      await prisma.lifecycleException.create({
        data: { userId: user2.id, mediaItemId: item2.id },
      });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRoute(GET);
      const body = await expectJson<{ exceptions: unknown[] }>(response, 200);
      expect(body.exceptions).toHaveLength(0);
    });

    it("filters by media item type when type param is provided", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const movieLib = await createTestLibrary(server.id, { type: "MOVIE" });
      const seriesLib = await createTestLibrary(server.id, { type: "SERIES", key: "2" });
      const movie = await createTestMediaItem(movieLib.id, { type: "MOVIE" });
      const series = await createTestMediaItem(seriesLib.id, { type: "SERIES", title: "Test Series" });

      await prisma.lifecycleException.createMany({
        data: [
          { userId: user.id, mediaItemId: movie.id },
          { userId: user.id, mediaItemId: series.id },
        ],
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Filter for MOVIE
      const movieResponse = await callRoute(GET, { url: "/api/lifecycle/exceptions?type=MOVIE" });
      const movieBody = await expectJson<{ exceptions: Array<{ mediaItem: { type: string } }> }>(movieResponse, 200);
      expect(movieBody.exceptions).toHaveLength(1);
      expect(movieBody.exceptions[0].mediaItem.type).toBe("MOVIE");

      // Filter for SERIES
      const seriesResponse = await callRoute(GET, { url: "/api/lifecycle/exceptions?type=SERIES" });
      const seriesBody = await expectJson<{ exceptions: Array<{ mediaItem: { type: string } }> }>(seriesResponse, 200);
      expect(seriesBody.exceptions).toHaveLength(1);
      expect(seriesBody.exceptions[0].mediaItem.type).toBe("SERIES");

      // ALL returns both
      const allResponse = await callRoute(GET, { url: "/api/lifecycle/exceptions?type=ALL" });
      const allBody = await expectJson<{ exceptions: unknown[] }>(allResponse, 200);
      expect(allBody.exceptions).toHaveLength(2);
    });
  });

  // ── POST /api/lifecycle/exceptions ──

  describe("POST /api/lifecycle/exceptions", () => {
    it("returns 401 when not authenticated", async () => {
      const response = await callRoute(POST, { method: "POST", body: { mediaItemId: "test" } });
      await expectJson(response, 401);
    });

    it("returns 400 with invalid body", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, { method: "POST", body: {} });
      await expectJson(response, 400);
    });

    it("returns 404 when media item does not belong to user", async () => {
      const { user: user1 } = await createUserWithMediaItem();
      const { mediaItem: item2 } = await createUserWithMediaItem();

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRoute(POST, { method: "POST", body: { mediaItemId: item2.id } });
      await expectJson(response, 404);
    });

    it("creates exception with valid data", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(POST, {
        method: "POST",
        body: { mediaItemId: mediaItem.id, reason: "User favorite" },
      });
      const body = await expectJson<{ exception: { id: string; reason: string } }>(response, 201);
      expect(body.exception.id).toBeDefined();
      expect(body.exception.reason).toBe("User favorite");

      // Verify in DB
      const dbException = await prisma.lifecycleException.findUnique({
        where: { userId_mediaItemId: { userId: user.id, mediaItemId: mediaItem.id } },
      });
      expect(dbException).not.toBeNull();
    });

    it("upserts on duplicate (updates reason)", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // First create
      await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id, reason: "Original" } });

      // Upsert with new reason
      const response = await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id, reason: "Updated" } });
      const body = await expectJson<{ exception: { reason: string } }>(response, 201);
      expect(body.exception.reason).toBe("Updated");

      // Only one exception should exist
      const count = await prisma.lifecycleException.count({
        where: { userId: user.id, mediaItemId: mediaItem.id },
      });
      expect(count).toBe(1);
    });

    it("removes RuleMatch records on create", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE" });
      await createTestRuleMatch(ruleSet.id, mediaItem.id);

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id } });

      const matches = await prisma.ruleMatch.findMany({
        where: { mediaItemId: mediaItem.id },
      });
      expect(matches).toHaveLength(0);
    });

    it("deletes PENDING LifecycleAction records on create", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE" });

      await prisma.lifecycleAction.create({
        data: {
          userId: user.id,
          mediaItemId: mediaItem.id,
          ruleSetId: ruleSet.id,
          actionType: "DELETE",
          status: "PENDING",
          scheduledFor: new Date(Date.now() + 86400000),
        },
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id } });

      const action = await prisma.lifecycleAction.findFirst({
        where: { mediaItemId: mediaItem.id, userId: user.id },
      });
      expect(action).toBeNull();
    });

    it("clears the match and pending action held by another server's copy of the item", async () => {
      // A multi-server title is matched once, on the copy detection kept.
      // Excluding it from the OTHER copy's page must disarm that match too —
      // the action acts on the one Arr record both copies are backed by.
      const { user, mediaItem } = await createUserWithMediaItem();
      const server2 = await createTestServer(user.id);
      const library2 = await createTestLibrary(server2.id, { type: "MOVIE" });
      const kept = await createTestMediaItem(library2.id, { type: "MOVIE" });
      const unrelated = await createTestMediaItem(library2.id, { type: "MOVIE" });
      await prisma.mediaItem.updateMany({
        where: { id: { in: [mediaItem.id, kept.id] } },
        data: { dedupKey: "movie:tmdb:603" },
      });
      await prisma.mediaItem.update({ where: { id: unrelated.id }, data: { dedupKey: "movie:tmdb:604" } });

      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE" });
      await createTestRuleMatch(ruleSet.id, kept.id, { copies: [{ id: mediaItem.id }] });
      await createTestRuleMatch(ruleSet.id, unrelated.id);
      for (const id of [kept.id, unrelated.id]) {
        await prisma.lifecycleAction.create({
          data: {
            userId: user.id,
            mediaItemId: id,
            ruleSetId: ruleSet.id,
            actionType: "DELETE_RADARR",
            status: "PENDING",
            scheduledFor: new Date(Date.now() + 86400000),
          },
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id } });

      const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
      expect(matches.map((m) => m.mediaItemId)).toEqual([unrelated.id]);
      const pending = await prisma.lifecycleAction.findMany({ where: { userId: user.id, status: "PENDING" } });
      expect(pending.map((a) => a.mediaItemId)).toEqual([unrelated.id]);
    });

    it("leaves matches that only list the excluded episode as another server's copy", async () => {
      // A per-episode rule set's group on server A lists server B's episode as
      // its copy. Detection keeps that group (it only drops the excepted
      // members), so deleting it here would just restart its countdown — in
      // this rule set and in every other rule set sharing the representative.
      const user = await createTestUser();
      const s1 = await createTestServer(user.id);
      const s2 = await createTestServer(user.id);
      const l1 = await createTestLibrary(s1.id, { type: "SERIES" });
      const l2 = await createTestLibrary(s2.id, { type: "SERIES" });
      const a1 = await createTestMediaItem(l1.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1 });
      const b7 = await createTestMediaItem(l2.id, { type: "SERIES", parentTitle: "Show", seasonNumber: 1, episodeNumber: 7 });
      await prisma.mediaItem.update({ where: { id: a1.id }, data: { seriesKey: "tvdb:1", dedupKey: "ep:1:1:1" } });
      await prisma.mediaItem.update({ where: { id: b7.id }, data: { seriesKey: "tvdb:1", dedupKey: "ep:1:1:7" } });
      const r1 = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: false });
      const r2 = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: false });
      await createTestRuleMatch(r1.id, a1.id, { copies: [{ id: b7.id }] });
      await createTestRuleMatch(r2.id, a1.id);
      const action = await prisma.lifecycleAction.create({
        data: {
          userId: user.id,
          mediaItemId: a1.id,
          ruleSetId: r2.id,
          actionType: "UNMONITOR_SONARR",
          status: "PENDING",
          scheduledFor: new Date(Date.now() + 86400000),
        },
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: b7.id } });

      expect(await prisma.ruleMatch.count({ where: { ruleSetId: { in: [r1.id, r2.id] } } })).toBe(2);
      expect(await prisma.lifecycleAction.findUnique({ where: { id: action.id } })).not.toBeNull();
    });

    it("disarms a series-scope match of the show on another server, and only that rule set's", async () => {
      const user = await createTestUser();
      const s1 = await createTestServer(user.id);
      const s2 = await createTestServer(user.id);
      const l1 = await createTestLibrary(s1.id, { type: "SERIES" });
      const l2 = await createTestLibrary(s2.id, { type: "SERIES" });
      const a1 = await createTestMediaItem(l1.id, { type: "SERIES", parentTitle: "The Office", seasonNumber: 1, episodeNumber: 1 });
      const b7 = await createTestMediaItem(l2.id, { type: "SERIES", parentTitle: "The Office (US)", seasonNumber: 1, episodeNumber: 7 });
      // A different show that happens to share server B's title.
      const other = await createTestMediaItem(l1.id, { type: "SERIES", parentTitle: "The Office (US)", seasonNumber: 1, episodeNumber: 1 });
      await prisma.mediaItem.update({ where: { id: a1.id }, data: { seriesKey: "tvdb:73244", dedupKey: "ep:73244:1:1" } });
      await prisma.mediaItem.update({ where: { id: b7.id }, data: { seriesKey: "tvdb:73244", dedupKey: "ep:73244:1:7" } });
      await prisma.mediaItem.update({ where: { id: other.id }, data: { seriesKey: "tvdb:999", dedupKey: "ep:999:1:1" } });
      const grouped = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: true });
      const perEpisode = await createTestRuleSet(user.id, { type: "SERIES", seriesScope: false });
      await createTestRuleMatch(grouped.id, a1.id);
      await createTestRuleMatch(grouped.id, other.id);
      await createTestRuleMatch(perEpisode.id, a1.id);
      for (const [ruleSetId, mediaItemId] of [[grouped.id, a1.id], [perEpisode.id, a1.id]]) {
        await prisma.lifecycleAction.create({
          data: {
            userId: user.id,
            mediaItemId,
            ruleSetId,
            actionType: "DELETE_SONARR",
            status: "PENDING",
            scheduledFor: new Date(Date.now() + 86400000),
          },
        });
      }

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: b7.id } });

      const left = await prisma.ruleMatch.findMany({ where: { ruleSetId: { in: [grouped.id, perEpisode.id] } } });
      expect(left.map((m) => [m.ruleSetId, m.mediaItemId]).sort()).toEqual(
        [[grouped.id, other.id], [perEpisode.id, a1.id]].sort(),
      );
      const pending = await prisma.lifecycleAction.findMany({ where: { status: "PENDING" } });
      expect(pending.map((a) => a.ruleSetId)).toEqual([perEpisode.id]);
    });

    it("takes the kept copy and every listed copy out of the collection, each in its own library", async () => {
      const { user, library, mediaItem } = await createUserWithMediaItem();
      const server2 = await createTestServer(user.id);
      const library2 = await createTestLibrary(server2.id, { type: "MOVIE" });
      const kept = await createTestMediaItem(library2.id, { type: "MOVIE" });
      await prisma.mediaItem.updateMany({
        where: { id: { in: [mediaItem.id, kept.id] } },
        data: { dedupKey: "movie:tmdb:603" },
      });
      const collection = await prisma.collection.create({
        data: { userId: user.id, name: "Leaving Soon", type: "MOVIE" },
      });
      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE" });
      await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { collectionId: collection.id } });
      await createTestRuleMatch(ruleSet.id, kept.id, {
        copies: [{ id: mediaItem.id, libraryId: library.id, ratingKey: mediaItem.ratingKey, title: mediaItem.title }],
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id } });

      const calls = mockRemoveItemFromCollections.mock.calls.map((c) => [c[3], c[5]]);
      expect(calls).toEqual(
        expect.arrayContaining([
          [kept.ratingKey, library2.id],
          [mediaItem.ratingKey, library.id],
        ]),
      );
      expect(calls).toHaveLength(2);
      expect(mockRemoveItemFromCollections.mock.calls[0].slice(0, 3)).toEqual([user.id, "MOVIE", "Leaving Soon"]);
    });

    it("a series-scope exception disarms another server's copy of the show", async () => {
      const user = await createTestUser();
      const s1 = await createTestServer(user.id);
      const s2 = await createTestServer(user.id);
      const l1 = await createTestLibrary(s1.id, { type: "SERIES" });
      const l2 = await createTestLibrary(s2.id, { type: "SERIES" });
      const ep = await createTestMediaItem(l1.id, {
        type: "SERIES", parentTitle: "The Office (US)", seasonNumber: 1, episodeNumber: 1,
      });
      const otherEp = await createTestMediaItem(l2.id, {
        type: "SERIES", parentTitle: "The Office", seasonNumber: 1, episodeNumber: 1,
      });
      await prisma.mediaItem.update({ where: { id: ep.id }, data: { seriesKey: "tvdb:73244", dedupKey: "ep:73244:1:1" } });
      await prisma.mediaItem.update({ where: { id: otherEp.id }, data: { seriesKey: "tvdb:73244", dedupKey: "ep:73244:1:1b" } });
      const ruleSet = await createTestRuleSet(user.id, { type: "SERIES" });
      await createTestRuleMatch(ruleSet.id, otherEp.id);
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id,
          mediaItemId: otherEp.id,
          ruleSetId: ruleSet.id,
          actionType: "DELETE_SONARR",
          status: "PENDING",
          scheduledFor: new Date(Date.now() + 86400000),
        },
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      const res = await callRoute(POST, { method: "POST", body: { mediaItemId: ep.id, scope: "series" } });
      const body = await expectJson<{ count: number }>(res, 201);

      // Both servers' episodes are excepted — the other one through seriesKey.
      expect(body.count).toBe(2);
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
      expect(await prisma.lifecycleAction.count({ where: { status: "PENDING" } })).toBe(0);
    });

    it("does not delete COMPLETED LifecycleAction records", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE" });

      await prisma.lifecycleAction.create({
        data: {
          userId: user.id,
          mediaItemId: mediaItem.id,
          ruleSetId: ruleSet.id,
          actionType: "DELETE",
          status: "COMPLETED",
          scheduledFor: new Date(),
          executedAt: new Date(),
        },
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await callRoute(POST, { method: "POST", body: { mediaItemId: mediaItem.id } });

      const action = await prisma.lifecycleAction.findFirst({
        where: { mediaItemId: mediaItem.id, userId: user.id },
      });
      expect(action?.status).toBe("COMPLETED");
    });
  });

  // ── DELETE /api/lifecycle/exceptions/[id] ──

  describe("DELETE /api/lifecycle/exceptions/[id]", () => {
    it("returns 401 when not authenticated", async () => {
      const response = await callRouteWithParams(DELETE, { id: "test" });
      await expectJson(response, 401);
    });

    it("returns 404 when exception does not exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(DELETE, { id: "nonexistent" });
      await expectJson(response, 404);
    });

    it("returns 404 when exception belongs to another user", async () => {
      const { user: user1 } = await createUserWithMediaItem();
      const { user: user2, mediaItem: item2 } = await createUserWithMediaItem();

      const exception = await prisma.lifecycleException.create({
        data: { userId: user2.id, mediaItemId: item2.id },
      });

      setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRouteWithParams(DELETE, { id: exception.id });
      await expectJson(response, 404);
    });

    it("deletes exception with valid ownership", async () => {
      const { user, mediaItem } = await createUserWithMediaItem();
      const exception = await prisma.lifecycleException.create({
        data: { userId: user.id, mediaItemId: mediaItem.id, reason: "test" },
      });

      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      const response = await callRouteWithParams(DELETE, { id: exception.id });
      const body = await expectJson<{ success: boolean }>(response, 200);
      expect(body.success).toBe(true);

      // Verify deleted from DB
      const dbException = await prisma.lifecycleException.findUnique({
        where: { id: exception.id },
      });
      expect(dbException).toBeNull();
    });
  });
});
