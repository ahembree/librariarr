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

// Import route handlers AFTER mocks
import { GET, PUT } from "@/app/api/settings/dedup/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/settings/dedup
// ---------------------------------------------------------------------------
describe("GET /api/settings/dedup", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns default dedupStats (true) when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(true);
  });

  it("returns saved dedupStats after PUT", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: false },
    });

    const res = await callRoute(GET);
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/dedup
// ---------------------------------------------------------------------------
describe("PUT /api/settings/dedup", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: false },
    });
    await expectJson(res, 401);
  });

  it("saves dedupStats as true", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: true },
    });
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(true);
  });

  it("saves dedupStats as false", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: false },
    });
    const body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(false);
  });

  it("returns 400 when dedupStats is missing", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 400 when dedupStats is not a boolean", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, {
      method: "PUT",
      body: { dedupStats: "yes" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("toggles dedupStats back and forth", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Set to false
    await callRoute(PUT, { method: "PUT", body: { dedupStats: false } });

    // Verify it's false
    let res = await callRoute(GET);
    let body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(false);

    // Set back to true
    await callRoute(PUT, { method: "PUT", body: { dedupStats: true } });

    // Verify it's true
    res = await callRoute(GET);
    body = await expectJson<{ dedupStats: boolean }>(res);
    expect(body.dedupStats).toBe(true);
  });
});
