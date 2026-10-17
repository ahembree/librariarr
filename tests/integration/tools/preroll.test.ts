import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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
import { GET as getPrerollCurrent } from "@/app/api/tools/preroll/current/route";
import { POST as postPreset } from "@/app/api/tools/preroll/presets/route";
import {
  PUT as putPreset,
  DELETE as deletePreset,
} from "@/app/api/tools/preroll/presets/[id]/route";
import { POST as postSchedule } from "@/app/api/tools/preroll/schedules/route";
import {
  PUT as putSchedule,
  DELETE as deleteSchedule,
} from "@/app/api/tools/preroll/schedules/[id]/route";
import { PlexClient } from "@/lib/plex/client";

/** The client each `new PlexClient(...)` returned, in construction order. */
function plexClients() {
  return vi.mocked(PlexClient).mock.results.map(
    (r) =>
      r.value as {
        getPrerollSetting: ReturnType<typeof vi.fn>;
        setPrerollPath: ReturnType<typeof vi.fn>;
        clearPreroll: ReturnType<typeof vi.fn>;
      },
  );
}

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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns DB-only overview with no servers", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(getPreroll);
    const body = await expectJson<{
      presets: unknown[];
      schedules: unknown[];
      hasPlexServers: boolean;
    }>(res);

    expect(body.presets).toEqual([]);
    expect(body.schedules).toEqual([]);
    expect(body.hasPlexServers).toBe(false);
  });

  it("does not call the media server", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(getPreroll);
    const body = await expectJson<{ hasPlexServers: boolean }>(res, 200);

    expect(body.hasPlexServers).toBe(true);
    expect(PlexClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/tools/preroll/current  (live current preroll path from Plex)
// ---------------------------------------------------------------------------
describe("GET /api/tools/preroll/current", () => {
  it("returns 401 without auth", async () => {
    const res = await callRoute(getPrerollCurrent);
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns empty when no servers configured", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(getPrerollCurrent);
    const body = await expectJson<{ currentPreroll: string; available: boolean }>(res);

    expect(body).toEqual({ currentPreroll: "", available: false });
    expect(PlexClient).not.toHaveBeenCalled();
  });

  it("returns current preroll from Plex server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(getPrerollCurrent);
    const body = await expectJson<{ currentPreroll: string; available: boolean }>(res);

    expect(body).toEqual({ currentPreroll: "/movies/preroll.mp4", available: true });
    expect(PlexClient).toHaveBeenCalledExactlyOnceWith(server.url, server.accessToken, { skipTlsVerify: false });
  });

  it("reports the preroll as unavailable when Plex cannot be read", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});
    vi.mocked(PlexClient).mockImplementationOnce(function () {
      return { getPrerollSetting: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) } as never;
    });

    const body = await expectJson<{ currentPreroll: string; available: boolean }>(await callRoute(getPrerollCurrent));
    expect(body).toEqual({ currentPreroll: "", available: false });
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
    expect(await expectJson(res, 401)).toEqual({ error: "Unauthorized" });
    expect(PlexClient).not.toHaveBeenCalled();
  });

  it("sets preroll path on Plex servers", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postPreroll, {
      method: "POST",
      body: { path: "/media/prerolls/intro.mp4" },
    });
    const body = await expectJson<{ success: boolean; errors: string[] }>(res);

    expect(body).toEqual({ success: true, errors: [] });
    expect(PlexClient).toHaveBeenCalledExactlyOnceWith(server.url, server.accessToken, { skipTlsVerify: false });
    const [client] = plexClients();
    expect(client.setPrerollPath).toHaveBeenCalledExactlyOnceWith("/media/prerolls/intro.mp4");
    expect(client.clearPreroll).not.toHaveBeenCalled();
  });

  it("clears the preroll for an empty path", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id});

    const body = await expectJson<{ success: boolean; errors: string[] }>(
      await callRoute(postPreroll, { method: "POST", body: { path: "" } }),
    );

    expect(body).toEqual({ success: true, errors: [] });
    const [client] = plexClients();
    expect(client.clearPreroll).toHaveBeenCalledOnce();
    expect(client.setPrerollPath).not.toHaveBeenCalled();
  });

  it("names the server that refused, with its address scrubbed, and still sets the others", async () => {
    const user = await createTestUser();
    await createTestServer(user.id, { name: "Basement", url: "http://192.168.1.20:32400" });
    await createTestServer(user.id, { name: "Office", url: "http://plex-office.test:32400" });
    setMockSession({ isLoggedIn: true, userId: user.id});
    vi.mocked(PlexClient).mockImplementationOnce(function () {
      return {
        setPrerollPath: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 192.168.1.20:32400")),
      } as never;
    });

    const body = await expectJson<{ success: boolean; errors: string[] }>(
      await callRoute(postPreroll, { method: "POST", body: { path: "/media/prerolls/intro.mp4" } }),
    );

    expect(body.success).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/^(Basement|Office): connect ECONNREFUSED \[internal\]:32400$/);
    // The other server was still asked.
    expect(PlexClient).toHaveBeenCalledTimes(2);
    expect(plexClients()[1].setPrerollPath).toHaveBeenCalledWith("/media/prerolls/intro.mp4");
  });

  it("validates path is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postPreroll, {
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^path: /)]);
  });
});

