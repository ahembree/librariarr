import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson } from "../../setup/test-helpers";
import type { PlexResource } from "@/lib/plex/types";

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

// Mock Plex auth functions
const { mockGetPlexResources } = vi.hoisted(() => ({
  mockGetPlexResources: vi.fn(),
}));

vi.mock("@/lib/plex/auth", () => ({
  getPlexResources: mockGetPlexResources,
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/auth/plex/servers/route";

function createMockResource(overrides?: Partial<PlexResource>): PlexResource {
  return {
    name: overrides?.name ?? "My Plex Server",
    product: overrides?.product ?? "Plex Media Server",
    productVersion: overrides?.productVersion ?? "1.40.0",
    platform: overrides?.platform ?? "Linux",
    platformVersion: overrides?.platformVersion ?? "22.04",
    device: overrides?.device ?? "PC",
    clientIdentifier: overrides?.clientIdentifier ?? "abc123",
    provides: overrides?.provides ?? "server",
    owned: overrides?.owned ?? true,
    accessToken: overrides?.accessToken ?? "server-access-token",
    publicAddress: overrides?.publicAddress ?? "192.168.1.100",
    httpsRequired: overrides?.httpsRequired ?? false,
    connections: overrides?.connections ?? [
      {
        protocol: "http",
        address: "192.168.1.100",
        port: 32400,
        uri: "http://192.168.1.100:32400",
        local: true,
      },
    ],
  };
}

describe("GET /api/auth/plex/servers", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("should return 401 when not logged in", async () => {
    // Session is not logged in (default after clearMockSession)
    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{ error: string }>(response, 401);

    expect(body.error).toBe("Unauthorized");
    expect(mockGetPlexResources).not.toHaveBeenCalled();
  });

  it("should return 401 when logged in but missing plexToken", async () => {
    setMockSession({
      userId: "user-123",
      isLoggedIn: true,
      // plexToken intentionally omitted
    });

    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{ error: string }>(response, 401);

    expect(body.error).toBe("Unauthorized");
    expect(mockGetPlexResources).not.toHaveBeenCalled();
  });

  it("should return owned servers filtered from resources", async () => {
    setMockSession({
      userId: "user-123",
      plexToken: "valid-plex-token",
      isLoggedIn: true,
    });

    const ownedServer = createMockResource({
      name: "Home Server",
      clientIdentifier: "server-001",
      provides: "server",
      owned: true,
      accessToken: "token-001",
      connections: [
        {
          protocol: "https",
          address: "10.0.0.5",
          port: 32400,
          uri: "https://10.0.0.5:32400",
          local: true,
        },
      ],
    });

    const nonOwnedServer = createMockResource({
      name: "Friend Server",
      provides: "server",
      owned: false,
    });

    const playerDevice = createMockResource({
      name: "Living Room TV",
      provides: "player",
      owned: true,
    });

    mockGetPlexResources.mockResolvedValue([
      ownedServer,
      nonOwnedServer,
      playerDevice,
    ]);

    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{
      servers: Array<{
        name: string;
        clientIdentifier: string;
        product: string;
        productVersion: string;
        platform: string;
        accessToken: string;
        connections: Array<{
          protocol: string;
          address: string;
          port: number;
          uri: string;
          local: boolean;
        }>;
      }>;
    }>(response, 200);

    // Should only include owned servers (not non-owned, not players)
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].name).toBe("Home Server");
    expect(body.servers[0].clientIdentifier).toBe("server-001");
    expect(body.servers[0].accessToken).toBe("token-001");
    expect(body.servers[0].connections).toHaveLength(1);
    expect(body.servers[0].connections[0].uri).toBe("https://10.0.0.5:32400");
  });

  it("should return multiple owned servers", async () => {
    setMockSession({
      userId: "user-456",
      plexToken: "multi-server-token",
      isLoggedIn: true,
    });

    const server1 = createMockResource({
      name: "Primary Server",
      clientIdentifier: "primary-001",
      provides: "server",
      owned: true,
    });

    const server2 = createMockResource({
      name: "Backup Server",
      clientIdentifier: "backup-002",
      provides: "server",
      owned: true,
    });

    mockGetPlexResources.mockResolvedValue([server1, server2]);

    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{
      servers: Array<{ name: string; clientIdentifier: string }>;
    }>(response, 200);

    expect(body.servers).toHaveLength(2);
    expect(body.servers.map((s) => s.name)).toContain("Primary Server");
    expect(body.servers.map((s) => s.name)).toContain("Backup Server");
  });

  it("should return empty servers array when no owned servers exist", async () => {
    setMockSession({
      userId: "user-789",
      plexToken: "no-servers-token",
      isLoggedIn: true,
    });

    const sharedServer = createMockResource({
      name: "Shared Server",
      provides: "server",
      owned: false,
    });

    mockGetPlexResources.mockResolvedValue([sharedServer]);

    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{
      servers: Array<{ name: string }>;
    }>(response, 200);

    expect(body.servers).toHaveLength(0);
  });

  it("should pass the session plexToken to getPlexResources", async () => {
    const plexToken = "specific-token-for-test";
    setMockSession({
      userId: "user-token-test",
      plexToken,
      isLoggedIn: true,
    });

    mockGetPlexResources.mockResolvedValue([]);

    await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    expect(mockGetPlexResources).toHaveBeenCalledWith(plexToken);
  });

  it("should return 500 when getPlexResources throws", async () => {
    setMockSession({
      userId: "user-err",
      plexToken: "error-token",
      isLoggedIn: true,
    });

    mockGetPlexResources.mockRejectedValue(new Error("Network timeout"));

    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{ error: string }>(response, 500);

    expect(body.error).toBe("Failed to fetch servers");
  });

  it("should only return expected fields in server objects", async () => {
    setMockSession({
      userId: "user-fields",
      plexToken: "fields-token",
      isLoggedIn: true,
    });

    const server = createMockResource({
      name: "Field Test Server",
      clientIdentifier: "field-001",
      product: "Plex Media Server",
      productVersion: "1.41.0",
      platform: "Windows",
      accessToken: "field-access-token",
      provides: "server",
      owned: true,
    });

    mockGetPlexResources.mockResolvedValue([server]);

    const response = await callRoute(GET, {
      url: "/api/auth/plex/servers",
      method: "GET",
    });

    const body = await expectJson<{
      servers: Array<Record<string, unknown>>;
    }>(response, 200);

    expect(body.servers).toHaveLength(1);
    const returnedServer = body.servers[0];

    // These fields should be present
    expect(returnedServer).toHaveProperty("name", "Field Test Server");
    expect(returnedServer).toHaveProperty("clientIdentifier", "field-001");
    expect(returnedServer).toHaveProperty("product", "Plex Media Server");
    expect(returnedServer).toHaveProperty("productVersion", "1.41.0");
    expect(returnedServer).toHaveProperty("platform", "Windows");
    expect(returnedServer).toHaveProperty("accessToken", "field-access-token");
    expect(returnedServer).toHaveProperty("connections");

    // These fields from the raw resource should NOT be present
    expect(returnedServer).not.toHaveProperty("device");
    expect(returnedServer).not.toHaveProperty("provides");
    expect(returnedServer).not.toHaveProperty("owned");
    expect(returnedServer).not.toHaveProperty("publicAddress");
    expect(returnedServer).not.toHaveProperty("httpsRequired");
    expect(returnedServer).not.toHaveProperty("platformVersion");
  });
});
