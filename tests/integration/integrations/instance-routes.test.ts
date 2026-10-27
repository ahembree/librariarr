/**
 * The integration instance routes, built for every type by one definition
 * (`src/lib/integrations/instance-routes.ts`): what used to differ between the
 * five copies now holds for all of them, and the combined instances listing.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestRadarrInstance,
  createTestSonarrInstance,
  createTestLidarrInstance,
  createTestSeerrInstance,
  createTestTracearrInstance,
} from "../../setup/test-helpers";
import { MASKED_VALUE } from "@/lib/api/sanitize";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { clients, testResult, seerrUsers } = vi.hoisted(() => ({
  /** Every client built: its URL and key. */
  clients: [] as { url: string; apiKey: string }[],
  testResult: { current: { ok: true } as { ok: boolean; error?: string } },
  /** Seerr users per instance URL; a URL missing here fails. */
  seerrUsers: new Map<string, string[]>(),
}));

function fakeClient(url: string, apiKey: string) {
  clients.push({ url, apiKey });
  return {
    testConnection: vi.fn(async () => testResult.current),
    getUsers: vi.fn(async () => {
      const users = seerrUsers.get(url);
      if (!users) throw new Error("connect ECONNREFUSED 10.0.0.9:5055");
      return { pageInfo: { pages: 1, page: 1, results: users.length }, results: users.map((username, id) => ({ id, username })) };
    }),
  };
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

import * as radarr from "@/app/api/integrations/radarr/route";
import * as radarrItem from "@/app/api/integrations/radarr/[id]/route";
import * as radarrTest from "@/app/api/integrations/radarr/[id]/test-connection/route";
import * as sonarr from "@/app/api/integrations/sonarr/route";
import * as sonarrItem from "@/app/api/integrations/sonarr/[id]/route";
import * as sonarrTest from "@/app/api/integrations/sonarr/[id]/test-connection/route";
import * as lidarr from "@/app/api/integrations/lidarr/route";
import * as lidarrItem from "@/app/api/integrations/lidarr/[id]/route";
import * as lidarrTest from "@/app/api/integrations/lidarr/[id]/test-connection/route";
import * as seerr from "@/app/api/integrations/seerr/route";
import * as seerrItem from "@/app/api/integrations/seerr/[id]/route";
import * as seerrTest from "@/app/api/integrations/seerr/[id]/test-connection/route";
import * as tracearr from "@/app/api/integrations/tracearr/route";
import * as tracearrItem from "@/app/api/integrations/tracearr/[id]/route";
import * as tracearrTest from "@/app/api/integrations/tracearr/[id]/test-connection/route";
import { GET as instancesGET } from "@/app/api/integrations/instances/route";

const prisma = getTestPrisma();

type Handler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;
interface TypeCase {
  label: string;
  model: "radarrInstance" | "sonarrInstance" | "lidarrInstance" | "seerrInstance" | "tracearrInstance";
  create: (userId: string, overrides?: { url?: string; enabled?: boolean }) => Promise<{ id: string; url: string; apiKey: string }>;
  list: () => Promise<Response>;
  put: Handler;
  test: Handler;
}

const TYPES: TypeCase[] = [
  { label: "Radarr", model: "radarrInstance", create: createTestRadarrInstance, list: () => radarr.GET(), put: radarrItem.PUT, test: radarrTest.POST },
  { label: "Sonarr", model: "sonarrInstance", create: createTestSonarrInstance, list: () => sonarr.GET(), put: sonarrItem.PUT, test: sonarrTest.POST },
  { label: "Lidarr", model: "lidarrInstance", create: createTestLidarrInstance, list: () => lidarr.GET(), put: lidarrItem.PUT, test: lidarrTest.POST },
  { label: "Seerr", model: "seerrInstance", create: createTestSeerrInstance, list: () => seerr.GET(), put: seerrItem.PUT, test: seerrTest.POST },
  { label: "Tracearr", model: "tracearrInstance", create: createTestTracearrInstance, list: () => tracearr.GET(), put: tracearrItem.PUT, test: tracearrTest.POST },
];

/** The five instance models share the columns these read and write. */
const delegate = (model: TypeCase["model"]) =>
  prisma[model] as unknown as {
    findUnique(args: unknown): Promise<{ apiKey: string } | null>;
    update(args: unknown): Promise<unknown>;
  };

async function storedKey(model: TypeCase["model"], id: string): Promise<string | undefined> {
  return (await delegate(model).findUnique({ where: { id } }))?.apiKey;
}

describe("integration instance routes", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    clients.length = 0;
    testResult.current = { ok: true };
    seerrUsers.clear();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe.each(TYPES)("$label", (type) => {
    it("keeps the stored key when the form echoes the mask back, and tests nothing", async () => {
      const instance = await type.create(userId);
      const body = await expectJson<{ instance: { name: string; apiKey: string } }>(
        await callRouteWithParams(type.put, { id: instance.id }, { method: "PUT", body: { name: "Renamed", apiKey: MASKED_VALUE } }),
        200,
      );
      expect(body.instance).toMatchObject({ name: "Renamed", apiKey: MASKED_VALUE });
      expect(clients).toEqual([]);
      expect(await storedKey(type.model, instance.id)).toBe(instance.apiKey);
    });

    it("never stores the mask as the key, even when the instance is turned off in the same save", async () => {
      const instance = await type.create(userId);
      await expectJson(
        await callRouteWithParams(type.put, { id: instance.id }, { method: "PUT", body: { enabled: false, apiKey: MASKED_VALUE } }),
        200,
      );
      expect(await storedKey(type.model, instance.id)).toBe(instance.apiKey);
    });

    it("re-tests a saved instance with its stored key when the mask comes back", async () => {
      const instance = await type.create(userId);
      const body = await expectJson<{ ok: boolean }>(
        await callRouteWithParams(type.test, { id: instance.id }, { method: "POST", body: { apiKey: MASKED_VALUE } }),
        200,
      );
      expect(body.ok).toBe(true);
      expect(clients).toEqual([{ url: instance.url, apiKey: instance.apiKey }]);
    });

    it(`names ${type.label} when an edit's connection test fails`, async () => {
      const instance = await type.create(userId);
      testResult.current = { ok: false, error: "connect ECONNREFUSED 10.0.0.9:80" };
      const body = await expectJson<{ error: string; detail: string }>(
        await callRouteWithParams(type.put, { id: instance.id }, { method: "PUT", body: { apiKey: "new-key" } }),
        400,
      );
      expect(body).toEqual({ error: `Failed to connect to ${type.label}`, detail: "connect ECONNREFUSED [internal]:80" });
      expect(await storedKey(type.model, instance.id)).toBe(instance.apiKey);
    });

    it("lists its instances masked, newest first, from a handler called with no arguments", async () => {
      const older = await type.create(userId, { url: "http://older.test" });
      const newer = await type.create(userId, { url: "http://newer.test" });
      await delegate(type.model).update({ where: { id: older.id }, data: { createdAt: new Date("2024-01-01") } });
      const body = await expectJson<{ instances: { id: string; apiKey: string }[] }>(await type.list(), 200);
      expect(body.instances.map((i) => i.id)).toEqual([newer.id, older.id]);
      expect(body.instances.every((i) => i.apiKey === MASKED_VALUE)).toBe(true);
    });
  });

  describe("GET /api/integrations/instances", () => {
    it("answers every type's list exactly as its own route does", async () => {
      await createTestRadarrInstance(userId);
      await createTestSonarrInstance(userId);
      await createTestSeerrInstance(userId, { enabled: false });
      await createTestTracearrInstance(userId);

      const combined = await expectJson<Record<string, unknown>>(await callRoute(instancesGET, { url: "/api/integrations/instances" }), 200);
      expect(Object.keys(combined)).toEqual(["sonarr", "radarr", "lidarr", "seerr", "tracearr"]);
      for (const [key, list] of [["radarr", radarr], ["sonarr", sonarr], ["lidarr", lidarr], ["seerr", seerr], ["tracearr", tracearr]] as const) {
        const own = await expectJson<{ instances: unknown[] }>(await list.GET(), 200);
        expect(combined[key], key).toEqual(own.instances);
      }
      expect(combined.seerrUsers).toBeUndefined();
    });

    it("adds every enabled Seerr instance's requesters with withMetadata=1, read through the metadata cache", async () => {
      const a = await createTestSeerrInstance(userId, { url: "http://seerr-a.test" });
      const b = await createTestSeerrInstance(userId, { url: "http://seerr-b.test" });
      await createTestSeerrInstance(userId, { url: "http://seerr-off.test", enabled: false });
      await createTestSeerrInstance(userId, { url: "http://seerr-down.test" });
      seerrUsers.set(a.url, ["zoe", "amy"]);
      seerrUsers.set(b.url, ["amy", "bob"]);
      seerrUsers.set("http://seerr-off.test", ["hidden"]);

      const read = async () =>
        expectJson<{ seerrUsers: string[] }>(
          await callRoute(instancesGET, { url: "/api/integrations/instances", searchParams: { withMetadata: "1" } }),
          200,
        );
      // An instance that cannot be read adds no names; a disabled one is not asked.
      expect((await read()).seerrUsers).toEqual(["amy", "bob", "zoe"]);
      expect(clients.map((c) => c.url).sort()).toEqual(["http://seerr-a.test", "http://seerr-b.test", "http://seerr-down.test"]);

      // The answers are kept (the failure is not): only the failing instance is asked again.
      await read();
      expect(clients.map((c) => c.url).sort()).toEqual([
        "http://seerr-a.test", "http://seerr-b.test", "http://seerr-down.test", "http://seerr-down.test",
      ]);
    });

    it("answers 401 without a session", async () => {
      clearMockSession();
      await expectJson(await callRoute(instancesGET, { url: "/api/integrations/instances" }), 401);
    });
  });
});
