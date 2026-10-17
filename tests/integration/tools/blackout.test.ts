import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns empty list initially", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(GET);
    const body = await expectJson<{ schedules: unknown[] }>(res);
    expect(body.schedules).toEqual([]);
  });

  it("returns created schedules", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await createOneTimeSchedule();
    await createRecurringSchedule();

    const res = await callRoute(GET);
    const body = await expectJson<{ schedules: { name: string }[] }>(res);
    expect(body.schedules.map((s) => s.name).sort()).toEqual(["Recurring Blackout", "Test Blackout"]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tools/blackout
// ---------------------------------------------------------------------------
describe("POST /api/tools/blackout", () => {
  it("returns 401 without auth", async () => {
    const res = await createOneTimeSchedule();
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
    expect(await getTestPrisma().blackoutSchedule.count()).toBe(0);
  });

  it("creates a one_time blackout schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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

    expect(body.schedule).toMatchObject({
      name: "New Year Blackout",
      scheduleType: "one_time",
      startDate: "2030-01-01T00:00:00.000Z",
      endDate: "2030-01-02T00:00:00.000Z",
      daysOfWeek: null,
      startTime: null,
      endTime: null,
      action: "terminate_immediate",
      message: "Maintenance window",
      delay: 60,
      enabled: true,
      excludedUsers: [],
    });
    const stored = await getTestPrisma().blackoutSchedule.findUniqueOrThrow({ where: { id: body.schedule.id } });
    expect(stored.userId).toBe(user.id);
  });

  it("creates a recurring blackout schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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

    expect(body.schedule).toMatchObject({
      name: "Recurring Blackout",
      scheduleType: "recurring",
      startDate: null,
      endDate: null,
      daysOfWeek: [1, 3, 5],
      startTime: "02:00",
      endTime: "06:00",
      action: "warn_then_terminate",
      // The column defaults stand in for what the request left out.
      message: "Stream terminated due to scheduled blackout period.",
      delay: 30,
    });
  });

  it("validates required name field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^name: /)]);
    expect(await getTestPrisma().blackoutSchedule.count()).toBe(0);
  });

  it("validates required action field", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Schedule",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^action: /)]);
  });

  it("validates one_time requires startDate and endDate", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(POST, {
      method: "POST",
      body: {
        name: "Bad Blackout",
        scheduleType: "one_time",
        action: "terminate_immediate",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("startDate and endDate are required for one_time schedules");
    expect(await getTestPrisma().blackoutSchedule.count()).toBe(0);
  });

  it("validates one_time startDate must be before endDate", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await createOneTimeSchedule({
      startDate: "2030-01-02T00:00:00Z",
      endDate: "2030-01-01T00:00:00Z",
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("startDate must be before endDate");
    expect(await getTestPrisma().blackoutSchedule.count()).toBe(0);
  });

  it("validates recurring requires daysOfWeek", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    expect(body.error).toBe("daysOfWeek must be a non-empty array for recurring schedules");
  });

  it("validates recurring requires startTime and endTime", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    expect(body.error).toBe("startTime and endTime are required for recurring schedules");
  });

  it("validates recurring time format must be HH:mm", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    expect(body.error).toBe("startTime and endTime must be in HH:mm format");
  });

  it("creates schedule with optional excludedUsers", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    // Media-server usernames, as sessions report them.
    const res = await createOneTimeSchedule({
      excludedUsers: ["alice", "bob"],
    });
    const body = await expectJson<{
      schedule: { excludedUsers: string[] };
    }>(res, 201);
    expect(body.schedule.excludedUsers).toEqual(["alice", "bob"]);
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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 for non-existent schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRouteWithParams(
      PUT,
      { id: "nonexistent-id" },
      { method: "PUT", body: { name: "Updated" } }
    );
    expect(await expectJson(res, 404)).toEqual({ error: "Schedule not found" });
  });

  it("updates an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
      schedule: { name: string; action: string; startDate: string; endDate: string };
    }>(res);
    expect(body.schedule).toMatchObject({
      name: "Updated Blackout",
      action: "block_new_only",
      startDate: "2030-06-01T00:00:00.000Z",
      endDate: "2030-06-02T00:00:00.000Z",
    });
  });

  it("toggling enabled (partial body) preserves a one_time schedule's dates", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // The streams page sends ONLY { enabled } when toggling the switch.
    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      { method: "PUT", body: { enabled: false } }
    );
    const body = await expectJson<{
      schedule: { enabled: boolean; startDate: string | null; endDate: string | null };
    }>(res);
    expect(body.schedule.enabled).toBe(false);
    // CRITICAL: a partial toggle must NOT wipe the schedule's date definition.
    expect(body.schedule.startDate).toBe("2030-01-01T00:00:00.000Z");
    expect(body.schedule.endDate).toBe("2030-01-02T00:00:00.000Z");
  });

  it("toggling enabled (partial body) preserves a recurring schedule's times", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const createRes = await createRecurringSchedule();
    const { schedule: created } = await createRes.json();

    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      { method: "PUT", body: { enabled: false } }
    );
    const body = await expectJson<{
      schedule: { startTime: string | null; endTime: string | null; daysOfWeek: number[] | null };
    }>(res);
    expect(body.schedule.startTime).toBe("02:00");
    expect(body.schedule.endTime).toBe("06:00");
    expect(body.schedule.daysOfWeek).toEqual([1, 3, 5]);
  });

  it("applies a partial time edit against the existing recurring type", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const createRes = await createRecurringSchedule();
    const { schedule: created } = await createRes.json();

    // Edit only the times — no scheduleType resent (what the UI does when you
    // tweak a time field). Previously these were silently dropped.
    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      { method: "PUT", body: { startTime: "22:00", endTime: "23:30" } }
    );
    const body = await expectJson<{
      schedule: { startTime: string | null; endTime: string | null; daysOfWeek: number[] | null };
    }>(res);
    expect(body.schedule.startTime).toBe("22:00");
    expect(body.schedule.endTime).toBe("23:30");
    // Days untouched.
    expect(body.schedule.daysOfWeek).toEqual([1, 3, 5]);
  });

  it("rejects an out-of-range time on a partial edit", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const createRes = await createRecurringSchedule();
    const { schedule: created } = await createRes.json();

    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      { method: "PUT", body: { startTime: "27:00" } }
    );
    expect(await expectJson(res, 400)).toEqual({ error: "startTime must be in HH:mm format" });
    const stored = await getTestPrisma().blackoutSchedule.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.startTime).toBe("02:00");
  });

  it("rejects an out-of-range time on create", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await createRecurringSchedule({ startTime: "24:00", endTime: "25:61" });
    expect(await expectJson(res, 400)).toEqual({ error: "startTime and endTime must be in HH:mm format" });
    expect(await getTestPrisma().blackoutSchedule.count()).toBe(0);
  });

  it("cannot update another user's schedule", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    // User 1 creates a schedule
    setMockSession({ isLoggedIn: true, userId: user1.id});
    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // User 2 tries to update it
    setMockSession({ isLoggedIn: true, userId: user2.id});
    const res = await callRouteWithParams(
      PUT,
      { id: created.id },
      { method: "PUT", body: { name: "Hacked" } }
    );
    await expectJson(res, 404);
    const stored = await getTestPrisma().blackoutSchedule.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.name).toBe("Test Blackout");
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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns 404 for non-existent schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRouteWithParams(
      DELETE,
      { id: "nonexistent-id" },
      { method: "DELETE" }
    );
    expect(await expectJson(res, 404)).toEqual({ error: "Schedule not found" });
  });

  it("deletes an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    setMockSession({ isLoggedIn: true, userId: user1.id});
    const createRes = await createOneTimeSchedule();
    const { schedule: created } = await createRes.json();

    // User 2 tries to delete it
    setMockSession({ isLoggedIn: true, userId: user2.id});
    const res = await callRouteWithParams(
      DELETE,
      { id: created.id },
      { method: "DELETE" }
    );
    await expectJson(res, 404);

    // Verify it still exists for user1
    setMockSession({ isLoggedIn: true, userId: user1.id});
    const listRes = await callRoute(GET);
    const listBody = await expectJson<{ schedules: unknown[] }>(listRes);
    expect(listBody.schedules).toHaveLength(1);
  });
});
