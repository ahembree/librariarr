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

vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockSeerrTestConnection };
  }),
}));

import { GET } from "@/app/api/integrations/health/route";
import { appCache } from "@/lib/cache/memory-cache";
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
    await expectJson(res, 401);
  });

  it("returns empty health when no integrations are configured", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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
    await createTestRadarrInstance(user.id, { name: "My Radarr" });
    await createTestSonarrInstance(user.id, { name: "My Sonarr" });
    await createTestSeerrInstance(user.id, { name: "My Seerr" });
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockRadarrTestConnection.mockResolvedValue({ ok: true, appName: "Radarr" });
    mockSonarrTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr" });
    mockSeerrTestConnection.mockResolvedValue({ ok: true, appName: "Overseerr" });

    const data = await getHealth();

    expect(data.sonarr.configured).toBe(1);
    expect(data.sonarr.reachable).toBe(1);
    expect(data.radarr.configured).toBe(1);
    expect(data.radarr.reachable).toBe(1);
    expect(data.seerr.configured).toBe(1);
    expect(data.seerr.reachable).toBe(1);
    expect(data.arrAnyReachable).toBe(true);
  });

  it("reports unreachable instance with the error message", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id, { name: "My Radarr" });
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

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
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockSonarrTestConnection.mockRejectedValue(new Error("Connection timeout"));

    const data = await getHealth();

    expect(data.sonarr.instances[0]).toMatchObject({
      name: "My Sonarr",
      reachable: false,
      error: "Connection timeout",
    });
  });

  it("arrAnyReachable=true when at least one of sonarr/radarr/lidarr is reachable", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id);
    await createTestSonarrInstance(user.id);
    await createTestLidarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockRadarrTestConnection.mockResolvedValue({ ok: false, error: "down" });
    mockSonarrTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr" });
    mockLidarrTestConnection.mockResolvedValue({ ok: false, error: "down" });

    const data = await getHealth();

    expect(data.arrAnyReachable).toBe(true);
  });

  it("excludes disabled instances entirely", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id, { name: "Disabled", enabled: false });
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const data = await getHealth();

    expect(data.radarr.configured).toBe(0);
    expect(mockRadarrTestConnection).not.toHaveBeenCalled();
  });

  it("isolates one user's instances from another's", async () => {
    const u1 = await createTestUser({ plexId: "user1" });
    const u2 = await createTestUser({ plexId: "user2" });
    await createTestRadarrInstance(u1.id, { name: "U1 Radarr" });
    await createTestRadarrInstance(u2.id, { name: "U2 Radarr" });

    mockRadarrTestConnection.mockResolvedValue({ ok: true, appName: "Radarr" });

    setMockSession({ isLoggedIn: true, userId: u1.id, plexToken: "tok" });
    const data = await getHealth();

    expect(data.radarr.configured).toBe(1);
    expect(data.radarr.instances[0].name).toBe("U1 Radarr");
  });

  it("caches results for repeated calls within the TTL window", async () => {
    const user = await createTestUser();
    await createTestRadarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockRadarrTestConnection.mockResolvedValue({ ok: true, appName: "Radarr" });

    await callRoute(GET);
    await callRoute(GET);
    await callRoute(GET);

    expect(mockRadarrTestConnection).toHaveBeenCalledTimes(1);
  });
});
