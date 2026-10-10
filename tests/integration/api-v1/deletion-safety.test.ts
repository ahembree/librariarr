/**
 * Deletion safety of the public API: every way an API key can make Librariarr
 * delete media, attacked directly against the real handlers and database.
 *
 * What a key can reach is pinned below — four endpoints hold the destructive
 * scope, and no v1 route wraps an app handler outside the listed set — and for
 * each of those four this file asserts that a key can never:
 *   - act on "every match" (every item must be named),
 *   - delete or unprotect more than 25 items in one request, or more than 100
 *     an hour across every key,
 *   - act on anything but a stored match of an enabled, action-enabled rule
 *     set, or on an excepted item,
 *   - act on an item whose identity changed after it matched (the wrong item).
 * `executeAction` is mocked: a call to it is a deletion, so "not called" means
 * nothing reached Radarr, Sonarr or Lidarr.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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
  createTestApiKey,
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

const { mockExecuteAction, mockEnqueueJob, mockSendDiscord } = vi.hoisted(() => ({
  mockExecuteAction: vi.fn(),
  mockEnqueueJob: vi.fn(),
  mockSendDiscord: vi.fn(),
}));

// A call to executeAction IS a deletion reaching the Arr app.
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/actions")>()),
  executeAction: mockExecuteAction,
}));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));
vi.mock("@/lib/discord/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord/client")>()),
  sendDiscordNotification: mockSendDiscord,
}));
vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: vi.fn() }));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn(),
  syncCollectionById: vi.fn(),
  syncAllCollections: vi.fn(),
  removeItemFromCollections: vi.fn(),
}));

import * as v1Execute from "@/app/api/v1/lifecycle/actions/execute/route";
import * as v1Exceptions from "@/app/api/v1/lifecycle/exceptions/route";
import * as v1ExceptionById from "@/app/api/v1/lifecycle/exceptions/[id]/route";
import * as v1JobExecution from "@/app/api/v1/jobs/execution/route";
import { POST as appExecute } from "@/app/api/lifecycle/actions/execute/route";
import { executeLifecycleActions, resetApiHoldNotices } from "@/lib/lifecycle/processor";
import { getApiKeyGuard } from "@/lib/api-keys/guard";
import { reserveApiDestructive, resetApiDestructiveBudget } from "@/lib/api-keys/destructive-budget";
import { TASK_LIFECYCLE_EXECUTION, type LifecycleExecutionPayload } from "@/lib/jobs/constants";

const prisma = getTestPrisma();
const V1_ROOT = path.resolve(__dirname, "../../../src/app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

async function setup() {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id } });
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  return { user, server, library };
}

/**
 * `count` movies, each a stored match of one rule set, with the snapshot
 * detection stores (title, year, TMDB id) — the state the Pending page shows.
 */
