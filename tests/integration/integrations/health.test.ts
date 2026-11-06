import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestRadarrInstance,
  createTestSonarrInstance,
  createTestLidarrInstance,
  createTestSeerrInstance,
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

const mockRadarrTestConnection = vi.hoisted(() => vi.fn());
const mockSonarrTestConnection = vi.hoisted(() => vi.fn());
const mockLidarrTestConnection = vi.hoisted(() => vi.fn());
const mockSeerrTestConnection = vi.hoisted(() => vi.fn());

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockRadarrTestConnection };
  }),
}));

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockSonarrTestConnection };
  }),
}));

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockLidarrTestConnection };
  }),
}));

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockSeerrTestConnection };
  }),
}));

import { GET } from "@/app/api/integrations/health/route";
import * as sonarrRoutes from "@/app/api/integrations/sonarr/route";
import * as sonarrItem from "@/app/api/integrations/sonarr/[id]/route";
import * as radarrRoutes from "@/app/api/integrations/radarr/route";
import * as radarrItem from "@/app/api/integrations/radarr/[id]/route";
import * as lidarrRoutes from "@/app/api/integrations/lidarr/route";
import * as lidarrItem from "@/app/api/integrations/lidarr/[id]/route";
import * as seerrRoutes from "@/app/api/integrations/seerr/route";
import * as seerrItem from "@/app/api/integrations/seerr/[id]/route";
import * as tracearrItem from "@/app/api/integrations/tracearr/[id]/route";
import { callRouteWithParams, createTestTracearrInstance } from "../../setup/test-helpers";
import { appCache } from "@/lib/cache/memory-cache";
import { INTEGRATIONS_HEALTH_CACHE_KEY } from "@/lib/cache/invalidate";
import { invalidateSeerrCaches } from "@/lib/seerr/request-stats";
import type { IntegrationsHealth } from "@/app/api/integrations/health/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  appCache.clear();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function getHealth(): Promise<IntegrationsHealth> {
  const res = await callRoute(GET);
  return (await expectJson(res, 200)) as IntegrationsHealth;
}

