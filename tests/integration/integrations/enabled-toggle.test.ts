import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestSonarrInstance,
  createTestSeerrInstance,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTestConnection = vi.fn();

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockTestConnection };
  }),
}));

vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockTestConnection };
  }),
}));

// Import route handlers AFTER mocks
import { GET as SonarrGET } from "@/app/api/integrations/sonarr/route";
import { PUT as SonarrPUT } from "@/app/api/integrations/sonarr/[id]/route";
import { GET as SeerrGET } from "@/app/api/integrations/seerr/route";
import { PUT as SeerrPUT } from "@/app/api/integrations/seerr/[id]/route";

describe("Integration enable/disable toggle", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- Sonarr -----

  describe("Sonarr enable/disable", () => {
    it("disables a Sonarr instance", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SonarrPUT,
        { id: instance.id },
        { url: `/api/integrations/sonarr/${instance.id}`, method: "PUT", body: { enabled: false } }
      );
      const body = await expectJson<{ instance: { id: string; enabled: boolean } }>(response, 200);
      expect(body.instance.enabled).toBe(false);

      // Verify in DB
      const updated = await prisma.sonarrInstance.findUnique({ where: { id: instance.id } });
      expect(updated!.enabled).toBe(false);
    });

    it("re-enables a disabled Sonarr instance", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id, { enabled: false });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SonarrPUT,
        { id: instance.id },
        { url: `/api/integrations/sonarr/${instance.id}`, method: "PUT", body: { enabled: true } }
      );
      const body = await expectJson<{ instance: { id: string; enabled: boolean } }>(response, 200);
      expect(body.instance.enabled).toBe(true);
    });

    it("skips connection test when disabling", async () => {
      const user = await createTestUser();
      const instance = await createTestSonarrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      // Disable without triggering connection test
      const response = await callRouteWithParams(
        SonarrPUT,
        { id: instance.id },
        { url: `/api/integrations/sonarr/${instance.id}`, method: "PUT", body: { enabled: false } }
      );
      const body = await expectJson<{ instance: { id: string; enabled: boolean } }>(response, 200);
      expect(body.instance.enabled).toBe(false);
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("returns disabled instances in GET", async () => {
      const user = await createTestUser();
      await createTestSonarrInstance(user.id, { name: "Active", enabled: true });
      await createTestSonarrInstance(user.id, { name: "Inactive", enabled: false });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(SonarrGET, { url: "/api/integrations/sonarr" });
      const body = await expectJson<{ instances: { name: string; enabled: boolean }[] }>(response, 200);
      expect(body.instances).toHaveLength(2);
      expect(body.instances.find((i) => i.name === "Active")!.enabled).toBe(true);
      expect(body.instances.find((i) => i.name === "Inactive")!.enabled).toBe(false);
    });
  });

  // ----- Seerr -----

  describe("Seerr enable/disable", () => {
    it("disables a Seerr instance", async () => {
      const user = await createTestUser();
      const instance = await createTestSeerrInstance(user.id);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRouteWithParams(
        SeerrPUT,
        { id: instance.id },
        { url: `/api/integrations/seerr/${instance.id}`, method: "PUT", body: { enabled: false } }
      );
      const body = await expectJson<{ instance: { id: string; enabled: boolean } }>(response, 200);
      expect(body.instance.enabled).toBe(false);
    });

    it("returns disabled Seerr instances in GET", async () => {
      const user = await createTestUser();
      await createTestSeerrInstance(user.id, { name: "Active", enabled: true });
      await createTestSeerrInstance(user.id, { name: "Inactive", enabled: false });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(SeerrGET, { url: "/api/integrations/seerr" });
      const body = await expectJson<{ instances: { name: string; enabled: boolean }[] }>(response, 200);
      expect(body.instances).toHaveLength(2);
    });
  });
});
