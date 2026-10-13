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

import { GET } from "@/app/api/lifecycle/stats/route";

describe("GET /api/lifecycle/stats", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
    await expectJson(response, 401);
  });

  it("counts an upcoming delete match even if a completed NON-delete action exists on the same item", async () => {
    // Regression: a delete rule will delete the item regardless of any prior
    // unmonitor/search (or an action that was changed to delete). The completed
    // non-delete action must NOT exclude it from the pending-deletion estimate.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE", fileSize: BigInt(1000) });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Delete rule",
      enabled: true,
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });

    // Same rule set previously ran a SEARCH on this item, then its action was
    // changed to DELETE. The item now has an upcoming delete match.
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
        actionType: "SEARCH_RADARR", status: "COMPLETED",
        scheduledFor: new Date("2020-01-01T00:00:00Z"), executedAt: new Date("2020-01-02T00:00:00Z"),
      },
    });
    await createTestRuleMatch(ruleSet.id, item.id);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
    const body = await expectJson<{ pendingBytes: string; pendingCount: number }>(response, 200);

    expect(body.pendingCount).toBe(1);
    expect(body.pendingBytes).toBe("1000");
  });

  it("does not double-count an upcoming match that already has a PENDING delete action", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Movie", type: "MOVIE", fileSize: BigInt(1000) });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Delete rule",
      enabled: true,
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });

    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id,
        actionType: "DELETE_RADARR", status: "PENDING", scheduledFor: new Date(),
      },
    });
    await createTestRuleMatch(ruleSet.id, item.id);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
    const body = await expectJson<{ pendingBytes: string; pendingCount: number }>(response, 200);

    // Counted once (via the PENDING action), not twice (PENDING + upcoming match).
    expect(body.pendingCount).toBe(1);
    expect(body.pendingBytes).toBe("1000");
  });

  describe("sizes and per-rule-set totals", () => {
    async function setup() {
      const prisma = getTestPrisma();
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const movies = await createTestLibrary(server.id, { type: "MOVIE" });
      const shows = await createTestLibrary(server.id, { type: "SERIES" });
      const mk = (libraryId: string, title: string, fileSize: bigint, type: "MOVIE" | "SERIES" = "MOVIE") =>
        createTestMediaItem(libraryId, { title, type, fileSize });
      setMockSession({ isLoggedIn: true, userId: user.id });
      return { prisma, user, movies, shows, mk };
    }

    async function getStats() {
      const response = await callRoute(GET, { url: "/api/lifecycle/stats" });
      return expectJson<{
        totalBytesDeleted: string;
        actionCount: number;
        pendingBytes: string;
        pendingCount: number;
        resetAt: string | null;
        byRuleSet: {
          ruleSetId: string | null;
          ruleSetName: string;
          ruleSetType: string | null;
          deleted: boolean;
          deletedBytes: string;
          deletedCount: number;
          pendingBytes: string;
          pendingCount: number;
        }[];
      }>(response, 200);
    }

    it("sums a pending action's members, counting a repeated member twice and a missing one as nothing", async () => {
      const { prisma, user, shows, mk } = await setup();
      const rep = await mk(shows.id, "Pilot", BigInt(1), "SERIES");
      const e1 = await mk(shows.id, "E1", BigInt(100), "SERIES");
      const e2 = await mk(shows.id, "E2", BigInt(20), "SERIES");
      const ruleSet = await createTestRuleSet(user.id, {
        name: "Shows", type: "SERIES", enabled: true, actionEnabled: true, actionType: "DELETE_SONARR",
      });
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: rep.id, ruleSetId: ruleSet.id, ruleSetName: "Shows", ruleSetType: "SERIES",
          actionType: "DELETE_SONARR", status: "PENDING", scheduledFor: new Date(),
          matchedMediaItemIds: [e1.id, e2.id, e2.id, "gone-item"],
        },
      });

      const body = await getStats();
      // 100 + 20 + 20 — the representative's own size is not added.
      expect(body.pendingBytes).toBe("140");
      expect(body.pendingCount).toBe(1);
      expect(body.byRuleSet).toEqual([
        expect.objectContaining({ ruleSetId: ruleSet.id, pendingBytes: "140", pendingCount: 1, deletedCount: 0 }),
      ]);
    });

    it("sums an upcoming match's member ids, and its own size when it lists none", async () => {
      const { user, shows, movies, mk } = await setup();
      const rep = await mk(shows.id, "Pilot", BigInt(1), "SERIES");
      const e1 = await mk(shows.id, "E1", BigInt(300), "SERIES");
      const e2 = await mk(shows.id, "E2", BigInt(30), "SERIES");
      const movie = await mk(movies.id, "Film", BigInt(5));
      const shows1 = await createTestRuleSet(user.id, {
        name: "Shows", type: "SERIES", enabled: true, actionEnabled: true, actionType: "DELETE_SONARR",
      });
      const films = await createTestRuleSet(user.id, {
        name: "Films", type: "MOVIE", enabled: true, actionEnabled: true, actionType: "DELETE_RADARR",
      });
      await createTestRuleMatch(shows1.id, rep.id, { memberIds: [e1.id, e2.id] });
      await createTestRuleMatch(films.id, movie.id, { memberIds: [] });

      const body = await getStats();
      expect(body.pendingBytes).toBe("335");
      expect(body.pendingCount).toBe(2);
      const byId = Object.fromEntries(body.byRuleSet.map((r) => [r.ruleSetId, r]));
      expect(byId[shows1.id]).toMatchObject({ ruleSetName: "Shows", ruleSetType: "SERIES", pendingBytes: "330", pendingCount: 1 });
      expect(byId[films.id]).toMatchObject({ ruleSetName: "Films", ruleSetType: "MOVIE", pendingBytes: "5", pendingCount: 1 });
      // Largest first.
      expect(body.byRuleSet.map((r) => r.ruleSetId)).toEqual([shows1.id, films.id]);
    });

    it("leaves out matches of rule sets that are disabled, action-disabled or not deleting", async () => {
      const { user, movies, mk } = await setup();
      const a = await mk(movies.id, "A", BigInt(1));
      for (const overrides of [
        { name: "Off", enabled: false, actionEnabled: true, actionType: "DELETE_RADARR" },
        { name: "No action", enabled: true, actionEnabled: false, actionType: "DELETE_RADARR" },
        { name: "Unmonitor", enabled: true, actionEnabled: true, actionType: "UNMONITOR_RADARR" },
      ]) {
        const rs = await createTestRuleSet(user.id, { ...overrides, type: "MOVIE" });
        await createTestRuleMatch(rs.id, a.id);
      }

      const body = await getStats();
      expect(body.pendingCount).toBe(0);
      expect(body.pendingBytes).toBe("0");
      expect(body.byRuleSet).toEqual([]);
    });

    it("sums completed deletions since the reset point, keeping a deleted rule set's actions apart by name", async () => {
      const { prisma, user } = await setup();
      const live = await createTestRuleSet(user.id, {
        name: "Live", type: "MOVIE", enabled: true, actionEnabled: true, actionType: "DELETE_RADARR",
      });
      const done = (data: {
        ruleSetId?: string | null; ruleSetName: string; deletedBytes: bigint | null;
        executedAt: Date; actionType?: string;
      }) =>
        prisma.lifecycleAction.create({
          data: {
            userId: user.id, ruleSetType: "MOVIE", status: "COMPLETED", scheduledFor: data.executedAt,
            actionType: data.actionType ?? "DELETE_RADARR", ...data,
          },
        });
      await prisma.appSettings.upsert({
        where: { userId: user.id },
        update: { deletionStatsResetAt: new Date("2025-01-01T00:00:00Z") },
        create: { userId: user.id, deletionStatsResetAt: new Date("2025-01-01T00:00:00Z") },
      });
      await done({ ruleSetId: live.id, ruleSetName: "Live", deletedBytes: BigInt(10), executedAt: new Date("2025-02-01T00:00:00Z") });
      // Renamed since: the newer name names the row.
      await done({ ruleSetId: live.id, ruleSetName: "Live (renamed)", deletedBytes: BigInt(5), executedAt: new Date("2025-03-01T00:00:00Z") });
      // Before the reset point.
      await done({ ruleSetId: live.id, ruleSetName: "Live", deletedBytes: BigInt(1000), executedAt: new Date("2024-12-31T00:00:00Z") });
      // Not a delete, and a delete that recorded no size.
      await done({ ruleSetId: live.id, ruleSetName: "Live", deletedBytes: BigInt(7), executedAt: new Date("2025-02-01T00:00:00Z"), actionType: "UNMONITOR_RADARR" });
      await done({ ruleSetId: live.id, ruleSetName: "Live", deletedBytes: null, executedAt: new Date("2025-02-01T00:00:00Z") });
      // Two rule sets deleted since, by name.
      await done({ ruleSetId: null, ruleSetName: "Gone A", deletedBytes: BigInt(40), executedAt: new Date("2025-02-01T00:00:00Z") });
      await done({ ruleSetId: null, ruleSetName: "Gone A", deletedBytes: BigInt(2), executedAt: new Date("2025-02-02T00:00:00Z") });
      await done({ ruleSetId: null, ruleSetName: "Gone B", deletedBytes: BigInt(3), executedAt: new Date("2025-02-01T00:00:00Z") });

      const body = await getStats();
      expect(body.totalBytesDeleted).toBe("60");
      expect(body.actionCount).toBe(5);
      expect(body.resetAt).toBe("2025-01-01T00:00:00.000Z");
      expect(body.byRuleSet).toEqual([
        { ruleSetId: null, ruleSetName: "Gone A", ruleSetType: "MOVIE", deleted: true, deletedBytes: "42", deletedCount: 2, pendingBytes: "0", pendingCount: 0 },
        { ruleSetId: live.id, ruleSetName: "Live (renamed)", ruleSetType: "MOVIE", deleted: false, deletedBytes: "15", deletedCount: 2, pendingBytes: "0", pendingCount: 0 },
        { ruleSetId: null, ruleSetName: "Gone B", ruleSetType: "MOVIE", deleted: true, deletedBytes: "3", deletedCount: 1, pendingBytes: "0", pendingCount: 0 },
      ]);
    });

    it("counts a match beside a completed delete and a pending non-delete action", async () => {
      const { prisma, user, movies, mk } = await setup();
      const a = await mk(movies.id, "A", BigInt(9));
      const rs = await createTestRuleSet(user.id, {
        name: "Mine", type: "MOVIE", enabled: true, actionEnabled: true, actionType: "DELETE_RADARR",
      });
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: a.id, ruleSetId: rs.id, actionType: "DELETE_RADARR",
          status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), deletedBytes: BigInt(9),
        },
      });
      // A PENDING non-delete action neither counts nor hides the match.
      await prisma.lifecycleAction.create({
        data: {
          userId: user.id, mediaItemId: a.id, ruleSetId: rs.id, actionType: "UNMONITOR_RADARR",
          status: "PENDING", scheduledFor: new Date(),
        },
      });
      await createTestRuleMatch(rs.id, a.id);

      const body = await getStats();
      expect(body.actionCount).toBe(1);
      expect(body.totalBytesDeleted).toBe("9");
      expect(body.pendingCount).toBe(1);
      expect(body.pendingBytes).toBe("9");
    });
  });
});
