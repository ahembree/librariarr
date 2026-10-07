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
  createTestApiKey,
} from "../../setup/test-helpers";

/**
 * While a server's play history is not established, detection skips a rule set
 * with play-activity criteria and KEEPS its matches and PENDING actions — so
 * those matches are frozen from before the history went unknown, and an item
 * watched since keeps its match. The executors must not act on that frozen
 * answer: the scheduled executor leaves such a rule set's due actions PENDING
 * (never cancelled), and Execute (and its `/api/v1` mirror) and force-retry
 * refuse with the guard's reason. Real Postgres; the rule engine, detection,
 * the scheduled executor and the routes are real.
 */

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
  buildApiKeyEmbed: vi.fn(),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));
// The Arr call itself is beside the point; what matters is whether it is made.
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn().mockResolvedValue(undefined) };
});

import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { requireLibraryResync } from "@/lib/media/watch-evidence";
import { executeAction } from "@/lib/lifecycle/actions";
import { POST as executePost } from "@/app/api/lifecycle/actions/execute/route";
import { POST as retryPost } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as v1ExecutePost } from "@/app/api/v1/lifecycle/actions/execute/route";
import { logger } from "@/lib/logger";

const prisma = getTestPrisma();

const rule = (field: string, operator: string, value: unknown) => [
  { id: "g1", condition: "AND", rules: [{ id: "r1", field, operator, value, condition: "AND" }], groups: [] },
];
const NEVER_PLAYED = rule("playCount", "equals", 0);
const BY_TITLE = rule("title", "contains", "Leaving");

const statusesOf = async (ruleSetId: string) =>
  (await prisma.lifecycleAction.findMany({ where: { ruleSetId }, orderBy: { mediaItemId: "asc" } })).map(
    (a) => ({ mediaItemId: a.mediaItemId, status: a.status }),
  );
const comeDue = (ruleSetId: string) =>
  prisma.lifecycleAction.updateMany({
    where: { ruleSetId, status: "PENDING" },
    data: { scheduledFor: new Date(Date.now() - 1_000) },
  });
const heldWarnings = () =>
  vi
    .mocked(logger.warn)
    .mock.calls.map((c) => String(c[1]))
    .filter((line) => line.startsWith("Holding ") && line.includes("due action(s)"));

/**
 * A server with established history, two never-played movies, and a rule set
 * matching never-played movies with an armed DO_NOTHING action; detection has
 * run, so both are PENDING.
 */
async function armed(rules: unknown = NEVER_PLAYED) {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { watchHistorySyncedAt: new Date() });
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const watched = await createTestMediaItem(library.id, { title: "Leaving Soon A", type: "MOVIE", playCount: 0 });
  const unwatched = await createTestMediaItem(library.id, { title: "Leaving Soon B", type: "MOVIE", playCount: 0 });
  const ruleSet = await createTestRuleSet(user.id, {
    name: "Unwatched",
    type: "MOVIE",
    rules,
    serverIds: [server.id],
    actionEnabled: true,
    actionType: "DO_NOTHING",
    actionDelayDays: 7,
  });
  await processLifecycleRules(user.id);
  expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(2);
  return { userId: user.id, serverId: server.id, libraryId: library.id, watched, unwatched, ruleSet };
}

/** The household watches one of them; the history pass's reconcile raises its play count. */
const watch = (id: string) =>
  prisma.mediaItem.update({ where: { id }, data: { playCount: 2, lastPlayedAt: new Date() } });

