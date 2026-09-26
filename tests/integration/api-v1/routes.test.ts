import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";
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

const { mockEnqueueJob } = vi.hoisted(() => ({ mockEnqueueJob: vi.fn() }));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: mockEnqueueJob }));

// system/info asks GitHub for the latest release.
vi.mock("@/lib/version/update-checker", () => ({
  checkForUpdate: vi.fn().mockResolvedValue({ updateAvailable: false }),
}));

import * as me from "@/app/api/v1/me/route";
import * as systemInfo from "@/app/api/v1/system/info/route";
import * as servers from "@/app/api/v1/servers/route";
import * as serverSync from "@/app/api/v1/servers/[id]/sync/route";
import * as syncStatus from "@/app/api/v1/sync/status/route";
import * as syncCancel from "@/app/api/v1/sync/cancel/route";
import * as jobSync from "@/app/api/v1/jobs/sync/route";
import * as jobDetection from "@/app/api/v1/jobs/detection/route";
import * as jobExecution from "@/app/api/v1/jobs/execution/route";
import * as movies from "@/app/api/v1/media/movies/route";
import * as series from "@/app/api/v1/media/series/route";
import * as seriesGrouped from "@/app/api/v1/media/series/grouped/route";
import * as seriesSeasons from "@/app/api/v1/media/series/seasons/route";
import * as music from "@/app/api/v1/media/music/route";
import * as musicGrouped from "@/app/api/v1/media/music/grouped/route";
import * as musicAlbums from "@/app/api/v1/media/music/albums/route";
import * as search from "@/app/api/v1/media/search/route";
import * as recentlyAdded from "@/app/api/v1/media/recently-added/route";
import * as mediaStats from "@/app/api/v1/media/stats/route";
import * as history from "@/app/api/v1/media/history/route";
import * as mediaItem from "@/app/api/v1/media/[id]/route";
import * as mediaPlays from "@/app/api/v1/media/[id]/plays/route";
import * as mediaImage from "@/app/api/v1/media/[id]/image/route";
import * as rules from "@/app/api/v1/lifecycle/rules/route";
import * as ruleMatches from "@/app/api/v1/lifecycle/rules/matches/route";
import * as ruleRun from "@/app/api/v1/lifecycle/rules/run/route";
import * as actions from "@/app/api/v1/lifecycle/actions/route";
import * as actionsExecute from "@/app/api/v1/lifecycle/actions/execute/route";
import * as exceptions from "@/app/api/v1/lifecycle/exceptions/route";
import * as exceptionById from "@/app/api/v1/lifecycle/exceptions/[id]/route";
import * as lifecycleStats from "@/app/api/v1/lifecycle/stats/route";
import * as sessions from "@/app/api/v1/tools/sessions/route";
import * as terminate from "@/app/api/v1/tools/sessions/terminate/route";
import * as maintenance from "@/app/api/v1/tools/maintenance/route";
import { GET as appMoviesGET } from "@/app/api/media/movies/route";
import { API_SCOPES, API_SCOPE_INFO, type ApiScope } from "@/lib/api-keys/scopes";
import { TASK_LIFECYCLE_DETECTION, TASK_LIFECYCLE_EXECUTION, TASK_SYNC_SERVER } from "@/lib/jobs/constants";

const prisma = getTestPrisma();

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface RouteCase {
  label: string;
  handler: unknown;
  method: string;
  scope: ApiScope | null;
  params?: Record<string, string>;
  body?: unknown;
  /** What the underlying handler answers once it runs as the key's owner. */
  status: number;
}

