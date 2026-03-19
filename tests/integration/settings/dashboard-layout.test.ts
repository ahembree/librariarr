import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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

import { GET, PUT } from "@/app/api/settings/dashboard-layout/route";

// A valid layout must have main, movies, series, music arrays with valid card entries
const VALID_LAYOUT = {
  main: [{ id: "stats", size: 12 }],
  movies: [{ id: "quality-breakdown", size: 12 }],
  series: [{ id: "quality-breakdown", size: 12 }],
  music: [{ id: "quality-breakdown", size: 12 }],
};

const EMPTY_LAYOUT = {
  main: [],
  movies: [],
  series: [],
  music: [],
};

describe("GET /api/settings/dashboard-layout", () => {
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

  it("returns null layout when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ layout: unknown }>(res);
    expect(body.layout).toBeNull();
  });

  it("returns saved layout", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, { method: "PUT", body: { layout: VALID_LAYOUT } });

    const res = await callRoute(GET);
    const body = await expectJson<{ layout: typeof VALID_LAYOUT }>(res);
    expect(body.layout).toEqual(VALID_LAYOUT);
  });
});

describe("PUT /api/settings/dashboard-layout", () => {
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
      body: { layout: VALID_LAYOUT },
    });
    await expectJson(res, 401);
  });

  it("saves a valid layout", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { layout: VALID_LAYOUT } });
    const body = await expectJson<{ layout: typeof VALID_LAYOUT }>(res);
    expect(body.layout).toEqual(VALID_LAYOUT);
  });

  it("saves an empty layout (all tabs empty)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { layout: EMPTY_LAYOUT } });
    const body = await expectJson<{ layout: typeof EMPTY_LAYOUT }>(res);
    expect(body.layout).toEqual(EMPTY_LAYOUT);
  });

  it("returns 400 for invalid layout structure (missing tabs)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { layout: { main: [] } }, // missing movies, series, music
    });
    await expectJson(res, 400);
  });

  it("returns 400 for invalid card id in layout", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {
        layout: {
          main: [{ id: "nonexistent-card", size: 6 }],
          movies: [],
          series: [],
          music: [],
        },
      },
    });
    await expectJson(res, 400);
  });

  it("returns 400 for card placed in disallowed tab", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // "stats" is only allowed in "main" tab
    const res = await callRoute(PUT, {
      method: "PUT",
      body: {
        layout: {
          main: [],
          movies: [{ id: "stats", size: 12 }],
          series: [],
          music: [],
        },
      },
    });
    await expectJson(res, 400);
  });

  it("returns 400 for missing layout field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: {} });
    await expectJson(res, 400);
  });
});
