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
import * as openapi from "@/app/api/v1/openapi.json/route";
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
import * as actions from "@/app/api/v1/lifecycle/actions/route";
import * as actionsExecute from "@/app/api/v1/lifecycle/actions/execute/route";
import * as exceptions from "@/app/api/v1/lifecycle/exceptions/route";
import * as exceptionById from "@/app/api/v1/lifecycle/exceptions/[id]/route";
import * as lifecycleStats from "@/app/api/v1/lifecycle/stats/route";
import * as sessions from "@/app/api/v1/tools/sessions/route";
import * as terminate from "@/app/api/v1/tools/sessions/terminate/route";
import * as maintenance from "@/app/api/v1/tools/maintenance/route";
import { GET as appMoviesGET } from "@/app/api/media/movies/route";
import { GET as appServersGET } from "@/app/api/servers/route";
import { GET as appMediaItemGET } from "@/app/api/media/[id]/route";
import { GET as appSyncStatusGET } from "@/app/api/sync/status/route";
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
  { label: "GET /openapi.json", handler: openapi.GET, method: "GET", scope: null, status: 200 },
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
  { label: "GET /lifecycle/actions", handler: actions.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "POST /lifecycle/actions/execute", handler: actionsExecute.POST, method: "POST", scope: "lifecycle:execute", body: {}, status: 400 },
  { label: "GET /lifecycle/exceptions", handler: exceptions.GET, method: "GET", scope: "lifecycle:read", status: 200 },
  { label: "POST /lifecycle/exceptions", handler: exceptions.POST, method: "POST", scope: "lifecycle:write", body: {}, status: 400 },
  { label: "DELETE /lifecycle/exceptions", handler: exceptions.DELETE, method: "DELETE", scope: "lifecycle:execute", body: {}, status: 400 },
  { label: "DELETE /lifecycle/exceptions/[id]", handler: exceptionById.DELETE, method: "DELETE", scope: "lifecycle:execute", params: { id: "missing" }, status: 404 },
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

    it("GET /servers omits each server's address, machine id and owner that the app's own route returns", async () => {
      const user = await setupUser();
      const server = await createTestServer(user.id, {
        name: "Home",
        url: "https://192-168-1-5.0123abcd.plex.direct:32400",
        machineId: "machine-home",
      });
      await createTestLibrary(server.id, { type: "MOVIE" });
      await prisma.syncJob.create({
        data: {
          mediaServerId: server.id,
          status: "FAILED",
          completedAt: new Date(),
          error: "HTTP 500 (GET https://192-168-1-5.0123abcd.plex.direct:32400/library/sections): boom",
        },
      });
      const { key } = await createTestApiKey(user.id, { scopes: ["servers:read"] });

      type ServerRow = Record<string, unknown> & { libraries: unknown[]; syncJobs: Array<{ error: string | null }> };
      const viaApi = await expectJson<{ servers: ServerRow[] }>(
        await call(ROUTES.find((r) => r.label === "GET /servers")!, { authorization: `Bearer ${key}` }),
        200,
      );
      expect(viaApi.servers).toHaveLength(1);
      const [row] = viaApi.servers;
      expect(row.name).toBe("Home");
      expect(row.libraries).toHaveLength(1);
      for (const k of ["url", "externalUrl", "machineId", "userId", "accessToken"]) expect(row).not.toHaveProperty(k);
      expect(row.syncJobs[0].error).toBe("HTTP 500 (GET https://[internal]:32400/library/sections): boom");
      expect(JSON.stringify(viaApi)).not.toContain("plex.direct");

      setMockSession({ isLoggedIn: true, userId: user.id });
      const viaApp = await expectJson<{ servers: ServerRow[] }>(await callRoute(appServersGET), 200);
      expect(viaApp.servers[0].url).toBe("https://192-168-1-5.0123abcd.plex.direct:32400");
      expect(viaApp.servers[0].machineId).toBe("machine-home");
      expect(viaApp.servers[0].userId).toBe(user.id);
    });

    it("GET /media/{id} omits the file path and the servers' addresses that the app's own route returns", async () => {
      const user = await setupUser();
      const server = await createTestServer(user.id, { url: "http://10.0.0.5:32400", machineId: "machine-a" });
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const item = await createTestMediaItem(library.id, {
        title: "Arrival",
        year: 2016,
        filePath: "/data/movies/Arrival (2016)/Arrival.mkv",
      });
      const { key } = await createTestApiKey(user.id, { scopes: ["media:read"] });

      type Detail = {
        item: Record<string, unknown> & { library: { mediaServer: Record<string, unknown> } };
        playServers: Array<Record<string, unknown>>;
      };
      const route = { ...ROUTES.find((r) => r.label === "GET /media/[id]")!, params: { id: item.id } };
      const viaApi = await expectJson<Detail>(await call(route, { authorization: `Bearer ${key}` }), 200);
      expect(viaApi.item.title).toBe("Arrival");
      expect(viaApi.item).not.toHaveProperty("filePath");
      expect(viaApi.item.library.mediaServer).toEqual({ id: server.id, name: server.name, type: "PLEX" });
      expect(viaApi.playServers).toHaveLength(1);
      for (const k of ["serverUrl", "externalUrl", "machineId"]) expect(viaApi.playServers[0]).not.toHaveProperty(k);
      expect(viaApi.playServers[0].ratingKey).toBe(item.ratingKey);
      expect(JSON.stringify(viaApi)).not.toContain("10.0.0.5");

      setMockSession({ isLoggedIn: true, userId: user.id });
      const viaApp = await expectJson<Detail>(await callRouteWithParams(appMediaItemGET, { id: item.id }), 200);
      expect(viaApp.item.filePath).toBe("/data/movies/Arrival (2016)/Arrival.mkv");
      expect(viaApp.item.library.mediaServer.url).toBe("http://10.0.0.5:32400");
      expect(viaApp.item.library.mediaServer.machineId).toBe("machine-a");
      expect(viaApp.playServers[0].serverUrl).toBe("http://10.0.0.5:32400");
      expect(viaApp.playServers[0].machineId).toBe("machine-a");
    });

    it("GET /sync/status sanitizes a job's stored error while the app's own route returns it raw", async () => {
      const user = await setupUser();
      const server = await createTestServer(user.id);
      // A row written before the sync engine sanitized on write.
      await prisma.syncJob.create({
        data: {
          mediaServerId: server.id,
          status: "FAILED",
          completedAt: new Date(),
          error: "connect ECONNREFUSED 192.168.1.20:32400",
        },
      });
      const { key } = await createTestApiKey(user.id, { scopes: ["servers:read"] });

      type Status = { jobs: Array<{ error: string | null; mediaServer: Record<string, unknown> }> };
      const viaApi = await expectJson<Status>(
        await call(ROUTES.find((r) => r.label === "GET /sync/status")!, { authorization: `Bearer ${key}` }),
        200,
      );
      expect(viaApi.jobs).toHaveLength(1);
      expect(viaApi.jobs[0].error).toBe("connect ECONNREFUSED [internal]:32400");
      expect(viaApi.jobs[0].mediaServer).toEqual({ name: server.name, type: "PLEX" });

      setMockSession({ isLoggedIn: true, userId: user.id });
      const viaApp = await expectJson<Status>(await callRoute(appSyncStatusGET), 200);
      expect(viaApp.jobs[0].error).toBe("connect ECONNREFUSED 192.168.1.20:32400");
    });

    it("POST /jobs/sync queues a sync per enabled server, attributed to the key", async () => {
      const user = await setupUser();
      const enabled = await createTestServer(user.id, { name: "Enabled" });
      await createTestServer(user.id, { name: "Disabled", enabled: false });
      const { key } = await createTestApiKey(user.id, { name: "n8n", scopes: ["sync:write"] });

      const route = ROUTES.find((r) => r.label === "POST /jobs/sync")!;
      const body = await expectJson(await call(route, { authorization: `Bearer ${key}` }), 202);
      expect(body).toEqual({ queued: true, jobs: 1 });
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

    it("POST /jobs/sync reports a failed enqueue as 500 and leaves the watermark alone", async () => {
      const user = await setupUser();
      await createTestServer(user.id, { name: "Enabled" });
      const { key } = await createTestApiKey(user.id, { scopes: ["sync:write"] });
      mockEnqueueJob.mockResolvedValueOnce(false);
      const body = await expectJson<{ error: string }>(
        await call(ROUTES.find((r) => r.label === "POST /jobs/sync")!, { authorization: `Bearer ${key}` }),
        500,
      );
      expect(body.error).toBe("Failed to enqueue the sync for 1 of 1 server");
      const settings = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(settings.lastScheduledSync).toBeNull();
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

    it("lifecycle:write can add an exception; only lifecycle:execute can remove one", async () => {
      const user = await setupUser();
      const server = await createTestServer(user.id);
      const library = await createTestLibrary(server.id, { type: "MOVIE" });
      const movie = await createTestMediaItem(library.id, { title: "Keep Me" });
      const writer = await createTestApiKey(user.id, { name: "writer", scopes: ["lifecycle:write"] });

      const created = await call(
        ROUTES.find((r) => r.label === "POST /lifecycle/exceptions")!,
        { authorization: `Bearer ${writer.key}` },
        { body: { mediaItemId: movie.id, reason: "Family favourite" } },
      );
      expect(created.status).toBeLessThan(300);
      const exception = await prisma.lifecycleException.findFirstOrThrow({ where: { mediaItemId: movie.id } });
      expect(exception.reason).toBe("Family favourite");

      // Removing the protection is what lets the rules delete the item, so a
      // lifecycle:write key must not be able to — by id or in bulk.
      const deleteById = ROUTES.find((r) => r.label === "DELETE /lifecycle/exceptions/[id]")!;
      const bulkDelete = ROUTES.find((r) => r.label === "DELETE /lifecycle/exceptions")!;
      await expectJson(await call({ ...deleteById, params: { id: exception.id } }, { authorization: `Bearer ${writer.key}` }), 403);
      await expectJson(
        await call(bulkDelete, { authorization: `Bearer ${writer.key}` }, { body: { ids: [exception.id] } }),
        403,
      );
      expect(await prisma.lifecycleException.count()).toBe(1);

      const executor = await createTestApiKey(user.id, { name: "executor", scopes: ["lifecycle:execute"] });
      await expectJson(await call({ ...deleteById, params: { id: exception.id } }, { authorization: `Bearer ${executor.key}` }), 200);
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

    it("PUT /tools/maintenance cannot change who is exempt or whether Discord is told", async () => {
      const user = await setupUser();
      await prisma.appSettings.update({
        where: { userId: user.id },
        data: { discordNotifyMaintenance: true, maintenanceExcludedUsers: ["admin"], maintenanceDelay: 45 },
      });
      const { key } = await createTestApiKey(user.id, { scopes: ["streams:write"] });
      const route = ROUTES.find((r) => r.label === "PUT /tools/maintenance")!;
      const put = (body: unknown) => call(route, { authorization: `Bearer ${key}` }, { body });

      for (const extra of [{ discordNotifyMaintenance: false }, { excludedUsers: [] }]) {
        const refused = await expectJson<{ details: string[] }>(await put({ enabled: true, ...extra }), 400);
        expect(refused.details.join("\n")).toContain(`Unrecognized key: "${Object.keys(extra)[0]}"`);
      }
      await expectJson(await put({ enabled: true, message: "x".repeat(501) }), 400);

      const untouched = await prisma.appSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(untouched).toMatchObject({
        maintenanceMode: false,
        discordNotifyMaintenance: true,
        maintenanceExcludedUsers: ["admin"],
        maintenanceDelay: 45,
      });

      // What a key may change still goes through, and leaves the rest alone.
      const body = await expectJson(await put({ enabled: true, delay: 10 }), 200);
      expect(body).toMatchObject({
        enabled: true,
        delay: 10,
        discordNotifyMaintenance: true,
        excludedUsers: ["admin"],
      });
    });
  });
});
