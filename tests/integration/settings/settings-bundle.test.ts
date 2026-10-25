import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser, createTestServer } from "../../setup/test-helpers";

const failing = vi.hoisted(() => ({ titlePreference: false }));

// The backup listing reads BACKUP_DIR once, when the service loads, and the
// default `/config/backups` is not writable on every machine the suite runs on.
await vi.hoisted(async () => {
  const fs = await import("fs/promises");
  const os = await import("os");
  const path = await import("path");
  process.env.BACKUP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-settings-bundle-"));
});

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/api/settings/title-preference/route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/settings/title-preference/route")>();
  return {
    ...actual,
    GET: async () => {
      if (failing.titlePreference) throw new Error("boom");
      return actual.GET();
    },
  };
});

// Import AFTER mocks
import { GET } from "@/app/api/settings/bundle/route";
import { SETTINGS_BUNDLE_PATHS, type BundledResponse } from "@/lib/settings/settings-bundle-paths";
import { GET as getServers } from "@/app/api/servers/route";
import { GET as getDedup } from "@/app/api/settings/dedup/route";
import { GET as getAccentColor } from "@/app/api/settings/accent-color/route";
import { GET as getSonarr } from "@/app/api/integrations/sonarr/route";
import { GET as getDiscord } from "@/app/api/settings/discord/route";
import { GET as getAuth } from "@/app/api/settings/auth/route";
import { GET as getDeleteCeiling } from "@/app/api/settings/delete-ceiling/route";

const prisma = getTestPrisma();
const ALL = SETTINGS_BUNDLE_PATHS.join(",");
const bundle = (paths: string) => callRoute(GET, { url: `/api/settings/bundle?paths=${encodeURIComponent(paths)}` });
type Parts = { parts: Record<string, BundledResponse> };

describe("GET /api/settings/bundle", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    failing.titlePreference = false;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    await expectJson(await bundle("/api/settings/dedup"), 401);
  });

  it("refuses no paths and a route outside the bundle", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await expectJson(await callRoute(GET, { url: "/api/settings/bundle" }), 400);
    const body = await expectJson<{ error: string }>(await bundle("/api/settings/dedup,/api/auth/me"), 400);
    expect(body.error).toContain("/api/auth/me");
  });

  it("answers every bundled route on a first visit with no settings row", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await bundle(ALL);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { parts } = await expectJson<Parts>(res);
    expect(Object.keys(parts).sort()).toEqual([...SETTINGS_BUNDLE_PATHS].sort());
    for (const path of SETTINGS_BUNDLE_PATHS) {
      expect(parts[path].status, path).toBe(200);
    }
    expect(await prisma.appSettings.count({ where: { userId: user.id } })).toBe(1);
  });

  it("answers each route exactly as the route itself does", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await createTestServer(user.id, { name: "Home" });
    await prisma.appSettings.create({ data: { userId: user.id, accentColor: "violet", maxAutoDeleteItems: 25 } });

    const { parts } = await expectJson<Parts>(await bundle(ALL));
    const direct: [string, () => Promise<Response>][] = [
      ["/api/servers", () => getServers()],
      ["/api/settings/dedup", () => getDedup()],
      ["/api/settings/accent-color", () => getAccentColor()],
      ["/api/integrations/sonarr", () => getSonarr()],
      ["/api/settings/discord", () => getDiscord()],
      ["/api/settings/auth", () => getAuth()],
      ["/api/settings/delete-ceiling", () => getDeleteCeiling()],
    ];
    for (const [path, call] of direct) {
      const res = await call();
      expect(parts[path], path).toEqual({ status: res.status, body: await res.json() });
    }
    expect(parts["/api/settings/accent-color"].body).toMatchObject({ accentColor: "violet" });
  });

  it("answers only the paths asked for", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const { parts } = await expectJson<Parts>(await bundle("/api/settings/dedup,/api/settings/dedup,/api/servers"));
    expect(Object.keys(parts).sort()).toEqual(["/api/servers", "/api/settings/dedup"]);
  });

  it("isolates a handler that throws", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    failing.titlePreference = true;
    const { parts } = await expectJson<Parts>(await bundle("/api/settings/title-preference,/api/settings/dedup"));
    expect(parts["/api/settings/title-preference"]).toEqual({ status: 500, body: { error: "Internal server error" } });
    expect(parts["/api/settings/dedup"].status).toBe(200);
  });
});
