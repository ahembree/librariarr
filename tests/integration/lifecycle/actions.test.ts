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
  createTestExternalId,
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

// Mock Arr clients (used by execute route when evaluating rules to find items)
vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return {
      getMovies: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
      getCustomFormatScores: vi.fn().mockResolvedValue(new Map()),
    };
  }),
}));

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      getSeries: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      getArtists: vi.fn().mockResolvedValue([]),
      getQualityProfiles: vi.fn().mockResolvedValue([]),
      getTags: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Mock executeAction to avoid real Arr API calls
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return {
    ...actual,
    executeAction: vi.fn().mockResolvedValue(undefined),
  };
});

// Pass-through spy on the inline action runner so the single-flight tests can
// hold one call open on a deferred promise while a second request arrives.
vi.mock("@/lib/lifecycle/run-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/run-actions")>();
  return {
    ...actual,
    executeActionsForItems: vi.fn(actual.executeActionsForItems),
  };
});

// Import AFTER mocks
import { GET } from "@/app/api/lifecycle/actions/route";
import { DELETE as actionDelete, POST as actionRetry } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as executePost } from "@/app/api/lifecycle/actions/execute/route";

describe("Lifecycle Actions", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ---- Helper: create a lifecycle action in DB ----
  async function createTestAction(
    userId: string,
    mediaItemId: string,
    ruleSetId: string,
    overrides?: Partial<{
      actionType: string;
      status: "PENDING" | "COMPLETED" | "FAILED";
      scheduledFor: Date;
      executedAt: Date;
      error: string;
      arrInstanceId: string;
    }>
  ) {
    const prisma = getTestPrisma();
    return prisma.lifecycleAction.create({
      data: {
        userId,
        mediaItemId,
        ruleSetId,
        actionType: overrides?.actionType ?? "DO_NOTHING",
        status: overrides?.status ?? "PENDING",
        scheduledFor: overrides?.scheduledFor ?? new Date(),
        executedAt: overrides?.executedAt,
        error: overrides?.error,
        arrInstanceId: overrides?.arrInstanceId,
      },
    });
  }

  // ---- GET /api/lifecycle/actions ----

  describe("GET /api/lifecycle/actions", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });
      await expectJson(response, 401);
    });

    it("returns empty groups for user with none", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: unknown[];
      }>(response, 200);
      expect(body.groups).toHaveLength(0);
    });

    it("returns PENDING actions by default grouped by rule set", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      await createTestAction(user.id, item.id, ruleSet.id, { status: "PENDING" });
      await createTestAction(user.id, item.id, ruleSet.id, { status: "COMPLETED" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: { ruleSet: { id: string }; items: { status: string }[]; count: number }[];
      }>(response, 200);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].status).toBe("PENDING");
      expect(body.groups[0].count).toBe(1);
    });

    it("shows an estimated row when the rule's action changed since a completed action of a different type", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      // Rule's action is now "Delete from Radarr"...
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Rule",
        enabled: true,
        actionEnabled: true,
        actionType: "DELETE_RADARR",
      });

      // ...but a "Search for New Copy" action already completed on this item
      // (the rule's action was changed afterward). The old Search must NOT
      // suppress the new Delete.
      await createTestAction(user.id, item.id, ruleSet.id, {
        status: "COMPLETED",
        actionType: "SEARCH_RADARR",
        executedAt: new Date("2020-01-01T00:00:00Z"),
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, { url: "/api/lifecycle/actions" });

      const body = await expectJson<{
        groups: { items: { estimated: boolean; actionType: string; mediaItem: { id: string } }[] }[];
      }>(response, 200);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].estimated).toBe(true);
      expect(body.groups[0].items[0].actionType).toBe("DELETE_RADARR");
      expect(body.groups[0].items[0].mediaItem.id).toBe(item.id);
    });

    it("estimates a show's match at the one-time upgrade hold, and a movie's at its own delay", async () => {
      const DAY = 24 * 60 * 60 * 1000;
      const user = await createTestUser();
      const heldUntil = new Date(Date.now() + 5 * DAY);
      await getTestPrisma().appSettings.create({ data: { userId: user.id, groupedActionsHeldUntil: heldUntil } });
      const server = await createTestServer(user.id);
      const shows = await createTestLibrary(server.id, { type: "SERIES" });
      const films = await createTestLibrary(server.id, { type: "MOVIE" });
      const ep = await createTestMediaItem(shows.id, { title: "Pilot", type: "SERIES", parentTitle: "The Wire" });
      const film = await createTestMediaItem(films.id, { title: "Dune", type: "MOVIE" });
      const seriesRules = await createTestRuleSet(user.id, {
        name: "Shows", type: "SERIES", seriesScope: true, enabled: true,
        actionEnabled: true, actionType: "DELETE_SONARR", actionDelayDays: 1,
      });
      const movieRules = await createTestRuleSet(user.id, {
        name: "Films", enabled: true, actionEnabled: true, actionType: "DELETE_RADARR", actionDelayDays: 1,
      });
      // As detection stores a show: the show as the title, no parent.
      await createTestRuleMatch(seriesRules.id, ep.id, { id: ep.id, title: "The Wire", parentTitle: null, memberIds: [ep.id] });
      await createTestRuleMatch(movieRules.id, film.id);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, { url: "/api/lifecycle/actions" });
      const body = await expectJson<{
        groups: { ruleSet: { id: string }; items: { estimated: boolean; scheduledFor: string }[] }[];
      }>(response, 200);
      const show = body.groups.find((g) => g.ruleSet.id === seriesRules.id)!.items[0];
      expect(show.estimated).toBe(true);
      expect(new Date(show.scheduledFor).getTime()).toBe(heldUntil.getTime());
      const movie = body.groups.find((g) => g.ruleSet.id === movieRules.id)!.items[0];
      expect(new Date(movie.scheduledFor).getTime()).toBeLessThan(heldUntil.getTime() - 3 * DAY);
    });

    it("suppresses the estimated row when a completed action of the SAME type already ran", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Rule",
        enabled: true,
        actionEnabled: true,
        actionType: "UNMONITOR_RADARR",
      });

      // Same non-destructive action already completed — re-scheduling it would
      // loop on a still-matching item, so the estimated row stays suppressed.
      await createTestAction(user.id, item.id, ruleSet.id, {
        status: "COMPLETED",
        actionType: "UNMONITOR_RADARR",
        executedAt: new Date("2020-01-01T00:00:00Z"),
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, { url: "/api/lifecycle/actions" });

      const body = await expectJson<{ groups: unknown[] }>(response, 200);
      expect(body.groups).toHaveLength(0);
    });

    it("shows an estimated row when the same action type was re-configured (tags changed)", async () => {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      // Rule now adds tags ["keep", "fresh"]...
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Rule",
        enabled: true,
        actionEnabled: true,
        actionType: "UNMONITOR_RADARR",
        addArrTags: ["keep", "fresh"],
      });

      // ...but the completed action only applied ["keep"]. Different config → the
      // re-configured action must surface again.
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
          actionType: "UNMONITOR_RADARR", status: "COMPLETED",
          addArrTags: ["keep"], removeArrTags: [],
          scheduledFor: new Date("2020-01-01T00:00:00Z"), executedAt: new Date("2020-01-02T00:00:00Z"),
        },
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, { url: "/api/lifecycle/actions" });

      const body = await expectJson<{
        groups: { items: { estimated: boolean; mediaItem: { id: string } }[] }[];
      }>(response, 200);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].estimated).toBe(true);
      expect(body.groups[0].items[0].mediaItem.id).toBe(item.id);
    });

    it("filters by status parameter", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      await createTestAction(user.id, item.id, ruleSet.id, { status: "PENDING" });
      await createTestAction(user.id, item.id, ruleSet.id, {
        status: "COMPLETED",
        executedAt: new Date(),
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
        searchParams: { status: "COMPLETED" },
      });

      const body = await expectJson<{
        groups: { items: { status: string }[] }[];
      }>(response, 200);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].status).toBe("COMPLETED");
    });

    it("rejects an unknown status with 400 instead of failing the query", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });
      for (const status of ["CANCELLED", "pending"]) {
        const body = await expectJson<{ error: string }>(
          await callRoute(GET, { url: "/api/lifecycle/actions", searchParams: { status } }),
          400,
        );
        expect(body.error).toMatch(/Invalid status/);
      }
    });

    it("returns ALL statuses when status=ALL", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item1 = await createTestMediaItem(library.id, { title: "Movie 1", type: "MOVIE" });
      const item2 = await createTestMediaItem(library.id, { title: "Movie 2", type: "MOVIE" });
      const item3 = await createTestMediaItem(library.id, { title: "Movie 3", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      // Use different media items to avoid per-(ruleSet, mediaItem) dedup
      await createTestAction(user.id, item1.id, ruleSet.id, { status: "PENDING" });
      await createTestAction(user.id, item2.id, ruleSet.id, { status: "COMPLETED" });
      await createTestAction(user.id, item3.id, ruleSet.id, { status: "FAILED" });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
        searchParams: { status: "ALL" },
      });

      const body = await expectJson<{
        groups: { items: unknown[]; count: number }[];
      }>(response, 200);
      // All 3 actions belong to the same rule set
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].items).toHaveLength(3);
      expect(body.groups[0].count).toBe(3);
    });

    it("groups multiple items under one rule set", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });

      // Create 3 pending actions for different items under the same rule set
      for (let i = 0; i < 3; i++) {
        const item = await createTestMediaItem(library.id, {
          title: `Movie ${i}`,
          type: "MOVIE",
        });
        await createTestAction(user.id, item.id, ruleSet.id, {
          status: "PENDING",
          scheduledFor: new Date(Date.now() + i * 1000),
        });
      }

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: { ruleSet: { id: string; name: string }; items: unknown[]; count: number }[];
      }>(response, 200);

      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].ruleSet.name).toBe("Rule");
      expect(body.groups[0].items).toHaveLength(3);
      expect(body.groups[0].count).toBe(3);
    });

    it("does not return other user's actions", async () => {
      const user1 = await createTestUser({ plexId: "u1" });
      const user2 = await createTestUser({ plexId: "u2" });

      const server = await createTestServer(user1.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Rule" });

      await createTestAction(user1.id, item.id, ruleSet.id);

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
        searchParams: { status: "ALL" },
      });

      const body = await expectJson<{ groups: unknown[] }>(response, 200);
      expect(body.groups).toHaveLength(0);
    });

    it("names a series action by its show, and an action on one episode by show and SxxExx", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const pilot = await createTestMediaItem(library.id, {
        title: "Pilot", type: "SERIES", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1,
      });
      const finale = await createTestMediaItem(library.id, {
        title: "Ozymandias", type: "SERIES", parentTitle: "Breaking Bad", seasonNumber: 5, episodeNumber: 14,
      });
      const ruleSet = await createTestRuleSet(user.id, { name: "Shows", type: "SERIES" });
      const prisma = getTestPrisma();
      // A whole-series delete, stored against a representative episode.
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: pilot.id, ruleSetId: ruleSet.id, actionType: "DELETE_SONARR",
          status: "PENDING", scheduledFor: new Date(), matchedMediaItemIds: [pilot.id, finale.id],
        },
      });
      // A file delete on exactly the one episode it is stored against.
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: finale.id, ruleSetId: ruleSet.id, actionType: "DELETE_FILES_SONARR",
          status: "PENDING", scheduledFor: new Date(Date.now() + 1000), matchedMediaItemIds: [finale.id],
        },
      });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(GET, { url: "/api/lifecycle/actions" });
      const body = await expectJson<{
        groups: { items: { actionType: string; mediaItem: { title: string; parentTitle: string | null } }[] }[];
      }>(response, 200);

      const byType = Object.fromEntries(body.groups[0].items.map((i) => [i.actionType, i.mediaItem]));
      expect(byType.DELETE_SONARR).toMatchObject({ title: "Breaking Bad", parentTitle: null });
      expect(byType.DELETE_FILES_SONARR).toMatchObject({ title: "Breaking Bad S05E14", parentTitle: null });
    });

    it("keeps naming a finished series action by what it acted on once the episode is gone", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, { name: "Shows", type: "SERIES" });
      const prisma = getTestPrisma();
      const done = { userId: user.id, ruleSetId: ruleSet.id, status: "COMPLETED" as const, scheduledFor: new Date(), executedAt: new Date() };
      // mediaItemId null: the episode's row was purged after the delete.
      await prisma.lifecycleAction.create({
        data: {
          ...done, actionType: "DELETE_FILES_SONARR", matchedMediaItemIds: ["purged-episode"],
          mediaItemTitle: "Breaking Bad", mediaItemParentTitle: null, mediaItemSeasonNumber: 2, mediaItemEpisodeNumber: 5,
        },
      });
      await prisma.lifecycleAction.create({
        data: { ...done, actionType: "DELETE_SONARR", mediaItemTitle: "Better Call Saul", mediaItemParentTitle: null },
      });
      // Recorded before series actions snapshotted their show: the episode's own titles.
      await prisma.lifecycleAction.create({
        data: { ...done, actionType: "UNMONITOR_SONARR", mediaItemTitle: "Pilot", mediaItemParentTitle: "El Camino" },
      });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(GET, { url: "/api/lifecycle/actions", searchParams: { status: "COMPLETED" } });
      const body = await expectJson<{
        groups: { items: { actionType: string; mediaItem: { title: string; parentTitle: string | null } }[] }[];
      }>(response, 200);

      const byType = Object.fromEntries(body.groups[0].items.map((i) => [i.actionType, i.mediaItem]));
      expect(byType.DELETE_FILES_SONARR).toMatchObject({ title: "Breaking Bad S02E05", parentTitle: null });
      expect(byType.DELETE_SONARR).toMatchObject({ title: "Better Call Saul", parentTitle: null });
      expect(byType.UNMONITOR_SONARR).toMatchObject({ title: "El Camino", parentTitle: null });
    });

    it("includes mediaItem and ruleSet relations", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Included Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, { name: "Included Rule" });

      await createTestAction(user.id, item.id, ruleSet.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(GET, {
        url: "/api/lifecycle/actions",
      });

      const body = await expectJson<{
        groups: {
          ruleSet: { name: string };
          items: {
            mediaItem: { id: string; title: string; type: string };
          }[];
        }[];
      }>(response, 200);

      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].ruleSet.name).toBe("Included Rule");
      expect(body.groups[0].items).toHaveLength(1);
      expect(body.groups[0].items[0].mediaItem.title).toBe("Included Movie");
    });
  });

  // ---- DELETE /api/lifecycle/actions/[id] (remove failed action) ----

  describe("DELETE /api/lifecycle/actions/[id]", () => {
    it("returns 401 without auth", async () => {
      const response = await callRouteWithParams(
        actionDelete,
        { id: "nonexistent" },
        {
          url: "/api/lifecycle/actions/nonexistent",
          method: "DELETE",
        }
      );
      await expectJson(response, 401);
    });

    it("deletes a FAILED action", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, {
        status: "FAILED",
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: action.id },
        {
          url: `/api/lifecycle/actions/${action.id}`,
          method: "DELETE",
        }
      );

      const body = await expectJson<{ action: null }>(response, 200);
      expect(body.action).toBeNull();

      // Verify it's actually deleted
      const prisma = getTestPrisma();
      const deleted = await prisma.lifecycleAction.findUnique({ where: { id: action.id } });
      expect(deleted).toBeNull();
    });

    it("returns 404 for non-existent action", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: "nonexistent-id" },
        {
          url: "/api/lifecycle/actions/nonexistent-id",
          method: "DELETE",
        }
      );

      await expectJson(response, 404);
    });

    it("returns 404 when deleting another user's action", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });

      const server = await createTestServer(user1.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user1.id, { name: "Rule" });
      const action = await createTestAction(user1.id, item.id, ruleSet.id, { status: "FAILED" });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: action.id },
        {
          url: `/api/lifecycle/actions/${action.id}`,
          method: "DELETE",
        }
      );

      await expectJson(response, 404);
    });

    it("returns 400 when deleting a non-FAILED action", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Rule" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, {
        status: "PENDING",
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRouteWithParams(
        actionDelete,
        { id: action.id },
        {
          url: `/api/lifecycle/actions/${action.id}`,
          method: "DELETE",
        }
      );

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("failed");
    });
  });

  // ---- POST /api/lifecycle/actions/execute ----

  describe("POST /api/lifecycle/actions/execute", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: "some-id" },
      });
      await expectJson(response, 401);
    });

    it("returns 400 when ruleSetId is missing", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {},
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toBe("Validation failed");
    });

    it("returns 404 for non-existent rule set", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: "nonexistent" },
      });

      await expectJson(response, 404);
    });

    it("refuses and disarms a music rule set with Seerr criteria (vacuous matches)", async () => {
      // Seerr has no music requests, so every artist reads "never requested":
      // the stored matches are the whole library and must never be executed.
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const track = await createTestMediaItem(library.id, { title: "Track", type: "MUSIC" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Music Seerr",
        type: "MUSIC",
        actionEnabled: true,
        actionType: "DELETE_LIDARR",
        arrInstanceId: "lidarr-1",
        rules: [
          {
            id: "g1",
            condition: "AND",
            operator: "AND",
            rules: [{ id: "r1", field: "seerrRequested", operator: "equals", value: "false", condition: "AND", enabled: true }],
            groups: [],
          },
        ],
      });
      await createTestRuleMatch(ruleSet.id, track.id);
      await createTestAction(user.id, track.id, ruleSet.id, { actionType: "DELETE_LIDARR" });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/Seerr criteria are not supported on music/i);
      const prisma = getTestPrisma();
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
      expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(0);
    });

    it("returns 404 for another user's rule set", async () => {
      const user1 = await createTestUser({ plexId: "owner" });
      const user2 = await createTestUser({ plexId: "intruder" });
      const ruleSet = await createTestRuleSet(user1.id, {
        name: "Private Rule",
        actionType: "DO_NOTHING",
      });

      setMockSession({ isLoggedIn: true, userId: user2.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      await expectJson(response, 404);
    });

    it("returns 400 when rule set has no action configured", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "No Action",
        actionType: undefined as unknown as string,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("action");
    });

    it("returns 400 when non-DO_NOTHING action has no arrInstanceId", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Missing Arr",
        actionType: "DELETE_RADARR",
        arrInstanceId: undefined as unknown as string,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toContain("Arr instance");
    });

    it("returns 400 fast-fail when CHANGE_QUALITY_PROFILE action lacks a target profile", async () => {
      const user = await createTestUser();
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Missing Target",
        actionType: "CHANGE_QUALITY_PROFILE_RADARR",
        arrInstanceId: "arr1",
        targetQualityProfileId: null,
      });

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/target quality profile/i);
    });

    it("executes DO_NOTHING action for specified media items", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Target Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Do Nothing Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          mediaItemIds: [item.id],
        },
      });

      const body = await expectJson<{ executed: number; failed: number; errors: string[] }>(
        response,
        200
      );
      expect(body.executed).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.errors).toHaveLength(0);
    });

    it("refuses to execute a rule set whose actions are turned off", async () => {
      // The editor keeps actionType when actions are switched off, and detection
      // keeps filling matches — "off" must still mean nothing runs.
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Under Review", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Paused Rule",
        actionEnabled: false,
        actionType: "DELETE_RADARR",
        arrInstanceId: "radarr-1",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });

      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/Actions are turned off/);
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
      expect(await getTestPrisma().ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(1);
    });

    it("refuses an empty mediaItemIds list instead of executing every match", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Not Selected", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Armed Rule",
        actionEnabled: true,
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id, mediaItemIds: [] },
      });

      const body = await expectJson<{ error: string; details: string[] }>(response, 400);
      expect(body.details.join(" ")).toMatch(/at least one media item id/);
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("creates COMPLETED lifecycle action records after execution", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Record Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Record Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          mediaItemIds: [item.id],
        },
      });

      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("COMPLETED");
      expect(actions[0].actionType).toBe("DO_NOTHING");
      expect(actions[0].mediaItemId).toBe(item.id);
      expect(actions[0].ruleSetId).toBe(ruleSet.id);
      // Denormalized title snapshot — preserves displayable name after the
      // MediaItem row is removed by a later library sync.
      expect(actions[0].mediaItemTitle).toBe("Record Movie");
    });

    it("snapshots a series action as its show so the history still names it after MediaItem deletion", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const item = await createTestMediaItem(library.id, {
        title: "Pilot",
        parentTitle: "Some Show",
        type: "SERIES",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Series Rule",
        type: "SERIES",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id, mediaItemIds: [item.id] },
      });

      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      // A series action is its show: the title, with no parent — never the
      // representative episode's own title.
      expect(actions[0].mediaItemTitle).toBe("Some Show");
      expect(actions[0].mediaItemParentTitle).toBeNull();
    });

    it("records the one episode a file delete acted on, so its history can name it once the episode is gone", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const episode = await createTestMediaItem(library.id, {
        title: "Fly", type: "SERIES", parentTitle: "Breaking Bad", seasonNumber: 3, episodeNumber: 10,
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true, name: "Episodes", type: "SERIES", seriesScope: false,
        actionType: "DELETE_FILES_SONARR", arrInstanceId: "arr-1",
      });
      // Episode scope, one matching episode: the show, stored against that episode.
      await createTestRuleMatch(ruleSet.id, episode.id, {
        id: episode.id, title: "Breaking Bad", parentTitle: null, memberIds: [episode.id],
      });

      setMockSession({ isLoggedIn: true, userId: user.id });
      await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id, mediaItemIds: [episode.id] },
      });

      const [record] = await getTestPrisma().lifecycleAction.findMany({ where: { userId: user.id } });
      expect(record).toMatchObject({
        status: "COMPLETED",
        mediaItemTitle: "Breaking Bad",
        mediaItemParentTitle: null,
        mediaItemSeasonNumber: 3,
        mediaItemEpisodeNumber: 10,
      });
    });

    it("names a failed series action by its show, not the episode it is stored against", async () => {
      const { executeAction } = await import("@/lib/lifecycle/actions");
      (executeAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Sonarr API down"));

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const item = await createTestMediaItem(library.id, {
        title: "Pilot", parentTitle: "Some Show", type: "SERIES", seasonNumber: 1, episodeNumber: 1,
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true, name: "Series Rule", type: "SERIES", actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id, mediaItemIds: [item.id] },
      });

      const body = await expectJson<{ failed: number; errors: string[] }>(response, 200);
      expect(body.failed).toBe(1);
      expect(body.errors).toEqual(["Some Show: Sonarr API down"]);
    });

    it("records FAILED status when executeAction throws", async () => {
      const { executeAction } = await import("@/lib/lifecycle/actions");
      (executeAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Radarr API down")
      );

      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Failing Movie",
        type: "MOVIE",
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Failing Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: {
          ruleSetId: ruleSet.id,
          mediaItemIds: [item.id],
        },
      });

      const body = await expectJson<{ executed: number; failed: number; errors: string[] }>(
        response,
        200
      );
      expect(body.executed).toBe(0);
      expect(body.failed).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain("Radarr API down");

      // Check the DB record
      const prisma = getTestPrisma();
      const actions = await prisma.lifecycleAction.findMany({
        where: { userId: user.id },
      });
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("FAILED");
      expect(actions[0].error).toContain("Radarr API down");
      // Denormalized title is captured on FAILED records too so the matches
      // page doesn't fall back to "Unknown" after later cleanup.
      expect(actions[0].mediaItemTitle).toBe("Failing Movie");
    });
  });
  // ── Audit regression: exceptions must block FAILED-action retries ──
  describe("POST /api/lifecycle/actions/[id] (retry)", () => {
    it("refuses to retry when the item has a lifecycle exception", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Excepted Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Retry Rule" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, { status: "FAILED" });
      await createTestRuleMatch(ruleSet.id, item.id);

      const prisma = getTestPrisma();
      await prisma.lifecycleException.create({
        data: { userId: user.id, mediaItemId: item.id, reason: "keep" },
      });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/exception/i);

      // and the action was not executed
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("refuses to retry when a copy of the item on another server has an exception", async () => {
      const user = await createTestUser();
      const item = await createTestMediaItem((await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" })).id, { title: "Shared", type: "MOVIE" });
      const copy = await createTestMediaItem((await createTestLibrary((await createTestServer(user.id)).id, { type: "MOVIE" })).id, { title: "Shared", type: "MOVIE" });
      const prisma = getTestPrisma();
      await prisma.mediaItem.updateMany({ where: { id: { in: [item.id, copy.id] } }, data: { dedupKey: "movie:tmdb:77" } });
      await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: copy.id } });
      const ruleSet = await createTestRuleSet(user.id, { name: "Retry Rule" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, { status: "FAILED" });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/exception/i);
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("refuses to retry an action whose item was re-identified since it was scheduled", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const pilot = await createTestMediaItem(library.id, {
        title: "Miniseries Part 1", type: "SERIES", parentTitle: "Battlestar Galactica", seasonNumber: 1, episodeNumber: 1,
      });
      // A Fix Match moved the row to the same-titled 2004 show.
      await createTestExternalId(pilot.id, "TVDB", "73545");
      const ruleSet = await createTestRuleSet(user.id, { name: "Shows", type: "SERIES", seriesScope: true });
      const prisma = getTestPrisma();
      const action = await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: pilot.id, ruleSetId: ruleSet.id, actionType: "DELETE_SONARR",
          status: "FAILED", scheduledFor: new Date(), mediaItemTitle: "Battlestar Galactica",
          mediaItemParentTitle: null, mediaItemYear: 1978, mediaItemExternalId: "71173",
        },
      });
      await createTestRuleMatch(ruleSet.id, pilot.id, { id: pilot.id, title: "Battlestar Galactica", parentTitle: null });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toContain("73545");
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
      expect((await prisma.lifecycleAction.findUnique({ where: { id: action.id } }))?.status).toBe("FAILED");
    });

    it("retries a failed series action recorded as its show", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const pilot = await createTestMediaItem(library.id, {
        title: "Pilot", type: "SERIES", parentTitle: "Breaking Bad", seasonNumber: 1, episodeNumber: 1,
      });
      await createTestExternalId(pilot.id, "TVDB", "81189");
      const ruleSet = await createTestRuleSet(user.id, { name: "Shows", type: "SERIES", seriesScope: true });
      const action = await getTestPrisma().lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: pilot.id, ruleSetId: ruleSet.id, actionType: "DO_NOTHING",
          status: "FAILED", scheduledFor: new Date(), mediaItemTitle: "Breaking Bad",
          mediaItemParentTitle: null, mediaItemExternalId: "81189",
        },
      });
      await createTestRuleMatch(ruleSet.id, pilot.id, { id: pilot.id, title: "Breaking Bad", parentTitle: null });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      await expectJson(response, 200);
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).toHaveBeenCalledTimes(1);
      // Still recorded as its show, not rewritten to the episode's own title.
      const retried = await getTestPrisma().lifecycleAction.findUniqueOrThrow({ where: { id: action.id } });
      expect(retried).toMatchObject({ status: "COMPLETED", mediaItemTitle: "Breaking Bad", mediaItemParentTitle: null });
    });

    it("retries a FAILED action when no exception exists", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Retry Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Retry Rule 2" });
      const action = await createTestAction(user.id, item.id, ruleSet.id, { status: "FAILED" });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      expect(response.status).toBeLessThan(300);
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).toHaveBeenCalledTimes(1);
    });

    it("refuses to retry when the rule set is disabled", async () => {
      // A disabled rule set's matches are frozen (detection skips it), so the
      // stale-match guard alone would wave a destructive retry through.
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Frozen Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, { name: "Disabled Rule", enabled: false });
      const action = await createTestAction(user.id, item.id, ruleSet.id, {
        status: "FAILED",
        actionType: "DELETE_RADARR",
      });
      await createTestRuleMatch(ruleSet.id, item.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/disabled/i);

      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("refuses to retry an action of a music rule set with Seerr criteria", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const track = await createTestMediaItem(library.id, { title: "Track", type: "MUSIC" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Music Seerr",
        type: "MUSIC",
        rules: [
          {
            id: "g1",
            condition: "AND",
            operator: "AND",
            rules: [{ id: "r1", field: "seerrRequested", operator: "equals", value: "false", condition: "AND", enabled: true }],
            groups: [],
          },
        ],
      });
      const action = await createTestAction(user.id, track.id, ruleSet.id, {
        status: "FAILED",
        actionType: "DELETE_LIDARR",
      });
      await createTestRuleMatch(ruleSet.id, track.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/Seerr criteria are not supported on music/i);

      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("refuses a whole-record retry when a sibling episode has an exception", async () => {
      // DELETE_SONARR destroys the entire series — an exception on an episode
      // the rule never matched must still block the retry.
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const ep1 = await createTestMediaItem(library.id, {
        title: "Ep 1", type: "SERIES", parentTitle: "Retry Show", seasonNumber: 1, episodeNumber: 1,
      });
      const ep2 = await createTestMediaItem(library.id, {
        title: "Ep 2", type: "SERIES", parentTitle: "Retry Show", seasonNumber: 1, episodeNumber: 2,
      });
      const ruleSet = await createTestRuleSet(user.id, { name: "Series Retry Rule", type: "SERIES" });
      const action = await createTestAction(user.id, ep1.id, ruleSet.id, {
        status: "FAILED",
        actionType: "DELETE_SONARR",
      });
      await createTestRuleMatch(ruleSet.id, ep1.id);

      const prisma = getTestPrisma();
      await prisma.lifecycleException.create({
        data: { userId: user.id, mediaItemId: ep2.id, reason: "keep this episode" },
      });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRouteWithParams(actionRetry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/exception/i);

      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });
  });

  // ---- POST /api/lifecycle/actions/execute — single-flight ----

  describe("POST /api/lifecycle/actions/execute — single-flight per rule set", () => {
    // A live security review of the public API found that this route ran the
    // Arr deletions inline with nothing serialising it, so N overlapping POSTs
    // for one rule set each sent the same delete. The lock is per rule set,
    // answered with 409, and released whatever the outcome.
    async function seedExecutable() {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, { title: "Locked Movie", type: "MOVIE" });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Single-flight Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(ruleSet.id, item.id);
      setMockSession({ isLoggedIn: true, userId: user.id });
      return { user, item, ruleSet };
    }

    const execute = (ruleSetId: string, mediaItemIds: string[]) =>
      callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId, mediaItemIds },
      });

    /** Hold the next `executeActionsForItems` call open until `release()`. */
    async function holdNextRun() {
      const { executeActionsForItems } = await import("@/lib/lifecycle/run-actions");
      const runner = vi.mocked(executeActionsForItems);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      runner.mockImplementationOnce(async () => {
        await gate;
        return { executed: 1, failed: 0, errors: [], failures: [] };
      });
      return { runner, release };
    }

    it("answers 409 to an overlapping execute of the same rule set and 200 to the one that got there first", async () => {
      const { item, ruleSet } = await seedExecutable();
      const { runner, release } = await holdNextRun();

      const first = execute(ruleSet.id, [item.id]);
      // Wait until the first request is inside the (held) action run — i.e.
      // past every validation and holding the lock — before racing it.
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

      const second = await execute(ruleSet.id, [item.id]);
      const collided = await expectJson<{ error: string }>(second, 409);
      expect(collided.error).toMatch(/already running for this rule set/i);
      // The second request never reached the runner: no duplicate Arr call.
      expect(runner).toHaveBeenCalledTimes(1);

      release();
      const body = await expectJson<{ executed: number; failed: number }>(await first, 200);
      expect(body.executed).toBe(1);
    });

    it("does not block a different rule set", async () => {
      const { user, item, ruleSet } = await seedExecutable();
      const other = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Other Rule",
        type: "MOVIE",
        actionType: "DO_NOTHING",
      });
      await createTestRuleMatch(other.id, item.id);
      const { runner, release } = await holdNextRun();

      const first = execute(ruleSet.id, [item.id]);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

      const otherResponse = await execute(other.id, [item.id]);
      expect(otherResponse.status).toBe(200);

      release();
      expect((await first).status).toBe(200);
    });

    it("releases the lock once the run completes, so a later execute succeeds", async () => {
      const { item, ruleSet } = await seedExecutable();
      const { runner, release } = await holdNextRun();

      const first = execute(ruleSet.id, [item.id]);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
      expect((await execute(ruleSet.id, [item.id])).status).toBe(409);

      release();
      expect((await first).status).toBe(200);

      // The held (mocked) run skipped the real cleanup, so the match is still
      // there for the real runner to act on.
      const third = await execute(ruleSet.id, [item.id]);
      const body = await expectJson<{ executed: number }>(third, 200);
      expect(body.executed).toBe(1);
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it("releases the lock when the run throws", async () => {
      const { item, ruleSet } = await seedExecutable();
      const { executeActionsForItems } = await import("@/lib/lifecycle/run-actions");
      vi.mocked(executeActionsForItems).mockRejectedValueOnce(new Error("Arr exploded"));

      await expect(execute(ruleSet.id, [item.id])).rejects.toThrow("Arr exploded");

      const again = await execute(ruleSet.id, [item.id]);
      expect(again.status).toBe(200);
    });

    // The Pending page's per-item Execute buttons run side by side; a lock on
    // the whole rule set made the second answer 409 though it named another
    // match.
    it("runs per-item executes of different items of one rule set side by side", async () => {
      const { item, ruleSet } = await seedExecutable();
      const second = await createTestMediaItem(item.libraryId, { title: "Second Movie", type: "MOVIE" });
      await createTestRuleMatch(ruleSet.id, second.id);
      const { runner, release } = await holdNextRun();

      const first = execute(ruleSet.id, [item.id]);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

      const other = await execute(ruleSet.id, [second.id]);
      expect(other.status).toBe(200);

      release();
      expect((await first).status).toBe(200);
    });

    it("refuses Execute All while one of the rule set's items is running, and an item while Execute All runs", async () => {
      const { item, ruleSet } = await seedExecutable();
      const second = await createTestMediaItem(item.libraryId, { title: "Second Movie", type: "MOVIE" });
      await createTestRuleMatch(ruleSet.id, second.id);
      const executeAll = () =>
        callRoute(executePost, {
          url: "/api/lifecycle/actions/execute",
          method: "POST",
          body: { ruleSetId: ruleSet.id },
        });

      const held = await holdNextRun();
      const first = execute(ruleSet.id, [item.id]);
      await vi.waitFor(() => expect(held.runner).toHaveBeenCalledTimes(1));
      const all = await expectJson<{ error: string }>(await executeAll(), 409);
      expect(all.error).toMatch(/already running for this rule set/i);
      held.release();
      expect((await first).status).toBe(200);

      const heldAll = await holdNextRun();
      const whole = executeAll();
      await vi.waitFor(() => expect(heldAll.runner).toHaveBeenCalledTimes(2));
      const one = await expectJson<{ error: string }>(await execute(ruleSet.id, [second.id]), 409);
      expect(one.error).toMatch(/already running for this rule set/i);
      heldAll.release();
      expect((await whole).status).toBe(200);
    });

    it("refuses a force-retry of the same rule set while an execute holds the lock", async () => {
      const { user, item, ruleSet } = await seedExecutable();
      const failedAction = await createTestAction(user.id, item.id, ruleSet.id, { status: "FAILED" });
      const { runner, release } = await holdNextRun();

      const first = execute(ruleSet.id, [item.id]);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

      const retry = await callRouteWithParams(actionRetry, { id: failedAction.id }, {
        url: `/api/lifecycle/actions/${failedAction.id}`,
        method: "POST",
      });
      const body = await expectJson<{ error: string }>(retry, 409);
      expect(body.error).toMatch(/already running for this rule set/i);
      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();

      release();
      expect((await first).status).toBe(200);
    });
  });

  describe("POST /api/lifecycle/actions/execute — whole-record exception guard", () => {
    it("refuses a whole-record delete when a NON-matching sibling episode is excepted", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const ep1 = await createTestMediaItem(library.id, {
        title: "Ep 1", type: "SERIES", parentTitle: "Guarded Show", seasonNumber: 1, episodeNumber: 1,
      });
      const ep2 = await createTestMediaItem(library.id, {
        title: "Ep 2", type: "SERIES", parentTitle: "Guarded Show", seasonNumber: 1, episodeNumber: 2,
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Whole Record Rule",
        type: "SERIES",
        actionType: "DELETE_SONARR",
        arrInstanceId: "arr-1",
      });
      // Only ep1 matched the rule; ep2 is protected but never matched.
      await createTestRuleMatch(ruleSet.id, ep1.id);
      const prisma = getTestPrisma();
      await prisma.lifecycleException.create({
        data: { userId: user.id, mediaItemId: ep2.id, reason: "never delete" },
      });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/exclude/i);

      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("refuses a movie whose copy on another server is excepted", async () => {
      // One Radarr record backs both copies; excluding either protects both.
      const user = await createTestUser();
      const s1 = await createTestServer(user.id);
      const s2 = await createTestServer(user.id);
      const movie = await createTestMediaItem((await createTestLibrary(s1.id, { type: "MOVIE" })).id, { title: "Shared", type: "MOVIE" });
      const copy = await createTestMediaItem((await createTestLibrary(s2.id, { type: "MOVIE" })).id, { title: "Shared", type: "MOVIE" });
      const prisma = getTestPrisma();
      await prisma.mediaItem.updateMany({ where: { id: { in: [movie.id, copy.id] } }, data: { dedupKey: "movie:tmdb:42" } });
      await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: copy.id } });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Movie delete",
        type: "MOVIE",
        actionType: "DELETE_RADARR",
        arrInstanceId: "arr-1",
      });
      await createTestRuleMatch(ruleSet.id, movie.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      expect(body.error).toMatch(/excluded/i);

      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("executes the whole-record delete when no sibling is excepted", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const ep1 = await createTestMediaItem(library.id, {
        title: "Ep 1", type: "SERIES", parentTitle: "Free Show", seasonNumber: 1, episodeNumber: 1,
      });
      const ruleSet = await createTestRuleSet(user.id, {
        actionEnabled: true,
        name: "Whole Record Rule 2",
        type: "SERIES",
        actionType: "DELETE_SONARR",
        arrInstanceId: "arr-1",
      });
      await createTestRuleMatch(ruleSet.id, ep1.id);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ executed: number }>(response, 200);
      expect(body.executed).toBe(1);
    });
  });

  // Detection records the episodes / tracks a match acts on (`itemData.memberIds`)
  // for a series match in either scope and for an artist-scope music match, and
  // the scheduled executor acts on exactly those. This route read them only for
  // series with series scope off: a series-scope member-scoped file delete went
  // out with no episodes (deleting nothing, yet recorded COMPLETED), and an
  // artist-scope one with only the representative track.
  describe("POST /api/lifecycle/actions/execute — members of every grouped scope", () => {
    async function executedMembers() {
      const { executeAction } = await import("@/lib/lifecycle/actions");
      const calls = vi.mocked(executeAction).mock.calls;
      expect(calls).toHaveLength(1);
      return [...calls[0][0].matchedMediaItemIds].sort();
    }

    async function seriesScopeShow(actionType: string) {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const ep1 = await createTestMediaItem(library.id, {
        title: "Pilot", type: "SERIES", parentTitle: "Scoped Show", seasonNumber: 1, episodeNumber: 1,
      });
      const ep2 = await createTestMediaItem(library.id, {
        title: "Second", type: "SERIES", parentTitle: "Scoped Show", seasonNumber: 1, episodeNumber: 2,
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Series scope",
        type: "SERIES",
        seriesScope: true,
        actionEnabled: true,
        actionType,
        arrInstanceId: "arr-1",
      });
      // As detection stores a series-scope match: the show as the title.
      await createTestRuleMatch(ruleSet.id, ep1.id, {
        id: ep1.id, title: "Scoped Show", parentTitle: null, memberIds: [ep1.id, ep2.id],
      });
      setMockSession({ isLoggedIn: true, userId: user.id });
      return { user, ep1, ep2, ruleSet };
    }

    it("passes a series-scope match's episodes to a member-scoped file delete", async () => {
      const { user, ep1, ep2, ruleSet } = await seriesScopeShow("DELETE_FILES_SONARR");

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      expect((await expectJson<{ executed: number }>(response, 200)).executed).toBe(1);

      expect(await executedMembers()).toEqual([ep1.id, ep2.id].sort());
      const [record] = await getTestPrisma().lifecycleAction.findMany({ where: { userId: user.id } });
      expect(record.status).toBe("COMPLETED");
      expect([...record.matchedMediaItemIds].sort()).toEqual([ep1.id, ep2.id].sort());
    });

    it("passes them for selected items too, leaving out an excepted episode", async () => {
      const { user, ep1, ep2, ruleSet } = await seriesScopeShow("DELETE_FILES_SONARR");
      await getTestPrisma().lifecycleException.create({ data: { userId: user.id, mediaItemId: ep2.id } });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id, mediaItemIds: [ep1.id] },
      });
      expect((await expectJson<{ executed: number }>(response, 200)).executed).toBe(1);

      expect(await executedMembers()).toEqual([ep1.id]);
    });

    it("passes an artist-scope match's tracks to a member-scoped file delete", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MUSIC" });
      const t1 = await createTestMediaItem(library.id, { title: "Creep", type: "MUSIC", parentTitle: "Radiohead", albumTitle: "Pablo Honey" });
      const t2 = await createTestMediaItem(library.id, { title: "Karma Police", type: "MUSIC", parentTitle: "Radiohead", albumTitle: "OK Computer" });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Artist scope",
        type: "MUSIC",
        seriesScope: true,
        actionEnabled: true,
        actionType: "DELETE_FILES_LIDARR",
        arrInstanceId: "lidarr-1",
      });
      await createTestRuleMatch(ruleSet.id, t1.id, {
        id: t1.id, title: "Radiohead", parentTitle: null, memberIds: [t1.id, t2.id],
      });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      expect((await expectJson<{ executed: number }>(response, 200)).executed).toBe(1);

      // Not just the representative track the match is stored against.
      expect(await executedMembers()).toEqual([t1.id, t2.id].sort());
    });

    it("counts a whole-series delete by the show's seriesKey, not a same-titled show beside it", async () => {
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "SERIES" });
      const ep1 = await createTestMediaItem(library.id, {
        title: "Miniseries", type: "SERIES", parentTitle: "Battlestar Galactica", seriesKey: "tvdb:73545", fileSize: BigInt(100),
      });
      await createTestMediaItem(library.id, {
        title: "33", type: "SERIES", parentTitle: "Battlestar Galactica", seriesKey: "tvdb:73545", fileSize: BigInt(200),
      });
      // The 1978 show: same title, same library, a different series.
      await createTestMediaItem(library.id, {
        title: "Saga of a Star World", type: "SERIES", parentTitle: "Battlestar Galactica", seriesKey: "tvdb:71173", fileSize: BigInt(5000),
      });
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Shows", type: "SERIES", seriesScope: true, actionEnabled: true, actionType: "DELETE_SONARR", arrInstanceId: "arr-1",
      });
      await createTestRuleMatch(ruleSet.id, ep1.id, { id: ep1.id, title: "Battlestar Galactica", parentTitle: null });
      setMockSession({ isLoggedIn: true, userId: user.id });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      expect((await expectJson<{ executed: number }>(response, 200)).executed).toBe(1);
      const [record] = await getTestPrisma().lifecycleAction.findMany({ where: { userId: user.id } });
      expect(record.deletedBytes).toBe(BigInt(300));
    });

    it("refuses a whole-record delete of a series-scope match whose episode is excepted, from the members", async () => {
      const { user, ep2, ruleSet } = await seriesScopeShow("DELETE_SONARR");
      await getTestPrisma().lifecycleException.create({ data: { userId: user.id, mediaItemId: ep2.id } });

      const response = await callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ error: string }>(response, 400);
      // Refused at the member check, before the whole-record sibling lookup.
      expect(body.error).toBe("All selected items are excluded from lifecycle actions");

      const { executeAction } = await import("@/lib/lifecycle/actions");
      expect(executeAction).not.toHaveBeenCalled();
    });
  });

});
