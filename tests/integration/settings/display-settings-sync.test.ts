import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks
import { GET as getShell } from "@/app/api/settings/shell/route";
import { GET as getLayout, PUT as putLayout } from "@/app/api/settings/dashboard-layout/route";
import { GET as getColumns, PUT as putColumns } from "@/app/api/settings/column-preferences/route";
import { PUT as putChipColors } from "@/app/api/settings/chip-colors/route";
import { PUT as putCardDisplay } from "@/app/api/settings/card-display-preferences/route";
import { PUT as putAccent } from "@/app/api/settings/accent-color/route";
import { PUT as putWhatsNew } from "@/app/api/settings/whats-new/route";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";

const prisma = getTestPrisma();

const layoutWith = (id: string) => ({ main: [{ id, size: 12 }], movies: [], series: [], music: [] });

let events: AppEvent[];
let unsubscribe: () => void;
let userId: string;

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  events = [];
  unsubscribe = eventBus.subscribe((e) => events.push(e));
  const user = await createTestUser({ username: "admin" });
  userId = user.id;
  setMockSession({ isLoggedIn: true, userId });
});

afterEach(() => {
  unsubscribe();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await disconnectTestDb();
});

const announced = () => events.filter((e) => e.type === "display-settings:changed" && e.userId === userId);

describe("GET /api/settings/shell", () => {
  it("returns 401 when not authenticated", async () => {
    clearMockSession();
    await expectJson(await callRoute(getShell), 401);
  });

  it("returns 401 for a session whose user is gone", async () => {
    setMockSession({ isLoggedIn: true, userId: "missing-user" });
    await expectJson(await callRoute(getShell), 401);
  });

  it("returns the layout's settings with their revisions, uncached", async () => {
    await prisma.appSettings.create({
      data: {
        userId,
        accentColor: "violet",
        dashboardLayout: layoutWith("genre"),
        dashboardLayoutRevision: 3,
        columnPreferences: { MOVIE: ["title"] },
        columnPreferencesRevision: 5,
      },
    });
    const res = await callRoute(getShell);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await expectJson<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      accentColor: "violet",
      user: { username: "admin", authMethod: "Plex" },
      dashboardLayout: layoutWith("genre"),
      dashboardLayoutRevision: 3,
      columnPreferences: { MOVIE: ["title"] },
      columnPreferencesRevision: 5,
    });
  });

  it("reads a removed accent preset as the default", async () => {
    await prisma.appSettings.create({ data: { userId, accentColor: "blue" } });
    const body = await expectJson<{ accentColor: string }>(await callRoute(getShell));
    expect(body.accentColor).toBe("default");
  });
});