async function matchedMovies(
  userId: string,
  libraryId: string,
  count: number,
  ruleSetOverrides: Parameters<typeof createTestRuleSet>[1] = {},
) {
  const ruleSet = await createTestRuleSet(userId, {
    type: "MOVIE",
    actionEnabled: true,
    actionType: "DELETE_RADARR",
    arrInstanceId: "radarr-1",
    ...ruleSetOverrides,
  });
  const items = [];
  for (let i = 0; i < count; i++) {
    const tmdb = String(10_000 + i);
    const item = await createTestMediaItem(libraryId, { title: `Movie ${i}`, year: 2000 + (i % 20), type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", tmdb);
    await createTestRuleMatch(ruleSet.id, item.id, {
      id: item.id,
      title: item.title,
      parentTitle: null,
      year: item.year,
      externalIds: [{ source: "TMDB", externalId: tmdb }],
    });
    items.push(item);
  }
  return { ruleSet, items };
}

function execute(key: string, body: unknown) {
  return callRoute(v1Execute.POST, {
    url: "/api/v1/lifecycle/actions/execute",
    method: "POST",
    body,
    headers: { authorization: `Bearer ${key}` },
  });
}

async function executeKey(userId: string, name = "integration") {
  return (await createTestApiKey(userId, { name, scopes: ["lifecycle:execute"] })).key;
}

describe("deletion safety of the public API", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    resetApiDestructiveBudget();
    resetApiHoldNotices();
    mockExecuteAction.mockResolvedValue(undefined);
    mockEnqueueJob.mockResolvedValue(true);
    mockSendDiscord.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe("what a key can reach", () => {
    it("four endpoints can lead to a deletion, and each needs lifecycle:execute", async () => {
      const destructive: string[] = [];
      for (const file of routeFiles(V1_ROOT)) {
        const route = "/" + path.relative(V1_ROOT, path.dirname(file)).split(path.sep).join("/");
        const mod = (await import(file)) as Record<string, unknown>;
        for (const [method, handler] of Object.entries(mod)) {
          if (getApiKeyGuard(handler)?.scope === "lifecycle:execute") destructive.push(`${method} ${route}`);
        }
      }
      expect(destructive.sort()).toEqual([
        "DELETE /lifecycle/exceptions",
        "DELETE /lifecycle/exceptions/[id]",
        "POST /jobs/execution",
        "POST /lifecycle/actions/execute",
      ]);
    });

    it("no v1 route wraps an app handler outside this list — purge, restore, rule edits and ad-hoc query actions stay cookie-only", () => {
      const reachable = new Set<string>();
      for (const file of routeFiles(V1_ROOT)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/import \{([^}]+)\} from "@\/app\/api\/([^"]+)\/route"/g)) {
          for (const name of match[1].split(",")) {
            reachable.add(`${name.trim().split(/\s+/)[0]} /api/${match[2]}`);
          }
        }
      }
      expect([...reachable].sort()).toEqual([
        "DELETE /api/lifecycle/exceptions",
        "DELETE /api/lifecycle/exceptions/[id]",
        "GET /api/lifecycle/actions",
        "GET /api/lifecycle/exceptions",
        "GET /api/lifecycle/rules",
        "GET /api/lifecycle/rules/matches",
        "GET /api/lifecycle/stats",
        "GET /api/media/[id]",
        "GET /api/media/[id]/image",
        "GET /api/media/[id]/plays",
        "GET /api/media/history",
        "GET /api/media/movies",
        "GET /api/media/music",
        "GET /api/media/music/albums",
        "GET /api/media/music/grouped",
        "GET /api/media/recently-added",
        "GET /api/media/search",
        "GET /api/media/series",
        "GET /api/media/series/grouped",
        "GET /api/media/series/seasons",
        "GET /api/media/stats",
        "GET /api/servers",
        "GET /api/sync/status",
        "GET /api/system/info",
        "GET /api/tools/maintenance",
        "GET /api/tools/sessions",
        "POST /api/lifecycle/actions/execute",
        "POST /api/lifecycle/exceptions",
        "POST /api/servers/[id]/sync",
        "POST /api/sync/cancel",
        "POST /api/tools/sessions/terminate",
        "PUT /api/tools/maintenance",
      ]);
    });
  });

  describe("POST /api/v1/lifecycle/actions/execute", () => {
    it("never runs a rule set's action on every match: each item must be named", async () => {
      const { user, library } = await setup();
      const { ruleSet } = await matchedMovies(user.id, library.id, 3);
      const key = await executeKey(user.id);

      const missing = await expectJson<{ details: string[] }>(await execute(key, { ruleSetId: ruleSet.id }), 400);
      expect(missing.details).toEqual(["mediaItemIds: mediaItemIds is required: name every item to act on"]);
      for (const body of [
        { ruleSetId: ruleSet.id, mediaItemIds: [] },
        { ruleSetId: ruleSet.id, mediaItemIds: null },
        // Unknown fields are refused, not ignored: there is no "all" switch.
        { ruleSetId: ruleSet.id, mediaItemIds: ["x"], all: true },
      ]) {
        await expectJson(await execute(key, body), 400);
      }
      expect(mockExecuteAction).not.toHaveBeenCalled();
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(3);
    });

    it("gives back the budget of items never sent because their Arr instance was already down", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 5);
      const key = await executeKey(user.id);
      const { IntegrationError } = await import("@/lib/integration-error");
      // The first delete cannot reach Radarr at all; the other four are then
      // failed without a request (see UnreachableInstances).
      mockExecuteAction.mockRejectedValueOnce(
        new IntegrationError("Radarr", { config: { url: "/api/v3/movie", method: "get" }, code: "ECONNREFUSED" } as never),
      );

      const body = await expectJson<{ executed: number; failed: number }>(
        await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: items.map((i) => i.id) }),
        200,
      );
      expect(body).toMatchObject({ executed: 0, failed: 5 });
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
      // Only the one attempt stays charged.
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 99 });
    });

    it("refuses more than 25 items in one request, whatever the action", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 26);
      const key = await executeKey(user.id);

      const body = await expectJson<{ details: string[] }>(
        await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: items.map((i) => i.id) }),
        400,
      );
      expect(body.details).toEqual(["mediaItemIds: At most 25 media item ids per API request"]);
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });

    it("acts only on stored matches of that rule set — never another item named alongside them", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 1);
      const unmatched = await createTestMediaItem(library.id, { title: "Not Matched", type: "MOVIE" });
      const other = await matchedMovies(user.id, library.id, 1);
      const key = await executeKey(user.id);

      const body = await expectJson<{ executed: number }>(
        await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: [items[0].id, unmatched.id, other.items[0].id] }),
        200,
      );
      expect(body.executed).toBe(1);
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
      expect(mockExecuteAction.mock.calls[0][0].mediaItem.id).toBe(items[0].id);

      // Nothing that is a match of this rule set: nothing at all.
      await expectJson(await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: [unmatched.id] }), 400);
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    });

    it("refuses a disabled rule set, and one whose actions are turned off", async () => {
      const { user, library } = await setup();
      const disabled = await matchedMovies(user.id, library.id, 1, { enabled: false });
      const actionsOff = await matchedMovies(user.id, library.id, 1, { actionEnabled: false });
      const key = await executeKey(user.id);

      await expectJson(await execute(key, { ruleSetId: disabled.ruleSet.id, mediaItemIds: [disabled.items[0].id] }), 400);
      await expectJson(await execute(key, { ruleSetId: actionsOff.ruleSet.id, mediaItemIds: [actionsOff.items[0].id] }), 400);
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });

    it("never touches an excepted item", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 1);
      await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: items[0].id } });
      const key = await executeKey(user.id);

      await expectJson(await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: [items[0].id] }), 400);
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });

    it("refuses an item whose identity changed after it matched — a Fix Match would otherwise delete the wrong film", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 3);
      const key = await executeKey(user.id);

      // Re-matched on the server: same row, same id, different film.
      await prisma.mediaItem.update({ where: { id: items[0].id }, data: { title: "Hackers" } });
      // Same title, different TMDB id (a remake).
      await prisma.mediaItemExternalId.updateMany({
        where: { mediaItemId: items[1].id, source: "TMDB" },
        data: { externalId: "999999" },
      });

      const body = await expectJson<{ error: string }>(
        await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: items.map((i) => i.id) }),
        409,
      );
      expect(body.error).toMatch(/2 of the selected item\(s\) changed/);
      expect(body.error).toMatch(/"Movie 0" is now "Hackers"/);
      expect(body.error).toMatch(/TMDB id changed/);
      // All or nothing: the unchanged third item was not run either.
      expect(mockExecuteAction).not.toHaveBeenCalled();
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(3);

      // The Pending page's Execute is held to the same check.
      setMockSession({ isLoggedIn: true, userId: user.id });
      await expectJson(await callRoute(appExecute, { method: "POST", body: { ruleSetId: ruleSet.id } }), 409);
      expect(mockExecuteAction).not.toHaveBeenCalled();
    });

    it("stops every key at 100 deletions an hour, whole requests only", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 101);
      const first = await executeKey(user.id, "first");
      const second = await executeKey(user.id, "second");

      for (const [i, key] of [first, second, first, second].entries()) {
        const batch = items.slice(i * 25, i * 25 + 25).map((m) => m.id);
        const body = await expectJson<{ executed: number }>(await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: batch }), 200);
        expect(body.executed).toBe(25);
      }
      expect(mockExecuteAction).toHaveBeenCalledTimes(100);

      // The budget is shared: a third key is refused just the same.
      const third = await executeKey(user.id, "third");
      const res = await execute(third, { ruleSetId: ruleSet.id, mediaItemIds: [items[100].id] });
      const body = await expectJson<{ error: string }>(res, 429);
      expect(body.error).toMatch(/at most 100 items per hour/);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(mockExecuteAction).toHaveBeenCalledTimes(100);
      expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(1);
    });

    it("cannot be overspent by concurrent requests", async () => {
      const { user, library } = await setup();
      // Three rule sets: concurrent calls on ONE rule set are already refused
      // by its single-flight lock, so this is the race the budget must win.
      const sets = [
        await matchedMovies(user.id, library.id, 5),
        await matchedMovies(user.id, library.id, 5),
        await matchedMovies(user.id, library.id, 5),
      ];
      const key = await executeKey(user.id);
      expect(reserveApiDestructive(20)).toMatchObject({ ok: true });
      expect(reserveApiDestructive(25)).toMatchObject({ ok: true });
      expect(reserveApiDestructive(25)).toMatchObject({ ok: true });
      expect(reserveApiDestructive(20)).toMatchObject({ ok: true, remaining: 10 });

      const responses = await Promise.all(
        sets.map(({ ruleSet, items }) => execute(key, { ruleSetId: ruleSet.id, mediaItemIds: items.map((m) => m.id) })),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 429]);
      expect(mockExecuteAction).toHaveBeenCalledTimes(10);
    });

    it("runs one execution per rule set at a time, so a concurrent call never repeats a deletion", async () => {
      const { user, library } = await setup();
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 2);
      const key = await executeKey(user.id);
      const body = { ruleSetId: ruleSet.id, mediaItemIds: items.map((m) => m.id) };

      // Hold the first request inside its first deletion, past every check.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      mockExecuteAction.mockImplementationOnce(() => gate);
      const first = execute(key, body);
      await vi.waitFor(() => expect(mockExecuteAction).toHaveBeenCalledTimes(1));

      await expectJson(await execute(key, body), 409);
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);

      release();
      expect((await expectJson<{ executed: number }>(await first, 200)).executed).toBe(2);
      expect(mockExecuteAction).toHaveBeenCalledTimes(2);
      // Only the request that ran was charged.
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 98 });
    });

    it("does not charge actions that delete nothing", async () => {
      const { user, library } = await setup();
      const unmonitor = await matchedMovies(user.id, library.id, 1, { actionType: "UNMONITOR_RADARR" });
      const del = await matchedMovies(user.id, library.id, 1);
      const key = await executeKey(user.id);
      for (let i = 0; i < 4; i++) expect(reserveApiDestructive(25)).toMatchObject({ ok: true });

      await expectJson(await execute(key, { ruleSetId: unmonitor.ruleSet.id, mediaItemIds: [unmonitor.items[0].id] }), 200);
      await expectJson(await execute(key, { ruleSetId: del.ruleSet.id, mediaItemIds: [del.items[0].id] }), 429);
      expect(mockExecuteAction).toHaveBeenCalledTimes(1);
      expect(mockExecuteAction.mock.calls[0][0].actionType).toBe("UNMONITOR_RADARR");
    });

    it("applies the app's own deletion ceiling first, charging nothing when it refuses", async () => {
      const { user, library } = await setup();
      await prisma.appSettings.update({ where: { userId: user.id }, data: { maxAutoDeleteItems: 2 } });
      const { ruleSet, items } = await matchedMovies(user.id, library.id, 3);
      const key = await executeKey(user.id);

      await expectJson(await execute(key, { ruleSetId: ruleSet.id, mediaItemIds: items.map((i) => i.id) }), 400);
      expect(mockExecuteAction).not.toHaveBeenCalled();
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 100 });
    });

    it("leaves the Pending page's Execute All for a signed-in user unchanged", async () => {
      const { user, library } = await setup();
      const { ruleSet } = await matchedMovies(user.id, library.id, 30);
      setMockSession({ isLoggedIn: true, userId: user.id });

      const body = await expectJson<{ executed: number }>(
        await callRoute(appExecute, { method: "POST", body: { ruleSetId: ruleSet.id } }),
        200,
      );
      expect(body.executed).toBe(30);
      // ...and a person's run is not charged to the API's budget.
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 100 });
    });
  });

  describe("removing exceptions", () => {
    async function exceptions(userId: string, libraryId: string, count: number) {
      const rows = [];
      for (let i = 0; i < count; i++) {
        const item = await createTestMediaItem(libraryId, { title: `Kept ${i}`, type: "MOVIE" });
        rows.push(await prisma.lifecycleException.create({ data: { userId, mediaItemId: item.id } }));
      }
      return rows;
    }

    function removeMany(key: string, ids: string[]) {
      return callRoute(v1Exceptions.DELETE, {
        url: "/api/v1/lifecycle/exceptions",
        method: "DELETE",
        body: { ids },
        headers: { authorization: `Bearer ${key}` },
      });
    }

    function removeOne(key: string, id: string) {
      return callRouteWithParams(v1ExceptionById.DELETE, { id }, {
        url: `/api/v1/lifecycle/exceptions/${id}`,
        method: "DELETE",
        headers: { authorization: `Bearer ${key}` },
      });
    }

    it("answers an overlapping removal of the same exception with 404, not a 500, and charges it once", async () => {
      const { user, library } = await setup();
      const [row] = await exceptions(user.id, library.id, 1);
      const key = await executeKey(user.id);

      const statuses = (await Promise.all([removeOne(key, row.id), removeOne(key, row.id)])).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 404]);
      expect(await prisma.lifecycleException.count()).toBe(0);
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 99 });
    });

    it("charges overlapping bulk removals of the same exceptions once", async () => {
      const { user, library } = await setup();
      const rows = await exceptions(user.id, library.id, 3);
      const key = await executeKey(user.id);
      const ids = rows.map((r) => r.id);

      const bodies = await Promise.all([removeMany(key, ids), removeMany(key, ids)].map(async (r) => expectJson<{ deleted: number }>(await r, 200)));
      expect(bodies.reduce((sum, b) => sum + b.deleted, 0)).toBe(3);
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 97 });
    });

    it("removes at most 25 per request", async () => {
      const { user, library } = await setup();
      const rows = await exceptions(user.id, library.id, 26);
      const key = await executeKey(user.id);

      await expectJson(await removeMany(key, rows.map((r) => r.id)), 400);
      expect(await prisma.lifecycleException.count()).toBe(26);

      const body = await expectJson<{ deleted: number }>(await removeMany(key, rows.slice(0, 25).map((r) => r.id)), 200);
      expect(body.deleted).toBe(25);
      // Each removal counted against the hour.
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 75 });
    });

    it("counts every removal against the same hourly budget as deletions", async () => {
      const { user, library } = await setup();
      const rows = await exceptions(user.id, library.id, 2);
      const key = await executeKey(user.id);
      for (let i = 0; i < 4; i++) expect(reserveApiDestructive(25)).toMatchObject({ ok: true });

      const byId = await removeOne(key, rows[0].id);
      expect(byId.status).toBe(429);
      expect(byId.headers.get("retry-after")).not.toBeNull();
      await expectJson(await removeMany(key, [rows[1].id]), 429);
      expect(await prisma.lifecycleException.count()).toBe(2);

      // An id that matches nothing removes nothing, so it costs nothing.
      await expectJson(await removeOne(key, "missing"), 404);
    });
  });

  describe("POST /api/v1/jobs/execution", () => {
    async function dueDeletes(userId: string, libraryId: string, count: number) {
      const { ruleSet, items } = await matchedMovies(userId, libraryId, count);
      await prisma.lifecycleAction.createMany({
        data: items.map((item) => ({
          userId,
          mediaItemId: item.id,
          mediaItemTitle: item.title,
          ruleSetId: ruleSet.id,
          ruleSetName: ruleSet.name,
          ruleSetType: "MOVIE",
          actionType: "DELETE_RADARR",
          arrInstanceId: "radarr-1",
          scheduledFor: new Date(Date.now() - 60_000),
          status: "PENDING" as const,
        })),
      });
      return { ruleSet, items };
    }

    /** Queue a run through the API, then run exactly the job it queued. */
    async function queueAndRun(userId: string, name = "n8n") {
      const key = (await createTestApiKey(userId, { name, scopes: ["lifecycle:execute"] })).key;
      await expectJson(
        await callRoute(v1JobExecution.POST, { method: "POST", headers: { authorization: `Bearer ${key}` } }),
        202,
      );
      const [task, payload] = mockEnqueueJob.mock.calls.at(-1)!;
      expect(task).toBe(TASK_LIFECYCLE_EXECUTION);
      const { viaApiKey } = payload as LifecycleExecutionPayload;
      expect(viaApiKey).toBe(name);
      await executeLifecycleActions(userId, { viaApiKey });
    }

    it("holds a run that would delete more than 25 items — nothing deleted, everything left pending", async () => {
      const { user, library } = await setup();
      await prisma.appSettings.update({ where: { userId: user.id }, data: { discordWebhookUrl: "https://discord.test/hook" } });
      await dueDeletes(user.id, library.id, 26);

      await queueAndRun(user.id);

      expect(mockExecuteAction).not.toHaveBeenCalled();
      expect(await prisma.lifecycleAction.count({ where: { status: "PENDING" } })).toBe(26);
      // Held loudly, not silently.
      expect(mockSendDiscord).toHaveBeenCalledWith(
        "https://discord.test/hook",
        expect.objectContaining({
          embeds: [expect.objectContaining({ title: "Lifecycle deletion held for review" })],
        }),
      );
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 100 });

      // Queued again straight away and held again: logged, but Discord is not
      // posted to on every call of a client stuck in a loop.
      await queueAndRun(user.id, "n8n retry");
      expect(mockExecuteAction).not.toHaveBeenCalled();
      expect(mockSendDiscord).toHaveBeenCalledTimes(1);
    });

    it("runs a small batch and charges it; the schedule itself is never limited", async () => {
      const { user, library } = await setup();
      await dueDeletes(user.id, library.id, 3);
      await queueAndRun(user.id);
      expect(mockExecuteAction).toHaveBeenCalledTimes(3);
      expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: 97 });

      mockExecuteAction.mockClear();
      await dueDeletes(user.id, library.id, 30);
      await executeLifecycleActions(user.id);
      expect(mockExecuteAction).toHaveBeenCalledTimes(30);
    });

    it("holds a run once the hourly budget is spent", async () => {
      const { user, library } = await setup();
      await dueDeletes(user.id, library.id, 2);
      for (let i = 0; i < 4; i++) expect(reserveApiDestructive(25)).toMatchObject({ ok: true });

      await queueAndRun(user.id);

      expect(mockExecuteAction).not.toHaveBeenCalled();
      expect(await prisma.lifecycleAction.count({ where: { status: "PENDING" } })).toBe(2);
    });
  });
});
