import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestSonarrInstance,
  createTestLidarrInstance,
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

const { mockSonarrConfig, mockLidarrConfig, sonarrCtor, lidarrCtor } = vi.hoisted(() => ({
  mockSonarrConfig: vi.fn(),
  mockLidarrConfig: vi.fn(),
  sonarrCtor: vi.fn(),
  lidarrCtor: vi.fn(),
}));

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function (url: string, apiKey: string) {
    sonarrCtor(url, apiKey);
    return { getMediaManagementConfig: mockSonarrConfig };
  }),
}));

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function (url: string, apiKey: string) {
    lidarrCtor(url, apiKey);
    return { getMediaManagementConfig: mockLidarrConfig };
  }),
}));

import { GET as SONARR_GET } from "@/app/api/integrations/sonarr/[id]/recycle-bin/route";
import { GET as LIDARR_GET } from "@/app/api/integrations/lidarr/[id]/recycle-bin/route";

type RecycleBinBody = {
  enabled: boolean | null;
  path?: string | null;
  cleanupDays?: number;
  arrUrl: string;
  error?: string;
};

const cases = [
  {
    name: "Sonarr",
    handler: SONARR_GET,
    create: createTestSonarrInstance,
    config: mockSonarrConfig,
    ctor: sonarrCtor,
    model: "sonarrInstance" as const,
  },
  {
    name: "Lidarr",
    handler: LIDARR_GET,
    create: createTestLidarrInstance,
    config: mockLidarrConfig,
    ctor: lidarrCtor,
    model: "lidarrInstance" as const,
  },
];

describe.each(cases)("GET /api/integrations/$name/[id]/recycle-bin", (c) => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(c.handler, { id: "x" });
    const body = await expectJson<{ error: string }>(res, 401);
    expect(body.error).toBe("Unauthorized");
    expect(c.config).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown instance", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const res = await callRouteWithParams(c.handler, { id: "missing" });
    await expectJson(res, 404);
  });

  it("returns 404 for another user's instance", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const instance = await c.create(owner.id);
    setMockSession({ userId: other.id, isLoggedIn: true });
    const res = await callRouteWithParams(c.handler, { id: instance.id });
    await expectJson(res, 404);
    expect(c.config).not.toHaveBeenCalled();
  });

  it("reports an enabled recycle bin with its path and cleanup days", async () => {
    const user = await createTestUser();
    const instance = await c.create(user.id, { url: "http://arr.local:1234", apiKey: "k1" });
    setMockSession({ userId: user.id, isLoggedIn: true });
    c.config.mockResolvedValue({ recycleBin: "/data/recycle", recycleBinCleanupDays: 7 });

    const res = await callRouteWithParams(c.handler, { id: instance.id });
    const body = await expectJson<RecycleBinBody>(res, 200);
    expect(body).toEqual({
      enabled: true,
      path: "/data/recycle",
      cleanupDays: 7,
      arrUrl: "http://arr.local:1234",
    });
    expect(c.ctor).toHaveBeenCalledWith("http://arr.local:1234", "k1");
  });

  it("reports disabled for an empty or whitespace-only path", async () => {
    const user = await createTestUser();
    const instance = await c.create(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    c.config.mockResolvedValueOnce({ recycleBin: "   ", recycleBinCleanupDays: 0 });
    let body = await expectJson<RecycleBinBody>(
      await callRouteWithParams(c.handler, { id: instance.id }),
      200,
    );
    expect(body.enabled).toBe(false);
    expect(body.path).toBe("   ");

    c.config.mockResolvedValueOnce({ recycleBinCleanupDays: 0 });
    body = await expectJson<RecycleBinBody>(
      await callRouteWithParams(c.handler, { id: instance.id }),
      200,
    );
    expect(body.enabled).toBe(false);
    expect(body.path).toBeNull();
  });

  it("prefers the external URL for the browser link", async () => {
    const user = await createTestUser();
    const instance = await c.create(user.id, { url: "http://internal:1" });
    await getTestPrisma()[c.model].update({
      where: { id: instance.id },
      data: { externalUrl: "https://arr.example.com" },
    });
    setMockSession({ userId: user.id, isLoggedIn: true });
    c.config.mockResolvedValue({ recycleBin: "/r", recycleBinCleanupDays: 1 });

    const body = await expectJson<RecycleBinBody>(
      await callRouteWithParams(c.handler, { id: instance.id }),
      200,
    );
    expect(body.arrUrl).toBe("https://arr.example.com");
  });

  it("returns enabled=null with a sanitized error when the app cannot be reached", async () => {
    const user = await createTestUser();
    const instance = await c.create(user.id, { url: "http://internal:1" });
    setMockSession({ userId: user.id, isLoggedIn: true });
    c.config.mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.20:8989"));

    const body = await expectJson<RecycleBinBody>(
      await callRouteWithParams(c.handler, { id: instance.id }),
      200,
    );
    expect(body.enabled).toBeNull();
    expect(body.error).toBeTruthy();
    expect(body.error).not.toContain("192.168.1.20");
    expect(body.arrUrl).toBe("http://internal:1");
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    const user = await createTestUser();
    const instance = await c.create(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });
    c.config.mockRejectedValue("boom");

    const body = await expectJson<RecycleBinBody>(
      await callRouteWithParams(c.handler, { id: instance.id }),
      200,
    );
    expect(body.enabled).toBeNull();
    expect(body.error).toBe(`Failed to query ${c.name}`);
  });
});