// ---------------------------------------------------------------------------
// Preroll Presets CRUD
// ---------------------------------------------------------------------------
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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postPreset, {
      method: "POST",
      body: { name: "Holiday", path: "/prerolls/holiday.mp4" },
    });
    const body = await expectJson<{
      preset: { id: string; name: string; path: string };
    }>(res, 201);

    expect(body.preset.name).toBe("Holiday");
    expect(body.preset.path).toBe("/prerolls/holiday.mp4");
    const stored = await getTestPrisma().prerollPreset.findUniqueOrThrow({ where: { id: body.preset.id } });
    expect(stored).toMatchObject({ userId: user.id, name: "Holiday", path: "/prerolls/holiday.mp4" });
  });

  it("validates name is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postPreset, {
      method: "POST",
      body: { path: "/prerolls/holiday.mp4" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^name: /)]);
    expect(await getTestPrisma().prerollPreset.count()).toBe(0);
  });

  it("validates path is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postPreset, {
      method: "POST",
      body: { name: "No Path" },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^path: /)]);
    expect(await getTestPrisma().prerollPreset.count()).toBe(0);
  });

  // Only spaces was stored as "" once trimmed.
  it.each([
    ["name", { name: "   ", path: "/prerolls/holiday.mp4" }, "name: Name is required"],
    ["path", { name: "Holiday", path: "  " }, "path: Path is required"],
  ])("refuses a %s that is only spaces", async (_label, body, detail) => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postPreset, { method: "POST", body });
    expect(await expectJson(res, 400)).toEqual({ error: "Validation failed", details: [detail] });
    expect(await getTestPrisma().prerollPreset.count()).toBe(0);
  });

  it("GET after POST returns created preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    await callRoute(postPreset, {
      method: "POST",
      body: { name: "Summer", path: "/prerolls/summer.mp4" },
    });

    const res = await callRoute(getPreroll);
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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRouteWithParams(
      putPreset,
      { id: "nonexistent-id" },
      { method: "PUT", body: { name: "Updated" } }
    );
    expect(await expectJson(res, 404)).toEqual({ error: "Not found" });
  });

  it("updates an existing preset", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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

  it.each([
    ["name", { name: "  " }, "name: Name is required"],
    ["path", { path: "   " }, "path: Path is required"],
  ])("refuses changing the %s to only spaces", async (_label, update, detail) => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});
    const { preset: created } = await (
      await callRoute(postPreset, { method: "POST", body: { name: "Old Name", path: "/old/path.mp4" } })
    ).json();

    const res = await callRouteWithParams(putPreset, { id: created.id }, { method: "PUT", body: update });
    expect(await expectJson(res, 400)).toEqual({ error: "Validation failed", details: [detail] });
    const row = await getTestPrisma().prerollPreset.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ name: "Old Name", path: "/old/path.mp4" });
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
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    const listRes = await callRoute(getPreroll);
    const listBody = await expectJson<{ presets: unknown[] }>(listRes);
    expect(listBody.presets).toHaveLength(0);
  });

  it("returns 404 for a non-existent preset and deletes nothing", async () => {
    const user = await createTestUser();

    setMockSession({ isLoggedIn: true, userId: user.id});
    const createRes = await callRoute(postPreset, {
      method: "POST",
      body: { name: "Protected", path: "/safe.mp4" },
    });
    const { preset: created } = await createRes.json();

    const res = await callRouteWithParams(
      deletePreset,
      { id: "nonexistent-id" },
      { method: "DELETE" }
    );
    await expectJson(res, 404);
    expect(await getTestPrisma().prerollPreset.findUnique({ where: { id: created.id } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Preroll Schedules CRUD
// ---------------------------------------------------------------------------
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
    setMockSession({ isLoggedIn: true, userId: user.id});

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

    expect(body.schedule.name).toBe("Holiday Special");
    expect(body.schedule.prerollPath).toBe("/prerolls/holiday.mp4");
    expect(body.schedule.scheduleType).toBe("one_time");
    expect(body.schedule.priority).toBe(10);
  });

  it("creates a recurring preroll schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        prerollPath: "/prerolls/test.mp4",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^name: /)]);
  });

  it("validates prerollPath is required", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRoute(postSchedule, {
      method: "POST",
      body: {
        name: "No Path",
        scheduleType: "one_time",
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-02T00:00:00Z",
      },
    });
    const body = await expectJson<{ error: string; details: string[] }>(res, 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([expect.stringMatching(/^prerollPath: /)]);
  });

  it("validates startDate must be before endDate for one_time", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    expect(body.error).toBe("Start date must be before end date");
  });

  it("validates recurring schedule requires daysOfWeek", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    expect(body.error).toBe("Days of week must be a non-empty array for recurring schedules");
  });

  it("GET after POST returns created schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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

    const res = await callRoute(getPreroll);
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
    setMockSession({ isLoggedIn: true, userId: user.id});

    const res = await callRouteWithParams(
      putSchedule,
      { id: "nonexistent-id" },
      { method: "PUT", body: { name: "Updated" } }
    );
    expect(await expectJson(res, 404)).toEqual({ error: "Not found" });
  });

  it("updates an existing schedule", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    setMockSession({ isLoggedIn: true, userId: user.id});

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
    const listRes = await callRoute(getPreroll);
    const listBody = await expectJson<{ schedules: unknown[] }>(listRes);
    expect(listBody.schedules).toHaveLength(0);
  });

  it("returns 404 for a non-existent schedule and deletes nothing", async () => {
    const user = await createTestUser();

    setMockSession({ isLoggedIn: true, userId: user.id});
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

    const res = await callRouteWithParams(
      deleteSchedule,
      { id: "nonexistent-id" },
      { method: "DELETE" }
    );
    await expectJson(res, 404);
    expect(await getTestPrisma().prerollSchedule.findUnique({ where: { id: created.id } })).not.toBeNull();
  });
});