describe("execution while play history is not established", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("the scheduled executor", () => {
    it("control — no hold: the watched item drops out at detection and its action is cancelled", async () => {
      const fx = await armed();
      await watch(fx.watched.id);
      await processLifecycleRules(fx.userId);
      await comeDue(fx.ruleSet.id);

      await executeLifecycleActions(fx.userId);

      expect(await statusesOf(fx.ruleSet.id)).toEqual([{ mediaItemId: fx.unwatched.id, status: "COMPLETED" }]);
    });

    it("leaves a held rule set's due actions PENDING, untouched — the item watched during the hold is not acted on", async () => {
      // The reviewer's repro: detection refuses the rule set and keeps its
      // frozen matches, so the stale check passes on the watched item's match.
      const fx = await armed();
      await requireLibraryResync([fx.serverId]);
      await watch(fx.watched.id);
      await processLifecycleRules(fx.userId);
      await comeDue(fx.ruleSet.id);

      await executeLifecycleActions(fx.userId);

      const statuses = await statusesOf(fx.ruleSet.id);
      expect(statuses).toHaveLength(2);
      expect(statuses.every((a) => a.status === "PENDING")).toBe(true);
      expect(executeAction).not.toHaveBeenCalled();
      // Said once per rule set, with the guard's reason.
      const warnings = heldWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Holding 2 due action(s) of rule set "Unwatched" — Rules read play activity but');
      expect(warnings[0]).toMatch(/waits for a complete library sync/);
    });

    it("holds for every fault the guard refuses on, not only a library-resync hold", async () => {
      const fx = await armed();
      await prisma.mediaServer.update({ where: { id: fx.serverId }, data: { watchHistorySyncedAt: null } });
      await comeDue(fx.ruleSet.id);

      await executeLifecycleActions(fx.userId);

      expect((await statusesOf(fx.ruleSet.id)).map((a) => a.status)).toEqual(["PENDING", "PENDING"]);
      expect(heldWarnings()[0]).toMatch(/no sync has established what was played there/);
    });

    it("still executes a rule set that reads no play activity during the hold", async () => {
      const fx = await armed(BY_TITLE);
      await requireLibraryResync([fx.serverId]);
      await comeDue(fx.ruleSet.id);

      await executeLifecycleActions(fx.userId);

      expect((await statusesOf(fx.ruleSet.id)).map((a) => a.status)).toEqual(["COMPLETED", "COMPLETED"]);
      expect(heldWarnings()).toHaveLength(0);
    });

    it("is scoped to the servers the rule set reads", async () => {
      const fx = await armed();
      const other = await createTestServer(fx.userId, { name: "Elsewhere" });
      await requireLibraryResync([other.id]);
      await comeDue(fx.ruleSet.id);

      await executeLifecycleActions(fx.userId);

      expect((await statusesOf(fx.ruleSet.id)).map((a) => a.status)).toEqual(["COMPLETED", "COMPLETED"]);
    });

    it("once play history is established again, detection re-evaluates and everything runs as before", async () => {
      const fx = await armed();
      await requireLibraryResync([fx.serverId]);
      await watch(fx.watched.id);
      await processLifecycleRules(fx.userId);
      await comeDue(fx.ruleSet.id);
      await executeLifecycleActions(fx.userId);
      expect((await statusesOf(fx.ruleSet.id)).map((a) => a.status)).toEqual(["PENDING", "PENDING"]);

      // A full sync released the hold and its history phase established the marker.
      await prisma.mediaServer.update({
        where: { id: fx.serverId },
        data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: new Date() },
      });
      await processLifecycleRules(fx.userId);
      await comeDue(fx.ruleSet.id);
      await executeLifecycleActions(fx.userId);

      expect(await statusesOf(fx.ruleSet.id)).toEqual([{ mediaItemId: fx.unwatched.id, status: "COMPLETED" }]);
    });
  });

  describe("Execute and force-retry", () => {
    const execute = (ruleSetId: string, mediaItemIds?: string[]) =>
      callRoute(executePost, {
        url: "/api/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId, ...(mediaItemIds ? { mediaItemIds } : {}) },
      });

    it("Execute refuses a play-activity rule set with 409 and the guard's reason, executing nothing", async () => {
      const fx = await armed();
      await requireLibraryResync([fx.serverId]);
      setMockSession({ isLoggedIn: true, userId: fx.userId });

      const body = await expectJson<{ error: string }>(await execute(fx.ruleSet.id, [fx.watched.id]), 409);
      expect(body.error).toMatch(/^Rules read play activity but 1 server\(s\) have no established play history yet/);
      expect(body.error).toMatch(/waits for a complete library sync/);
      // Execute All is refused the same way.
      await expectJson(await execute(fx.ruleSet.id), 409);

      expect(executeAction).not.toHaveBeenCalled();
      expect((await statusesOf(fx.ruleSet.id)).map((a) => a.status)).toEqual(["PENDING", "PENDING"]);
    });

    it("its /api/v1 mirror refuses the same way", async () => {
      const fx = await armed();
      await requireLibraryResync([fx.serverId]);
      const { key } = await createTestApiKey(fx.userId, { scopes: ["lifecycle:execute"] });

      const response = await callRoute(v1ExecutePost, {
        url: "/api/v1/lifecycle/actions/execute",
        method: "POST",
        body: { ruleSetId: fx.ruleSet.id, mediaItemIds: [fx.watched.id] },
        headers: { authorization: `Bearer ${key}` },
      });

      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toMatch(/^Rules read play activity but/);
      expect(executeAction).not.toHaveBeenCalled();
    });

    it("force-retry refuses a FAILED action of a play-activity rule set with 409 and the reason", async () => {
      const fx = await armed();
      const action = await prisma.lifecycleAction.findFirstOrThrow({
        where: { ruleSetId: fx.ruleSet.id, mediaItemId: fx.watched.id },
      });
      await prisma.lifecycleAction.update({ where: { id: action.id }, data: { status: "FAILED" } });
      await requireLibraryResync([fx.serverId]);
      setMockSession({ isLoggedIn: true, userId: fx.userId });

      const response = await callRouteWithParams(retryPost, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`,
        method: "POST",
      });

      const body = await expectJson<{ error: string }>(response, 409);
      expect(body.error).toMatch(/^Rules read play activity but .*waits for a complete library sync/);
      expect(executeAction).not.toHaveBeenCalled();
      expect((await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("FAILED");
    });

    it("both run as before for a rule set that reads no play activity, and once history is established", async () => {
      const byTitle = await armed(BY_TITLE);
      await requireLibraryResync([byTitle.serverId]);
      setMockSession({ isLoggedIn: true, userId: byTitle.userId });
      const executed = await expectJson<{ executed: number }>(await execute(byTitle.ruleSet.id, [byTitle.watched.id]), 200);
      expect(executed.executed).toBe(1);

      const fx = await armed();
      await requireLibraryResync([fx.serverId]);
      const failed = await prisma.lifecycleAction.findFirstOrThrow({
        where: { ruleSetId: fx.ruleSet.id, mediaItemId: fx.watched.id },
      });
      await prisma.lifecycleAction.update({ where: { id: failed.id }, data: { status: "FAILED" } });
      await prisma.mediaServer.update({
        where: { id: fx.serverId },
        data: { libraryResyncRequiredAt: null, watchHistorySyncedAt: new Date() },
      });
      setMockSession({ isLoggedIn: true, userId: fx.userId });

      await expectJson(await execute(fx.ruleSet.id, [fx.unwatched.id]), 200);
      const retried = await callRouteWithParams(retryPost, { id: failed.id }, {
        url: `/api/lifecycle/actions/${failed.id}`,
        method: "POST",
      });
      expect(retried.status).toBeLessThan(300);
    });

    it("Execute All refuses for any fault the guard reports (here: no marker), writing no FAILED rows", async () => {
      const fx = await armed();
      await prisma.mediaServer.update({ where: { id: fx.serverId }, data: { watchHistorySyncedAt: null } });
      setMockSession({ isLoggedIn: true, userId: fx.userId });

      const body = await expectJson<{ error: string }>(await execute(fx.ruleSet.id), 409);
      expect(body.error).toMatch(/no sync has established what was played there/);

      expect(await prisma.lifecycleAction.count({ where: { ruleSetId: fx.ruleSet.id, status: { not: "PENDING" } } })).toBe(0);
    });
  });
});
