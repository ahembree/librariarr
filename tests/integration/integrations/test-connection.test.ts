import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
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

// Hoisted mock fns so they can be referenced inside vi.mock() factories
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

// Import route handlers AFTER mocks
import { POST as radarrTestConnection } from "@/app/api/integrations/radarr/[id]/test-connection/route";
import { POST as sonarrTestConnection } from "@/app/api/integrations/sonarr/[id]/test-connection/route";
import { POST as lidarrTestConnection } from "@/app/api/integrations/lidarr/[id]/test-connection/route";
import { POST as seerrTestConnection } from "@/app/api/integrations/seerr/[id]/test-connection/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// Radarr [id]/test-connection
// ---------------------------------------------------------------------------
describe("POST /api/integrations/radarr/[id]/test-connection", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      radarrTestConnection,
      { id: "nonexistent" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent instance", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      radarrTestConnection,
      { id: "nonexistent-id" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 404);
  });

  it("returns success when connection works", async () => {
    const user = await createTestUser();
    const instance = await createTestRadarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockRadarrTestConnection.mockResolvedValue({ ok: true, appName: "Radarr", version: "5.0" });

    const res = await callRouteWithParams(
      radarrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });

  it("returns error when connection fails", async () => {
    const user = await createTestUser();
    const instance = await createTestRadarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockRadarrTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRouteWithParams(
      radarrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean; error: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// Sonarr [id]/test-connection
// ---------------------------------------------------------------------------
describe("POST /api/integrations/sonarr/[id]/test-connection", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      sonarrTestConnection,
      { id: "nonexistent" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent instance", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      sonarrTestConnection,
      { id: "nonexistent-id" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 404);
  });

  it("returns success when connection works", async () => {
    const user = await createTestUser();
    const instance = await createTestSonarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockSonarrTestConnection.mockResolvedValue({ ok: true, appName: "Sonarr", version: "4.0" });

    const res = await callRouteWithParams(
      sonarrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });

  it("returns error when connection fails", async () => {
    const user = await createTestUser();
    const instance = await createTestSonarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockSonarrTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRouteWithParams(
      sonarrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean; error: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// Lidarr [id]/test-connection
// ---------------------------------------------------------------------------
describe("POST /api/integrations/lidarr/[id]/test-connection", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      lidarrTestConnection,
      { id: "nonexistent" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent instance", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      lidarrTestConnection,
      { id: "nonexistent-id" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 404);
  });

  it("returns success when connection works", async () => {
    const user = await createTestUser();
    const instance = await createTestLidarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockLidarrTestConnection.mockResolvedValue({ ok: true, appName: "Lidarr", version: "2.0" });

    const res = await callRouteWithParams(
      lidarrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });

  it("returns error when connection fails", async () => {
    const user = await createTestUser();
    const instance = await createTestLidarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockLidarrTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRouteWithParams(
      lidarrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean; error: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// Seerr [id]/test-connection
// ---------------------------------------------------------------------------
describe("POST /api/integrations/seerr/[id]/test-connection", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      seerrTestConnection,
      { id: "nonexistent" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent instance", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      seerrTestConnection,
      { id: "nonexistent-id" },
      { method: "POST", body: {} }
    );
    await expectJson(res, 404);
  });

  it("returns success when connection works", async () => {
    const user = await createTestUser();
    const instance = await createTestSeerrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockSeerrTestConnection.mockResolvedValue({ ok: true, appName: "Seerr", version: "1.0" });

    const res = await callRouteWithParams(
      seerrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });

  it("returns error when connection fails", async () => {
    const user = await createTestUser();
    const instance = await createTestSeerrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockSeerrTestConnection.mockResolvedValue({ ok: false, error: "Connection refused" });

    const res = await callRouteWithParams(
      seerrTestConnection,
      { id: instance.id },
      { method: "POST", body: {} }
    );
    const body = await expectJson<{ ok: boolean; error: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});