describe("GET /api/integrations/health", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns empty health when no integrations are configured", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const data = await getHealth();

    expect(data).toEqual({
      sonarr: { configured: 0, reachable: 0, instances: [] },
      radarr: { configured: 0, reachable: 0, instances: [] },
      lidarr: { configured: 0, reachable: 0, instances: [] },
      seerr: { configured: 0, reachable: 0, instances: [] },
      arrAnyReachable: false,
    });
  });

  it("reports reachable=true when all configured instances respond ok", async () => {
    const user = await createTestUser();
    const radarr = await createTestRadarrInstance(user.id, { name: "My Radarr" });
    const sonarr = await createTestSonarrInstance(user.id, { name: "My Sonarr" });
    const seerr = await createTestSeerrInstance(user.id, { name: "My Seerr" });
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockRadarrTestConnection.mockResolvedValue({ ok: true, appName: "Radarr", version: "5.14.0.9383" });
    mockSonarrTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr", version: "4.0.11.2680" });
    mockSeerrTestConnection.mockResolvedValue({ ok: true, appName: "Seerr" });

    const data = await getHealth();

    expect(data).toEqual({
      sonarr: {
        configured: 1,
        reachable: 1,
        instances: [{ id: sonarr.id, name: "My Sonarr", reachable: true, error: null }],
      },
      radarr: {
        configured: 1,
        reachable: 1,
        instances: [{ id: radarr.id, name: "My Radarr", reachable: true, error: null }],
      },
      lidarr: { configured: 0, reachable: 0, instances: [] },
      seerr: {
        configured: 1,
        reachable: 1,
        instances: [{ id: seerr.id, name: "My Seerr", reachable: true, error: null }],
      },
      arrAnyReachable: true,
    });
  });

  it("reports unreachable instance with the error message", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id, { name: "My Radarr" });
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockRadarrTestConnection.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });

    const data = await getHealth();

    expect(data.radarr.configured).toBe(1);
    expect(data.radarr.reachable).toBe(0);
    expect(data.radarr.instances[0]).toMatchObject({
      name: "My Radarr",
      reachable: false,
      error: "ECONNREFUSED",
    });
    expect(data.arrAnyReachable).toBe(false);
  });

  it("treats client throws as unreachable rather than 500-ing", async () => {
    const user = await createTestUser();
    await createTestSonarrInstance(user.id, { name: "My Sonarr" });
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockSonarrTestConnection.mockRejectedValue(new Error("Connection timeout"));

    const data = await getHealth();

    expect(data.sonarr.instances[0]).toMatchObject({
      name: "My Sonarr",
      reachable: false,
      error: "Connection timeout",
    });
  });

  it("scrubs private addresses and internal paths from the error text", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id, { name: "My Radarr" });
    await createTestSonarrInstance(user.id, { name: "My Sonarr" });
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockRadarrTestConnection.mockResolvedValue({ ok: false, error: "connect ECONNREFUSED 192.168.1.20:7878" });
    mockSonarrTestConnection.mockRejectedValue(new Error("boom at /app/src/lib/arr/sonarr-client.ts"));

    const data = await getHealth();

    expect(data.radarr.instances[0].error).toBe("connect ECONNREFUSED [internal]:7878");
    expect(data.sonarr.instances[0].error).toBe("boom at [internal]");
  });

  it("arrAnyReachable=true when at least one of sonarr/radarr/lidarr is reachable", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id);
    await createTestSonarrInstance(user.id);
    await createTestLidarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockRadarrTestConnection.mockResolvedValue({ ok: false, error: "down" });
    mockSonarrTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr" });
    mockLidarrTestConnection.mockResolvedValue({ ok: false, error: "down" });

    const data = await getHealth();

    expect(data.arrAnyReachable).toBe(true);
  });

  it("excludes disabled instances entirely", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id, { name: "Disabled", enabled: false });
    setMockSession({ isLoggedIn: true, userId: user.id});

    const data = await getHealth();

    expect(data.radarr.configured).toBe(0);
    expect(mockRadarrTestConnection).not.toHaveBeenCalled();
  });

  it("caches results for repeated calls within the TTL window", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockRadarrTestConnection.mockResolvedValue({ ok: true, appName: "Radarr" });

    await callRoute(GET);
    await callRoute(GET);
    await callRoute(GET);

    expect(mockRadarrTestConnection).toHaveBeenCalledTimes(1);
  });

  // Single admin: one cached answer, under the one key the Seerr instance
  // routes drop (invalidateSeerrCaches) — a per-user key is against the
  // single-user model and lets the two drift apart.
  it("caches its answer under the single shared key the Seerr routes drop", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id, { name: "Seerr" });
    setMockSession({ isLoggedIn: true, userId: user.id});
    mockSeerrTestConnection.mockResolvedValue({ ok: false, error: "down" });

    const first = await getHealth();
    expect(appCache.get(INTEGRATIONS_HEALTH_CACHE_KEY)).toEqual(first);
    expect(appCache.get(`${INTEGRATIONS_HEALTH_CACHE_KEY}:${user.id}`)).toBeUndefined();

    invalidateSeerrCaches();
    expect(appCache.get(INTEGRATIONS_HEALTH_CACHE_KEY)).toBeUndefined();

    mockSeerrTestConnection.mockResolvedValue({ ok: true, appName: "Seerr" });
    const second = await getHealth();
    expect(mockSeerrTestConnection).toHaveBeenCalledTimes(2);
    expect(second.seerr.reachable).toBe(1);
  });

  it("re-checks every instance when asked for fresh=1, bypassing the cached answer", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id, { name: "My Radarr" });
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockRadarrTestConnection.mockResolvedValueOnce({ ok: false, error: "down" });
    const first = await getHealth();
    expect(first.radarr.reachable).toBe(0);

    mockRadarrTestConnection.mockResolvedValueOnce({ ok: true, appName: "Radarr" });
    const res = await callRoute(GET, { url: "/api/integrations/health?fresh=1" });
    const fresh = await expectJson<IntegrationsHealth>(res, 200);

    expect(mockRadarrTestConnection).toHaveBeenCalledTimes(2);
    expect(fresh.radarr.reachable).toBe(1);
    expect(fresh.arrAnyReachable).toBe(true);
  });
});

