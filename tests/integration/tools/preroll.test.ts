import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
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

// Mock PlexClient used in the main preroll route
vi.mock("@/lib/plex/client", () => {
  return {
    PlexClient: vi.fn().mockImplementation(function () {
      return {
        getPrerollSetting: vi.fn().mockResolvedValue("/movies/preroll.mp4"),
        setPrerollPath: vi.fn().mockResolvedValue(undefined),
        clearPreroll: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

// Import route handlers AFTER mocks
import {
  GET as getPreroll,
  POST as postPreroll,
} from "@/app/api/tools/preroll/route";
import {
  GET as getPresets,
  POST as postPreset,
} from "@/app/api/tools/preroll/presets/route";
import {
  PUT as putPreset,
  DELETE as deletePreset,
} from "@/app/api/tools/preroll/presets/[id]/route";
import {
  GET as getSchedules,
  POST as postSchedule,
} from "@/app/api/tools/preroll/schedules/route";
import {
  PUT as putSchedule,
  DELETE as deleteSchedule,
} from "@/app/api/tools/preroll/schedules/[id]/route";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/tools/preroll  (main overview)
// ---------------------------------------------------------------------------
describe("GET /api/tools/preroll", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(getPreroll);
    await expectJson(res, 401);
  });

  it("returns overview with no servers", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(getPreroll);
    const body = await expectJson<{
      currentPreroll: string;
      presets: unknown[];
      schedules: unknown[];
      hasPlexServers: boolean;
    }>(res);

    expect(body.currentPreroll).toBe("");
    expect(body.presets).toEqual([]);
    expect(body.schedules).toEqual([]);
    expect(body.hasPlexServers).toBe(false);
  });

  it("returns current preroll from Plex server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // We need the server to be created so PlexClient is instantiated
    void server;

    const res = await callRoute(getPreroll);
    const body = await expectJson<{
      currentPreroll: string;
      hasPlexServers: boolean;
    }>(res);

    expect(body.currentPreroll).toBe("/movies/preroll.mp4");
    expect(body.hasPlexServers).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tools/preroll  (set preroll path)
// ---------------------------------------------------------------------------
describe("POST /api/tools/preroll", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(postPreroll, {
      method: "POST",
      body: { path: "/some/path.mp4" },
    });
    await expectJson(res, 401);
  });

  it("sets preroll path on Plex servers", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postPreroll, {
      method: "POST",
      body: { path: "/media/prerolls/intro.mp4" },
    });
    const body = await expectJson<{ success: boolean; errors: string[] }>(res);

    expect(body.success).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it("validates path is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postPreroll, {
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });
});

// ---------------------------------------------------------------------------
// Preroll Presets CRUD
// ---------------------------------------------------------------------------
describe("GET /api/tools/preroll/presets", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(getPresets);
    await expectJson(res, 401);
  });

  it("returns empty list initially", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(getPresets);
    const body = await expectJson<{ presets: unknown[] }>(res);
    expect(body.presets).toEqual([]);
  });
});

describe("POST /api/tools/preroll/presets", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(postPreset, {
      method: "POST",
      body: { name: "Holiday", path: "/prerolls/holiday.mp4" },
    });
    await expectJson(res, 401);
  });

  it("creates a preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postPreset, {
      method: "POST",
      body: { name: "Holiday", path: "/prerolls/holiday.mp4" },
    });
    const body = await expectJson<{
      preset: { id: string; name: string; path: string };
    }>(res, 201);

    expect(body.preset.id).toBeDefined();
    expect(body.preset.name).toBe("Holiday");
    expect(body.preset.path).toBe("/prerolls/holiday.mp4");
  });

  it("validates name is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postPreset, {
      method: "POST",
      body: { path: "/prerolls/holiday.mp4" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("validates path is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postPreset, {
      method: "POST",
      body: { name: "No Path" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("GET after POST returns created preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(postPreset, {
      method: "POST",
      body: { name: "Summer", path: "/prerolls/summer.mp4" },
    });

    const res = await callRoute(getPresets);
    const body = await expectJson<{
      presets: { name: string; path: string }[];
    }>(res);
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0].name).toBe("Summer");
    expect(body.presets[0].path).toBe("/prerolls/summer.mp4");
  });
});

