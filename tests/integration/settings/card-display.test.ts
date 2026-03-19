import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
} from "../../setup/test-db";
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
import {
  GET as getCardDisplay,
  PUT as putCardDisplay,
} from "@/app/api/settings/card-display-preferences/route";

describe("GET /api/settings/card-display-preferences", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getCardDisplay);
    await expectJson(res, 401);
  });

  it("returns null preferences when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(getCardDisplay);
    const body = await expectJson<{ preferences: unknown }>(res);
    expect(body.preferences).toBeNull();
  });
});

describe("PUT /api/settings/card-display-preferences", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putCardDisplay, {
      method: "PUT",
      body: {
        preferences: {
          MOVIE: {
            badges: { resolution: true },
            metadata: { year: true },
            servers: false,
          },
        },
      },
    });
    await expectJson(res, 401);
  });

  it("updates card display preferences with valid data", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const preferences = {
      MOVIE: {
        badges: { resolution: true, dynamicRange: false },
        metadata: { year: true, studio: false },
        servers: true,
      },
    };

    const res = await callRoute(putCardDisplay, {
      method: "PUT",
      body: { preferences },
    });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("GET after PUT returns updated preferences", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const preferences = {
      MOVIE: {
        badges: { resolution: true },
        metadata: { year: true },
        servers: false,
      },
      SERIES: {
        badges: { resolution: false },
        metadata: { year: false },
        servers: true,
      },
    };

    await callRoute(putCardDisplay, {
      method: "PUT",
      body: { preferences },
    });

    const res = await callRoute(getCardDisplay);
    const body = await expectJson<{ preferences: typeof preferences }>(res);
    expect(body.preferences).toEqual(preferences);
  });

  it("rejects missing preferences field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(putCardDisplay, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("rejects non-object preferences", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(putCardDisplay, {
      method: "PUT",
      body: { preferences: "not-an-object" },
    });
    await expectJson(res, 400);
  });

  it("rejects preferences with invalid inner structure (missing servers)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(putCardDisplay, {
      method: "PUT",
      body: {
        preferences: {
          MOVIE: {
            badges: { resolution: true },
            metadata: { year: true },
            // missing servers field
          },
        },
      },
    });
    await expectJson(res, 400);
  });

  it("overwrites previous preferences on second PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const first = {
      MOVIE: {
        badges: { resolution: true },
        metadata: { year: true },
        servers: false,
      },
    };

    await callRoute(putCardDisplay, {
      method: "PUT",
      body: { preferences: first },
    });

    const second = {
      SERIES: {
        badges: { dynamicRange: true },
        metadata: { studio: false },
        servers: true,
      },
    };

    await callRoute(putCardDisplay, {
      method: "PUT",
      body: { preferences: second },
    });

    const res = await callRoute(getCardDisplay);
    const body = await expectJson<{ preferences: typeof second }>(res);
    expect(body.preferences).toEqual(second);
  });
});
