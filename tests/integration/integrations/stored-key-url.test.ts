import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestRadarrInstance,
  createTestSonarrInstance,
  createTestLidarrInstance,
  createTestSeerrInstance,
  createTestTracearrInstance,
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

// Every client records the (url, key) it was built with — that pair is what
// would go out over the wire.
const built = vi.hoisted(() => [] as Array<{ url: string; key: string }>);
const testResult = vi.hoisted(() => ({ value: { ok: true } as { ok: boolean; error?: string } }));
function fakeClient(url: string, key: string) {
  built.push({ url, key });
  return { testConnection: async () => testResult.value };
}
vi.mock("@/lib/arr/radarr-client", () => ({ RadarrClient: vi.fn().mockImplementation(function (u: string, k: string) { return fakeClient(u, k); }) }));
vi.mock("@/lib/arr/sonarr-client", () => ({ SonarrClient: vi.fn().mockImplementation(function (u: string, k: string) { return fakeClient(u, k); }) }));
vi.mock("@/lib/arr/lidarr-client", () => ({ LidarrClient: vi.fn().mockImplementation(function (u: string, k: string) { return fakeClient(u, k); }) }));
vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function (u: string, k: string) { return fakeClient(u, k); }),
}));
vi.mock("@/lib/tracearr/tracearr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tracearr/tracearr-client")>()),
  TracearrClient: vi.fn().mockImplementation(function (u: string, k: string) { return fakeClient(u, k); }),
}));

import { PUT as radarrPut } from "@/app/api/integrations/radarr/[id]/route";
import { POST as radarrTest } from "@/app/api/integrations/radarr/[id]/test-connection/route";
import { PUT as sonarrPut } from "@/app/api/integrations/sonarr/[id]/route";
import { POST as sonarrTest } from "@/app/api/integrations/sonarr/[id]/test-connection/route";
import { PUT as lidarrPut } from "@/app/api/integrations/lidarr/[id]/route";
import { POST as lidarrTest } from "@/app/api/integrations/lidarr/[id]/test-connection/route";
import { PUT as seerrPut } from "@/app/api/integrations/seerr/[id]/route";
import { POST as seerrTest } from "@/app/api/integrations/seerr/[id]/test-connection/route";
import { PUT as tracearrPut } from "@/app/api/integrations/tracearr/[id]/route";
import { POST as tracearrTest } from "@/app/api/integrations/tracearr/[id]/test-connection/route";

const STALE = Date.now() - 60 * 60 * 1000;
const ATTACKER = "https://attacker.example";

const families = [
  { name: "radarr", create: createTestRadarrInstance, put: radarrPut, test: radarrTest, model: "radarrInstance" },
  { name: "sonarr", create: createTestSonarrInstance, put: sonarrPut, test: sonarrTest, model: "sonarrInstance" },
  { name: "lidarr", create: createTestLidarrInstance, put: lidarrPut, test: lidarrTest, model: "lidarrInstance" },
  { name: "seerr", create: createTestSeerrInstance, put: seerrPut, test: seerrTest, model: "seerrInstance" },
  { name: "tracearr", create: createTestTracearrInstance, put: tracearrPut, test: tracearrTest, model: "tracearrInstance" },
] as const;

describe("an integration's stored API key never goes to a new URL on a stale session", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    built.length = 0;
    testResult.value = { ok: true };
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  for (const fam of families) {
    describe(fam.name, () => {
      it("test-connection refuses a new URL with the stored key, without contacting it", async () => {
        const user = await createTestUser();
        const instance = await fam.create(user.id, { apiKey: "stored-secret" });
        setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: STALE });

        const res = await callRouteWithParams(fam.test, { id: instance.id }, {
          url: `/api/integrations/${fam.name}/${instance.id}/test-connection`,
          method: "POST",
          body: { url: ATTACKER },
        });
        const body = await expectJson<{ code: string }>(res, 403);
        expect(body.code).toBe("reauth_required");
        expect(built).toEqual([]);
      });

      it("PUT refuses a new URL with the stored key and leaves the row unchanged", async () => {
        const user = await createTestUser();
        const instance = await fam.create(user.id, { apiKey: "stored-secret", url: "http://inside:1234" });
        setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: STALE });

        const res = await callRouteWithParams(fam.put, { id: instance.id }, {
          url: `/api/integrations/${fam.name}/${instance.id}`,
          method: "PUT",
          // Disabling skips the connection test: the URL would still be stored.
          body: { url: ATTACKER, enabled: false },
        });
        await expectJson(res, 403);
        expect(built).toEqual([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = await (getTestPrisma() as any)[fam.model].findUnique({ where: { id: instance.id } });
        expect(row.url).toBe("http://inside:1234");
      });

      it("allows a new URL after a recent sign-in", async () => {
        const user = await createTestUser();
        const instance = await fam.create(user.id, { apiKey: "stored-secret" });
        setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });

        const res = await callRouteWithParams(fam.test, { id: instance.id }, {
          url: `/api/integrations/${fam.name}/${instance.id}/test-connection`,
          method: "POST",
          body: { url: "https://moved.example" },
        });
        await expectJson(res, 200);
        expect(built).toEqual([{ url: "https://moved.example", key: "stored-secret" }]);
      });

      it("allows a new URL that comes with its own key, and an unchanged URL, on a stale session", async () => {
        const user = await createTestUser();
        const instance = await fam.create(user.id, { apiKey: "stored-secret", url: "http://inside:1234" });
        setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: STALE });

        const withKey = await callRouteWithParams(fam.test, { id: instance.id }, {
          url: `/api/integrations/${fam.name}/${instance.id}/test-connection`,
          method: "POST",
          body: { url: "https://moved.example", apiKey: "brand-new" },
        });
        await expectJson(withKey, 200);

        const sameUrl = await callRouteWithParams(fam.test, { id: instance.id }, {
          url: `/api/integrations/${fam.name}/${instance.id}/test-connection`,
          method: "POST",
          body: { url: "http://inside:1234/" },
        });
        await expectJson(sameUrl, 200);
        expect(built).toEqual([
          { url: "https://moved.example", key: "brand-new" },
          { url: "http://inside:1234/", key: "stored-secret" },
        ]);
      });

      it("strips internal addresses from a failed test's error", async () => {
        const user = await createTestUser();
        const instance = await fam.create(user.id);
        setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: STALE });
        testResult.value = { ok: false, error: "connect ECONNREFUSED 192.168.1.20:7878" };

        const res = await callRouteWithParams(fam.test, { id: instance.id }, {
          url: `/api/integrations/${fam.name}/${instance.id}/test-connection`,
          method: "POST",
          body: {},
        });
        const body = await expectJson<{ ok: boolean; error: string }>(res, 200);
        expect(body.ok).toBe(false);
        expect(body.error).not.toContain("192.168.1.20");
      });
    });
  }
});