describe("PUT /api/tools/preroll/presets/[id]", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      putPreset,
      { id: "nonexistent" },
      { method: "PUT", body: { name: "Updated" } }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      putPreset,
      { id: "nonexistent-id" },
      { method: "PUT", body: { name: "Updated" } }
    );
    await expectJson(res, 404);
  });

  it("updates an existing preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Create preset
    const createRes = await callRoute(postPreset, {
      method: "POST",
      body: { name: "Old Name", path: "/old/path.mp4" },
    });
    const { preset: created } = await createRes.json();

    // Update it
    const res = await callRouteWithParams(
      putPreset,
      { id: created.id },
      { method: "PUT", body: { name: "New Name", path: "/new/path.mp4" } }
    );
    const body = await expectJson<{
      preset: { name: string; path: string };
    }>(res);

    expect(body.preset.name).toBe("New Name");
    expect(body.preset.path).toBe("/new/path.mp4");
  });

  it("cannot update another user's preset", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    // User 1 creates a preset
    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const createRes = await callRoute(postPreset, {
      method: "POST",
      body: { name: "My Preset", path: "/my/path.mp4" },
    });
    const { preset: created } = await createRes.json();

    // User 2 tries to update it
    setMockSession({ isLoggedIn: true, userId: user2.id, plexToken: "tok" });
    const res = await callRouteWithParams(
      putPreset,
      { id: created.id },
      { method: "PUT", body: { name: "Stolen" } }
    );
    await expectJson(res, 404);
  });
});

describe("DELETE /api/tools/preroll/presets/[id]", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      deletePreset,
      { id: "nonexistent" },
      { method: "DELETE" }
    );
    await expectJson(res, 401);
  });

  it("deletes an existing preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Create preset
    const createRes = await callRoute(postPreset, {
      method: "POST",
      body: { name: "To Delete", path: "/delete/me.mp4" },
    });
    const { preset: created } = await createRes.json();

    // Delete it
    const res = await callRouteWithParams(
      deletePreset,
      { id: created.id },
      { method: "DELETE" }
    );
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);

    // Verify it's gone
    const listRes = await callRoute(getPresets);
    const listBody = await expectJson<{ presets: unknown[] }>(listRes);
    expect(listBody.presets).toHaveLength(0);
  });

  it("cannot delete another user's preset", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const createRes = await callRoute(postPreset, {
      method: "POST",
      body: { name: "Protected", path: "/safe.mp4" },
    });
    const { preset: created } = await createRes.json();

    setMockSession({ isLoggedIn: true, userId: user2.id, plexToken: "tok" });
    const res = await callRouteWithParams(
      deletePreset,
      { id: created.id },
      { method: "DELETE" }
    );
    await expectJson(res, 404);
  });
});

// ---------------------------------------------------------------------------
// Preroll Schedules CRUD
// ---------------------------------------------------------------------------
describe("GET /api/tools/preroll/schedules", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(getSchedules);
    await expectJson(res, 401);
  });

  it("returns empty list initially", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(getSchedules);
    const body = await expectJson<{ schedules: unknown[] }>(res);
    expect(body.schedules).toEqual([]);
  });
});

describe("POST /api/tools/preroll/schedules", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Holiday",
        prerollPath: "/prerolls/holiday.mp4",
        scheduleType: "one_time",
        startDate: "2030-12-20T00:00:00Z",
        endDate: "2030-12-27T00:00:00Z",
      },
    });
    await expectJson(res, 401);
  });

  it("creates a one_time preroll schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Holiday Special",
        prerollPath: "/prerolls/holiday.mp4",
        scheduleType: "one_time",
        startDate: "2030-12-20T00:00:00Z",
        endDate: "2030-12-27T00:00:00Z",
        priority: 10,
      },
    });
    const body = await expectJson<{
      schedule: {
        id: string;
        name: string;
        prerollPath: string;
        scheduleType: string;
        priority: number;
      };
    }>(res, 201);

    expect(body.schedule.id).toBeDefined();
    expect(body.schedule.name).toBe("Holiday Special");
    expect(body.schedule.prerollPath).toBe("/prerolls/holiday.mp4");
    expect(body.schedule.scheduleType).toBe("one_time");
    expect(body.schedule.priority).toBe(10);
  });

  it("creates a recurring preroll schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Weekend Preroll",
        prerollPath: "/prerolls/weekend.mp4",
        scheduleType: "recurring",
        daysOfWeek: [0, 6],
        startTime: "18:00",
        endTime: "23:00",
      },
    });
    const body = await expectJson<{
      schedule: {
        name: string;
        scheduleType: string;
        daysOfWeek: number[];
        startTime: string;
        endTime: string;
      };
    }>(res, 201);

    expect(body.schedule.name).toBe("Weekend Preroll");
    expect(body.schedule.scheduleType).toBe("recurring");
    expect(body.schedule.daysOfWeek).toEqual([0, 6]);
    expect(body.schedule.startTime).toBe("18:00");
    expect(body.schedule.endTime).toBe("23:00");
  });

  it("validates name is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        prerollPath: "/prerolls/test.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("validates prerollPath is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "No Path",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("validates startDate must be before endDate for one_time", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Bad Dates",
        prerollPath: "/prerolls/test.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-02T00:00:00Z",
        endDate: "2030-01-01T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Start date must be before end date");
  });

  it("validates recurring schedule requires daysOfWeek", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Bad Recurring",
        prerollPath: "/prerolls/test.mp4",
        scheduleType: "recurring",
        startTime: "02:00",
        endTime: "06:00",
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Days of week must be a non-empty array");
  });

  it("GET after POST returns created schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Test Schedule",
        prerollPath: "/prerolls/test.mp4",
        scheduleType: "one_time",
        startDate: "2030-06-01T00:00:00Z",
        endDate: "2030-06-15T00:00:00Z",
      },
    });

    const res = await callRoute(getSchedules);
    const body = await expectJson<{
      schedules: { name: string; prerollPath: string }[];
    }>(res);
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].name).toBe("Test Schedule");
  });
});