// Every /api/v1 endpoint (tests/unit/api-keys/v1-routes.test.ts pins this list
// to the files on disk). `status` is the handler's own answer on a user with
// no data — proof it ran as an authenticated user rather than stopping at a
// 401/403.
const ROUTES: RouteCase[] = [
  { label: "GET /me", handler: me.GET, method: "GET", scope: null, status: 200 },
  { label: "GET /system/info", handler: systemInfo.GET, method: "GET", scope: "system:read", status: 200 },
  { label: "GET /servers", handler: servers.GET, method: "GET", scope: "servers:read", status: 200 },
  { label: "POST /servers/[id]/sync", handler: serverSync.POST, method: "POST", scope: "sync:write", params: { id: "missing" }, status: 404 },
  { label: "GET /sync/status", handler: syncStatus.GET, method: "GET", scope: "servers:read", status: 200 },
  { label: "POST /sync/cancel", handler: syncCancel.POST, method: "POST", scope: "sync:write", body: {}, status: 400 },
  { label: "POST /jobs/sync", handler: jobSync.POST, method: "POST", scope: "sync:write", status: 202 },
  { label: "POST /jobs/detection", handler: jobDetection.POST, method: "POST", scope: "lifecycle:write", status: 202 },
  { label: "POST /jobs/execution", handler: jobExecution.POST, method: "POST", scope: "lifecycle:execute", status: 202 },
  { label: "GET /media/movies", handler: movies.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/series", handler: series.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/series/grouped", handler: seriesGrouped.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/series/seasons", handler: seriesSeasons.GET, method: "GET", scope: "media:read", status: 400 },
  { label: "GET /media/music", handler: music.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/music/grouped", handler: musicGrouped.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/music/albums", handler: musicAlbums.GET, method: "GET", scope: "media:read", status: 400 },
  { label: "GET /media/search", handler: search.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/recently-added", handler: recentlyAdded.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/stats", handler: mediaStats.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/history", handler: history.GET, method: "GET", scope: "media:read", status: 200 },
  { label: "GET /media/[id]", handler: mediaItem.GET, method: "GET", scope: "media:read", params: { id: "missing" }, status: 404 },
  { label: "GET /media/[id]/plays", handler: mediaPlays.GET, method: "GET", scope: "media:read", params: { id: "missing" }, status: 404 },
  { label: "GET /media/[id]/image", handler: mediaImage.GET, method: "GET", scope: "media:read", params: { id: "missing" }, status: 404 },
  { label: "GET /lifecycle/rules", handler: rules.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "GET /lifecycle/rules/matches", handler: ruleMatches.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "POST /lifecycle/rules/run", handler: ruleRun.POST, method: "POST", scope: "lifecycle:write", body: {}, status: 200 },
  { label: "GET /lifecycle/actions", handler: actions.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "POST /lifecycle/actions/execute", handler: actionsExecute.POST, method: "POST", scope: "lifecycle:execute", body: {}, status: 400 },
  { label: "GET /lifecycle/exceptions", handler: exceptions.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "POST /lifecycle/exceptions", handler: exceptions.POST, method: "POST", scope: "lifecycle:write", body: {}, status: 400 },
  { label: "DELETE /lifecycle/exceptions", handler: exceptions.DELETE, method: "DELETE", scope: "lifecycle:write", body: {}, status: 400 },
  { label: "DELETE /lifecycle/exceptions/[id]", handler: exceptionById.DELETE, method: "DELETE", scope: "lifecycle:write", params: { id: "missing" }, status: 404 },
  { label: "GET /lifecycle/stats", handler: lifecycleStats.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "GET /tools/sessions", handler: sessions.GET, method: "GET", scope: "streams:read", status: 200 },
  { label: "POST /tools/sessions/terminate", handler: terminate.POST, method: "POST", scope: "streams:write", body: {}, status: 400 },
  { label: "GET /tools/maintenance", handler: maintenance.GET, method: "GET", scope: "streams:read", status: 200 },
  { label: "PUT /tools/maintenance", handler: maintenance.PUT, method: "PUT", scope: "streams:write", body: {}, status: 400 },
];

let ipCounter = 0;
function call(route: RouteCase, headers: Record<string, string>, overrides: { body?: unknown; url?: string } = {}) {
  const options = {
    method: route.method,
    body: overrides.body ?? route.body,
    url: overrides.url,
    headers: { "x-forwarded-for": `10.40.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...headers },
  };
  return callRouteWithParams(route.handler as Handler, route.params ?? {}, options);
}

/** Every scope except `scope` and the write scopes that would imply it. */
function everythingBut(scope: ApiScope): ApiScope[] {
  return API_SCOPES.filter((s) => s !== scope && !(API_SCOPE_INFO[s].implies ?? []).includes(scope));
}

async function setupUser() {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id } });
  return user;
}

describe("/api/v1 endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockEnqueueJob.mockResolvedValue(true);
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  describe.each(ROUTES)("$label", (route) => {
    it("401 without a key", async () => {
      await expectJson(await call(route, {}), 401);
    });

    it.skipIf(route.scope === null)("403 for a key with every scope but this one", async () => {
      const user = await setupUser();
      const { key } = await createTestApiKey(user.id, { scopes: everythingBut(route.scope!) });
      const body = await expectJson<{ requiredScope: string }>(
        await call(route, { authorization: `Bearer ${key}` }),
        403,
      );
      expect(body.requiredScope).toBe(route.scope);
    });

    it(`runs the handler as the key's owner (→ ${route.status})`, async () => {
      const user = await setupUser();
      const { key } = await createTestApiKey(user.id, {
        scopes: route.scope ? [route.scope] : ["system:read"],
      });
      const res = await call(route, { authorization: `Bearer ${key}` });
      expect(res.status).toBe(route.status);
    });
  });

  describe("behaviour through the API", () => {
    it("GET /media/movies answers exactly what the app's own route answers", async () => {
      const user = await setupUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      await createTestMediaItem(library.id, { title: "Arrival", year: 2016 });
      await createTestMediaItem(library.id, { title: "Blade Runner 2049", year: 2017 });
      const { key } = await createTestApiKey(user.id, { scopes: ["media:read"] });

      const route = ROUTES.find((r) => r.label === "GET /media/movies")!;
      const viaApi = await expectJson<{ items: Array<{ title: string }> }>(
        await call(route, { authorization: `Bearer ${key}` }, { url: "/api/v1/media/movies?sortBy=title" }),
        200,
      );
      expect(viaApi.items.map((i) => i.title)).toEqual(["Arrival", "Blade Runner 2049"]);

      setMockSession({ isLoggedIn: true, userId: user.id });
      const viaApp = await expectJson(
        await callRoute(appMoviesGET, { url: "/api/media/movies?sortBy=title" }),
        200,
      );
      expect(viaApi).toEqual(viaApp);
    });

    it("POST /jobs/sync queues a sync per enabled server, attributed to the key", async () => {
      const user = await setupUser();
      const enabled = await createTestServer(user.id, { name: "Enabled" });
      await createTestServer(user.id, { name: "Disabled", enabled: false });
      const { key } = await createTestApiKey(user.id, { name: "n8n", scopes: ["sync:write"] });

      const route = ROUTES.find((r) => r.label === "POST /jobs/sync")!;
      const body = await expectJson<{ queued: boolean }>(await call(route, { authorization: `Bearer ${key}` }), 202);
      expect(body.queued).toBe(true);
      expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_SYNC_SERVER,
        { serverId: enabled.id, trigger: 'manual sync via API key "n8n"' },
        expect.objectContaining({ jobKey: `sync:${enabled.id}` }),
      );
      const settings = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(settings.lastScheduledSync).not.toBeNull();
    });

    it("POST /jobs/detection and /jobs/execution queue their lifecycle jobs", async () => {
      const user = await setupUser();
      const { key } = await createTestApiKey(user.id, { scopes: ["lifecycle:write", "lifecycle:execute"] });

      await expectJson(await call(ROUTES.find((r) => r.label === "POST /jobs/detection")!, { authorization: `Bearer ${key}` }), 202);
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_LIFECYCLE_DETECTION,
        { userId: user.id },
        expect.objectContaining({ jobKey: `detection:${user.id}` }),
      );

      await expectJson(await call(ROUTES.find((r) => r.label === "POST /jobs/execution")!, { authorization: `Bearer ${key}` }), 202);
      expect(mockEnqueueJob).toHaveBeenCalledWith(
        TASK_LIFECYCLE_EXECUTION,
        { userId: user.id },
        expect.objectContaining({ jobKey: `execution:${user.id}`, maxAttempts: 1 }),
      );
    });

    it("POST /jobs/* reports a failed enqueue as 500", async () => {
      const user = await setupUser();
      const { key } = await createTestApiKey(user.id, { scopes: ["lifecycle:write"] });
      mockEnqueueJob.mockResolvedValueOnce(false);
      const body = await expectJson<{ error: string }>(
        await call(ROUTES.find((r) => r.label === "POST /jobs/detection")!, { authorization: `Bearer ${key}` }),
        500,
      );
      expect(body.error).toMatch(/enqueue/);
    });

    it("a lifecycle:write key can add and remove an exception", async () => {
      const user = await setupUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { title: "Keep Me" });
      const { key } = await createTestApiKey(user.id, { scopes: ["lifecycle:write"] });
      const auth = { authorization: `Bearer ${key}` };

      const created = await call(ROUTES.find((r) => r.label === "POST /lifecycle/exceptions")!, auth, {
        body: { mediaItemId: movie.id, reason: "Family favourite" },
      });
      expect(created.status).toBeLessThan(300);
      const exception = await prisma.lifecycleException.findFirstOrThrow({ where: { mediaItemId: movie.id } });
      expect(exception.reason).toBe("Family favourite");

      const deleteById = ROUTES.find((r) => r.label === "DELETE /lifecycle/exceptions/[id]")!;
      await expectJson(await call({ ...deleteById, params: { id: exception.id } }, auth), 200);
      expect(await prisma.lifecycleException.count()).toBe(0);
    });

    it("a streams:write key can switch maintenance mode on", async () => {
      const user = await setupUser();
      const { key } = await createTestApiKey(user.id, { scopes: ["streams:write"] });
      const body = await expectJson<{ enabled: boolean; message: string }>(
        await call(ROUTES.find((r) => r.label === "PUT /tools/maintenance")!, { authorization: `Bearer ${key}` }, {
          body: { enabled: true, message: "Back soon" },
        }),
        200,
      );
      expect(body).toMatchObject({ enabled: true, message: "Back soon" });
      const settings = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(settings.maintenanceMode).toBe(true);
    });
  });
});
