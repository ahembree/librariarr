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

import { GET, PUT } from "@/app/api/settings/chip-colors/route";

const prisma = getTestPrisma();
const storedChipColors = async (userId: string) =>
  (await prisma.appSettings.findUnique({ where: { userId } }))?.chipColors;

describe("GET /api/settings/chip-colors", () => {
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

  it("returns null when no chip colors saved", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ chipColors: unknown }>(res);
    expect(body.chipColors).toBeNull();
  });

  it("returns saved chip colors", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const colors = { resolution: { "4K": "#ff0000", "1080P": "#00ff00" } };
    await prisma.appSettings.create({ data: { userId: user.id, chipColors: colors } });

    const res = await callRoute(GET);
    const body = await expectJson<{ chipColors: typeof colors }>(res);
    expect(body.chipColors).toEqual(colors);
  });
});

describe("PUT /api/settings/chip-colors", () => {
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
      body: { chipColors: { resolution: { "4K": "#ff0000" } } },
    });
    await expectJson(res, 401);
  });

  it("saves chip colors successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const colors = { resolution: { "4K": "#ff0000" }, audioCodec: { aac: "#0000ff" } };
    const res = await callRoute(PUT, { method: "PUT", body: { chipColors: colors } });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
    expect(await storedChipColors(user.id)).toEqual(colors);
  });

  it("returns 400 for invalid chipColors structure", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: { chipColors: "not-an-object" } });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^chipColors: /);
    expect(await storedChipColors(user.id)).toBeUndefined();
  });

  // The value is written into a style attribute: only a plain hex colour may
  // reach it, never arbitrary CSS.
  it("returns 400 for a colour that is not #rrggbb", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { chipColors: { resolution: { "4K": "red; background: url(https://evil.example/x)" } } },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.details).toEqual(["chipColors.resolution.4K: Must be a 6-digit hex color (#rrggbb)"]);
    expect(await storedChipColors(user.id)).toBeUndefined();
  });

  it("returns 400 for missing chipColors field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(await storedChipColors(user.id)).toBeUndefined();
  });
});