describe("PUT /api/tools/preroll/schedules/[id]", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      putSchedule,
      { id: "nonexistent" },
      { method: "PUT", body: { name: "Updated" } }
    );
    await expectJson(res, 401);
  });

  it("returns 404 for non-existent schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRouteWithParams(
      putSchedule,
      { id: "nonexistent-id" },
      { method: "PUT", body: { name: "Updated" } }
    );
    await expectJson(res, 404);
  });

  it("updates an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Create schedule
    const createRes = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Original",
        prerollPath: "/prerolls/original.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-31T00:00:00Z",
      },
    });
    const { schedule: created } = await createRes.json();

    // Update name and path
    const res = await callRouteWithParams(
      putSchedule,
      { id: created.id },
      {
        method: "PUT",
        body: {
          name: "Updated Schedule",
          prerollPath: "/prerolls/updated.mp4",
        },
      }
    );
    const body = await expectJson<{
      schedule: { name: string; prerollPath: string };
    }>(res);

    expect(body.schedule.name).toBe("Updated Schedule");
    expect(body.schedule.prerollPath).toBe("/prerolls/updated.mp4");
  });

  it("cannot update another user's schedule", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const createRes = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Protected",
        prerollPath: "/prerolls/safe.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-31T00:00:00Z",
      },
    });
    const { schedule: created } = await createRes.json();

    setMockSession({ isLoggedIn: true, userId: user2.id, plexToken: "tok" });
    const res = await callRouteWithParams(
      putSchedule,
      { id: created.id },
      { method: "PUT", body: { name: "Stolen" } }
    );
    await expectJson(res, 404);
  });
});

describe("DELETE /api/tools/preroll/schedules/[id]", () => {
  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(
      deleteSchedule,
      { id: "nonexistent" },
      { method: "DELETE" }
    );
    await expectJson(res, 401);
  });

  it("deletes an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    // Create schedule
    const createRes = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "To Delete",
        prerollPath: "/prerolls/delete.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-31T00:00:00Z",
      },
    });
    const { schedule: created } = await createRes.json();

    // Delete it
    const res = await callRouteWithParams(
      deleteSchedule,
      { id: created.id },
      { method: "DELETE" }
    );
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);

    // Verify it's gone
    const listRes = await callRoute(getSchedules);
    const listBody = await expectJson<{ schedules: unknown[] }>(listRes);
    expect(listBody.schedules).toHaveLength(0);
  });

  it("cannot delete another user's schedule", async () => {
    const user1 = await createTestUser({ plexId: "plex-owner" });
    const user2 = await createTestUser({ plexId: "plex-other" });

    setMockSession({ isLoggedIn: true, userId: user1.id, plexToken: "tok" });
    const createRes = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "Protected",
        prerollPath: "/prerolls/safe.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-31T00:00:00Z",
      },
    });
    const { schedule: created } = await createRes.json();

    setMockSession({ isLoggedIn: true, userId: user2.id, plexToken: "tok" });
    const res = await callRouteWithParams(
      deleteSchedule,
      { id: created.id },
      { method: "DELETE" }
    );
    await expectJson(res, 404);
  });
});
