import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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

import { GET, PUT } from "@/app/api/settings/column-preferences/route";

const prisma = getTestPrisma();
const storedColumns = async (userId: string) =>
  (await prisma.appSettings.findUnique({ where: { userId } }))?.columnPreferences;

describe("GET /api/settings/column-preferences", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns null preferences when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ preferences: unknown }>(res);
    expect(body.preferences).toBeNull();
  });

  it("returns saved column preferences", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const columns = ["title", "year", "resolution"];
    await prisma.appSettings.create({ data: { userId: user.id, columnPreferences: { MOVIE: columns } } });

    const res = await callRoute(GET);
    const body = await expectJson<{ preferences: Record<string, string[]> }>(res);
    expect(body.preferences).toEqual({ MOVIE: columns });
  });
});

describe("PUT /api/settings/column-preferences", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { type: "MOVIE", columns: ["title"] },
    });
    await expectJson(res, 401);
  });

  it("saves column preferences successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { type: "MOVIE", columns: ["title", "year"] },
    });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
    expect(await storedColumns(user.id)).toEqual({ MOVIE: ["title", "year"] });
  });

  it("merges preferences across library types", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await expectJson(await callRoute(PUT, { method: "PUT", body: { type: "MOVIE", columns: ["title"] } }));
    await expectJson(await callRoute(PUT, { method: "PUT", body: { type: "SERIES", columns: ["year"] } }));

    const res = await callRoute(GET);
    const body = await expectJson<{ preferences: Record<string, unknown[]> }>(res);
    expect(body.preferences).toEqual({ MOVIE: ["title"], SERIES: ["year"] });
  });

  it("replaces the columns of the type it is sent", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    await prisma.appSettings.create({
      data: { userId: user.id, columnPreferences: { MOVIE: ["title", "year"], MUSIC: ["title"] } },
    });

    await expectJson(await callRoute(PUT, { method: "PUT", body: { type: "MOVIE", columns: ["resolution"] } }));
    expect(await storedColumns(user.id)).toEqual({ MOVIE: ["resolution"], MUSIC: ["title"] });
  });

  it("returns 400 for invalid type", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { type: "INVALID", columns: ["title"] },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^type: /);
    expect(await storedColumns(user.id)).toBeUndefined();
  });

  it("returns 400 for more than 50 columns", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { type: "MOVIE", columns: Array.from({ length: 51 }, (_, i) => `column${i}`) },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^columns: /);
    expect(await storedColumns(user.id)).toBeUndefined();
  });

  it("returns 400 for missing fields", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(2);
    expect(await storedColumns(user.id)).toBeUndefined();
  });
});
