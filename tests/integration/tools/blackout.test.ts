import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
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

// Import route handlers AFTER mocks
import {
  GET,
  POST,
} from "@/app/api/tools/blackout/route";
import {
  PUT,
  DELETE,
} from "@/app/api/tools/blackout/[id]/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// Helper to create a one_time blackout schedule via POST
async function createOneTimeSchedule(overrides?: Record<string, unknown>) {
  return callRoute(POST, {
    method: "POST",
    body: {
      name: "Test Blackout",
      scheduleType: "one_time",
      startDate: "2030-01-01T00:00:00Z",
      endDate: "2030-01-02T00:00:00Z",
      action: "terminate_immediate",
      ...overrides,
    },
  });
}

// Helper to create a recurring blackout schedule via POST
async function createRecurringSchedule(overrides?: Record<string, unknown>) {
  return callRoute(POST, {
    method: "POST",
    body: {
      name: "Recurring Blackout",
      scheduleType: "recurring",
      daysOfWeek: [1, 3, 5],
      startTime: "02:00",
      endTime: "06:00",
      action: "warn_then_terminate",
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/tools/blackout
// ---------------------------------------------------------------------------
describe("GET /api/tools/blackout", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns empty list initially", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(GET);
    const body = await expectJson<{ schedules: unknown[] }>(res);
    expect(body.schedules).toEqual([]);
  });

  it("returns created schedules", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await createOneTimeSchedule();
    await createRecurringSchedule();

    const res = await callRoute(GET);
    const body = await expectJson<{ schedules: unknown[] }>(res);
    expect(body.schedules).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tools/blackout
// ---------------------------------------------------------------------------
describe("POST /api/tools/blackout", () => {
  it("returns 401 without auth", async () => {
    const res = await createOneTimeSchedule();
    await expectJson(res, 401);
  });

  it("creates a one_time blackout schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await createOneTimeSchedule({
      name: "New Year Blackout",
      message: "Maintenance window",
      delay: 60,
    });
    const body = await expectJson<{
      schedule: {
        id: string;
        name: string;
        scheduleType: string;
        action: string;
        message: string;
        delay: number;
      };
    }>(res, 201);

    expect(body.schedule.id).toBeDefined();
    expect(body.schedule.name).toBe("New Year Blackout");
    expect(body.schedule.scheduleType).toBe("one_time");
    expect(body.schedule.action).toBe("terminate_immediate");
    expect(body.schedule.message).toBe("Maintenance window");
    expect(body.schedule.delay).toBe(60);
  });

  it("creates a recurring blackout schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await createRecurringSchedule();
    const body = await expectJson<{
      schedule: {
        id: string;
        name: string;
        scheduleType: string;
        daysOfWeek: number[];
        startTime: string;
        endTime: string;
        action: string;
      };
    }>(res, 201);

    expect(body.schedule.name).toBe("Recurring Blackout");
    expect(body.schedule.scheduleType).toBe("recurring");
    expect(body.schedule.daysOfWeek).toEqual([1, 3, 5]);
    expect(body.schedule.startTime).toBe("02:00");
    expect(body.schedule.endTime).toBe("06:00");
    expect(body.schedule.action).toBe("warn_then_terminate");
  });

  it("validates required name field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("validates required action field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Schedule",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("validates one_time requires startDate and endDate", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Blackout",
        scheduleType: "one_time",
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("startDate and endDate are required");
  });

  it("validates one_time startDate must be before endDate", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await createOneTimeSchedule({
      startDate: "2030-01-02T00:00:00Z",
      endDate: "2030-01-01T00:00:00Z",
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("startDate must be before endDate");
  });

  it("validates recurring requires daysOfWeek", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Recurring",
        scheduleType: "recurring",
        startTime: "02:00",
        endTime: "06:00",
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("daysOfWeek must be a non-empty array");
  });

  it("validates recurring requires startTime and endTime", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Recurring",
        scheduleType: "recurring",
        daysOfWeek: [0, 6],
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("startTime and endTime are required");
  });

  it("validates recurring time format must be HH:mm", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Recurring",
        scheduleType: "recurring",
        daysOfWeek: [0],
        startTime: "2:00",
        endTime: "6:00",
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("HH:mm format");
  });

  it("creates schedule with optional excludedUsers", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await createOneTimeSchedule({
      excludedUsers: ["user-1", "user-2"],
    });
    const body = await expectJson<{
      schedule: { excludedUsers: string[] };
    }>(res, 201);
    expect(body.schedule.excludedUsers).toEqual(["user-1", "user-2"]);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/tools/blackout/[id]
// ---------------------------------------------------------------------------
describe("PUT /api/tools/blackout/[id]", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      PUT,
      { id: "nonexistent" },
      { method: "PUT", body: { name: "Updated" } }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      PUT,
      { id: "nonexistent-id" },
      { method: "PUT", body: { name: "Updated" } }
    );
    await expectJson(res, 404);
  });

  it("updates an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Create a schedule
    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // Update it
    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      {
        method: "PUT",
        body: {
          name: "Updated Blackout",
          scheduleType: "one_time",
          startDate: "2030-06-01T00:00:00Z",
          endDate: "2030-06-02T00:00:00Z",
          action: "block_new_only",
        },
      }
    );
    const body = await expectJson<{
      schedule: { name: string; action: string };
    }>(res);
    expect(body.schedule.name).toBe("Updated Blackout");
    expect(body.schedule.action).toBe("block_new_only");
  });

  it("cannot update another user's schedule", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    // User 1 creates a schedule
    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // User 2 tries to update it
    setMockSession({ isLoggedIn: true, userId: user2.id, plexToken: "tok" });
    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      { method: "PUT", body: { name: "Hacked" } }
    );
    await expectJson(res, 404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tools/blackout/[id]
// ---------------------------------------------------------------------------
describe("DELETE /api/tools/blackout/[id]", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      DELETE,
      { id: "nonexistent" },
      { method: "DELETE" }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      DELETE,
      { id: "nonexistent-id" },
      { method: "DELETE" }
    );
    await expectJson(res, 404);
  });

  it("deletes an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Create a schedule
    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // Delete it
    const res = await callRouteWithParams(
      DELETE,
      { id: created.id },
      { method: "DELETE" }
    );
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);

    // Verify it's gone
    const listRes = await callRoute(GET);
    const listBody = await expectJson<{ schedules: unknown[] }>(listRes);
    expect(listBody.schedules).toHaveLength(0);
  });

  it("cannot delete another user's schedule", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    // User 1 creates a schedule
    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // User 2 tries to delete it
    setMockSession({ isLoggedIn: true, userId: user2.id, plexToken: "tok" });
    const res = await callRouteWithParams(
      DELETE,
      { id: created.id },
      { method: "DELETE" }
    );
    await expectJson(res, 404);

    // Verify it still exists for user1
    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const listRes = await callRoute(GET);
    const listBody = await expectJson<{ schedules: unknown[] }>(listRes);
    expect(listBody.schedules).toHaveLength(1);
  });
});