// Every add, edit and delete of an instance of a type the check probes drops
// the cached answer, so the dashboard strip and the rule editor / Query
// warnings show the change on their next read instead of up to 30 s later.
describe("the next health read after an instance change", () => {
  const TYPES = [
    { label: "sonarr", create: createTestSonarrInstance, routes: sonarrRoutes, item: sonarrItem, test: mockSonarrTestConnection },
    { label: "radarr", create: createTestRadarrInstance, routes: radarrRoutes, item: radarrItem, test: mockRadarrTestConnection },
    { label: "lidarr", create: createTestLidarrInstance, routes: lidarrRoutes, item: lidarrItem, test: mockLidarrTestConnection },
    { label: "seerr", create: createTestSeerrInstance, routes: seerrRoutes, item: seerrItem, test: mockSeerrTestConnection },
  ] as const;

  describe.each(TYPES)("$label", ({ label, create, routes, item, test }) => {
    let userId: string;

    beforeEach(async () => {
      userId = (await createTestUser()).id;
      // A URL change re-sends the stored key, which needs a recent sign-in.
      setMockSession({ isLoggedIn: true, userId, authenticatedAt: Date.now() });
    });

    it("probes again after an edit that fixes the URL", async () => {
      const instance = await create(userId, { name: "Mine", url: "http://wrong.test" });
      test.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
      expect((await getHealth())[label]).toMatchObject({ configured: 1, reachable: 0 });

      test.mockResolvedValue({ ok: true });
      await expectJson(
        await callRouteWithParams(item.PUT, { id: instance.id }, { method: "PUT", body: { url: "http://right.test" } }),
        200,
      );
      expect((await getHealth())[label]).toMatchObject({
        configured: 1,
        reachable: 1,
        instances: [{ id: instance.id, reachable: true, error: null }],
      });
    });

    it("leaves out an instance disabled since the last read", async () => {
      const instance = await create(userId);
      test.mockResolvedValue({ ok: false, error: "down" });
      expect((await getHealth())[label].configured).toBe(1);

      await expectJson(
        await callRouteWithParams(item.PUT, { id: instance.id }, { method: "PUT", body: { enabled: false } }),
        200,
      );
      expect((await getHealth())[label]).toEqual({ configured: 0, reachable: 0, instances: [] });
    });

    it("leaves out an instance deleted since the last read", async () => {
      const instance = await create(userId);
      test.mockResolvedValue({ ok: false, error: "down" });
      expect((await getHealth())[label].configured).toBe(1);

      await expectJson(await callRouteWithParams(item.DELETE, { id: instance.id }, { method: "DELETE" }), 200);
      expect((await getHealth())[label]).toEqual({ configured: 0, reachable: 0, instances: [] });
    });

    it("lists an instance added since the last read", async () => {
      test.mockResolvedValue({ ok: true });
      expect((await getHealth())[label].configured).toBe(0);

      await expectJson(
        await callRoute(routes.POST, { method: "POST", body: { name: "New", url: "http://new.test", apiKey: "key" } }),
        201,
      );
      expect((await getHealth())[label]).toMatchObject({ configured: 1, reachable: 1 });
    });
  });

  it("keeps the cached answer across a Tracearr edit, which the check does not probe", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const tracearr = await createTestTracearrInstance(user.id);
    await getHealth();
    const cached = appCache.get(INTEGRATIONS_HEALTH_CACHE_KEY);
    expect(cached).toBeDefined();

    await expectJson(
      await callRouteWithParams(tracearrItem.PUT, { id: tracearr.id }, { method: "PUT", body: { name: "Renamed" } }),
      200,
    );
    expect(appCache.get(INTEGRATIONS_HEALTH_CACHE_KEY)).toBe(cached);
  });
});