describe("dashboard layout revisions", () => {
  it("returns the revision with the layout", async () => {
    const body = await expectJson<{ layout: unknown; revision: number }>(await callRoute(getLayout));
    expect(body).toEqual({ layout: null, revision: 0 });
  });

  it("saves against the current revision and returns the next one", async () => {
    await prisma.appSettings.create({ data: { userId, dashboardLayoutRevision: 2 } });
    const res = await callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre"), revision: 2 } });
    expect(await expectJson(res)).toEqual({ layout: layoutWith("genre"), revision: 3 });
    const row = await prisma.appSettings.findUnique({ where: { userId } });
    expect(row?.dashboardLayout).toEqual(layoutWith("genre"));
    expect(row?.dashboardLayoutRevision).toBe(3);
    expect(announced()).toHaveLength(1);
  });

  it("refuses a save based on an older revision and keeps the newer layout", async () => {
    await prisma.appSettings.create({
      data: { userId, dashboardLayout: layoutWith("content-rating"), dashboardLayoutRevision: 4 },
    });
    const res = await callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre"), revision: 3 } });
    const body = await expectJson<{ code: string; revision: number; error: string }>(res, 409);
    expect(body.code).toBe("stale_revision");
    expect(body.revision).toBe(4);
    expect(body.error).toMatch(/another tab or on another device/);
    const row = await prisma.appSettings.findUnique({ where: { userId } });
    expect(row?.dashboardLayout).toEqual(layoutWith("content-rating"));
    expect(row?.dashboardLayoutRevision).toBe(4);
    expect(announced()).toHaveLength(0);
  });

  it("refuses the second of two saves based on the same revision", async () => {
    await prisma.appSettings.create({ data: { userId, dashboardLayoutRevision: 1 } });
    const [a, b] = await Promise.all([
      callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre"), revision: 1 } }),
      callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("content-rating"), revision: 1 } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await prisma.appSettings.findUnique({ where: { userId } });
    expect(row?.dashboardLayoutRevision).toBe(2);
  });

  it("saves unconditionally without a revision, still moving it", async () => {
    await prisma.appSettings.create({ data: { userId, dashboardLayoutRevision: 7 } });
    const body = await expectJson<{ revision: number }>(
      await callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre") } }),
    );
    expect(body.revision).toBe(8);
  });

  it("creates the row at revision 1, and refuses a revision the missing row cannot have", async () => {
    const refused = await callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre"), revision: 3 } });
    expect((await expectJson<{ revision: number }>(refused, 409)).revision).toBe(0);

    const body = await expectJson<{ revision: number }>(
      await callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre"), revision: 0 } }),
    );
    expect(body.revision).toBe(1);
  });

  it("rejects a revision that is not a non-negative integer", async () => {
    const res = await callRoute(putLayout, { method: "PUT", body: { layout: layoutWith("genre"), revision: -1 } });
    await expectJson(res, 400);
  });
});

describe("column preference revisions", () => {
  it("returns the revision with the preferences", async () => {
    const body = await expectJson(await callRoute(getColumns));
    expect(body).toEqual({ preferences: null, revision: 0 });
  });

  it("saves one type against the current revision, keeping the others", async () => {
    await prisma.appSettings.create({
      data: { userId, columnPreferences: { SERIES: ["title"] }, columnPreferencesRevision: 1 },
    });
    const res = await callRoute(putColumns, { method: "PUT", body: { type: "MOVIE", columns: ["year"], revision: 1 } });
    expect(await expectJson(res)).toEqual({ success: true, revision: 2 });
    const row = await prisma.appSettings.findUnique({ where: { userId } });
    expect(row?.columnPreferences).toEqual({ SERIES: ["title"], MOVIE: ["year"] });
    expect(announced()).toHaveLength(1);
  });

  it("refuses a save based on an older revision and keeps the stored list", async () => {
    await prisma.appSettings.create({
      data: { userId, columnPreferences: { MOVIE: ["rating"] }, columnPreferencesRevision: 5 },
    });
    const res = await callRoute(putColumns, { method: "PUT", body: { type: "MOVIE", columns: ["year"], revision: 4 } });
    const body = await expectJson<{ code: string; revision: number }>(res, 409);
    expect(body).toMatchObject({ code: "stale_revision", revision: 5 });
    const row = await prisma.appSettings.findUnique({ where: { userId } });
    expect(row?.columnPreferences).toEqual({ MOVIE: ["rating"] });
    expect(announced()).toHaveLength(0);
  });

  it("refuses the second of two saves based on the same revision", async () => {
    await prisma.appSettings.create({ data: { userId, columnPreferencesRevision: 0 } });
    const [a, b] = await Promise.all([
      callRoute(putColumns, { method: "PUT", body: { type: "MOVIE", columns: ["year"], revision: 0 } }),
      callRoute(putColumns, { method: "PUT", body: { type: "SERIES", columns: ["title"], revision: 0 } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("without a revision, keeps both of two concurrent saves of different types", async () => {
    await prisma.appSettings.create({ data: { userId } });
    const [a, b] = await Promise.all([
      callRoute(putColumns, { method: "PUT", body: { type: "MOVIE", columns: ["year"] } }),
      callRoute(putColumns, { method: "PUT", body: { type: "SERIES", columns: ["title"] } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const row = await prisma.appSettings.findUnique({ where: { userId } });
    expect(row?.columnPreferences).toEqual({ MOVIE: ["year"], SERIES: ["title"] });
    expect(row?.columnPreferencesRevision).toBe(2);
  });

  it("creates the row at revision 1", async () => {
    const res = await callRoute(putColumns, { method: "PUT", body: { type: "MUSIC", columns: ["title"], revision: 0 } });
    expect(await expectJson(res)).toEqual({ success: true, revision: 1 });
  });
});

describe("display-settings:changed", () => {
  it("is announced by every display setting save", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "2.0.0");
    const saves: [string, Promise<Response>][] = [
      ["chip colours", callRoute(putChipColors, { method: "PUT", body: { chipColors: { resolution: { "4K": "#ff0000" } } } })],
      ["card display", callRoute(putCardDisplay, { method: "PUT", body: { preferences: { MOVIE: { badges: {}, metadata: {}, servers: true } } } })],
      ["accent", callRoute(putAccent, { method: "PUT", body: { accentColor: "violet" } })],
      ["what's new", callRoute(putWhatsNew, { method: "PUT", body: { version: "2.0.0" } })],
    ];
    for (const [name, saving] of saves) {
      const res = await saving;
      expect(res.status, name).toBe(200);
    }
    expect(announced()).toHaveLength(4);
    // Nothing in it but the address: the receiver refetches.
    expect(announced()[0].meta).toBeUndefined();
  });

  it("is not announced for a refused save", async () => {
    await expectJson(await callRoute(putAccent, { method: "PUT", body: { accentColor: "no-such-preset" } }), 400);
    expect(announced()).toHaveLength(0);
  });
});
