import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  apiLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  dbLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import AFTER mocks
import {
  GET as getSyncSchedule,
  PUT as putSyncSchedule,
} from "@/app/api/settings/sync-schedule/route";
import {
  GET as getLifecycleSchedule,
  PUT as putLifecycleSchedule,
} from "@/app/api/settings/lifecycle-schedule/route";
import { GET as getScheduleInfo } from "@/app/api/settings/schedule-info/route";
import {
  GET as getAccentColor,
  PUT as putAccentColor,
} from "@/app/api/settings/accent-color/route";
import {
  GET as getChipColors,
  PUT as putChipColors,
} from "@/app/api/settings/chip-colors/route";
import {
  GET as getColumnPreferences,
  PUT as putColumnPreferences,
} from "@/app/api/settings/column-preferences/route";
import {
  GET as getDashboardLayout,
  PUT as putDashboardLayout,
} from "@/app/api/settings/dashboard-layout/route";
import {
  GET as getLogRetention,
  PUT as putLogRetention,
} from "@/app/api/settings/log-retention/route";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

// ---------------------------------------------------------------------------
// /api/settings/sync-schedule
// ---------------------------------------------------------------------------
describe("GET /api/settings/sync-schedule", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getSyncSchedule);
    await expectJson(res, 401);
  });

  it("returns default syncSchedule for new user", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getSyncSchedule);
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("DAILY");
  });
});

describe("PUT /api/settings/sync-schedule", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "WEEKLY" },
    });
    await expectJson(res, 401);
  });

  it("updates syncSchedule with a preset value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "EVERY_6H" },
    });
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("EVERY_6H");
  });

  it("updates syncSchedule with a valid cron expression", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "0 */4 * * *" },
    });
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("0 */4 * * *");
  });

  it("GET after PUT returns updated value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "WEEKLY" },
    });

    const res = await callRoute(getSyncSchedule);
    const body = await expectJson<{ settings: { syncSchedule: string } }>(res);
    expect(body.settings.syncSchedule).toBe("WEEKLY");
  });

  it("rejects missing syncSchedule", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: {},
    });
    await expectJson(res, 400);
  });

  it("rejects invalid schedule value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putSyncSchedule, {
      method: "PUT",
      body: { syncSchedule: "NOT_A_SCHEDULE" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid schedule");
  });
});

// ---------------------------------------------------------------------------
// /api/settings/lifecycle-schedule
// ---------------------------------------------------------------------------
describe("GET /api/settings/lifecycle-schedule", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getLifecycleSchedule);
    await expectJson(res, 401);
  });

  it("returns default lifecycle schedules for new user", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getLifecycleSchedule);
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lifecycleExecutionSchedule: string;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("EVERY_6H");
    expect(body.lifecycleExecutionSchedule).toBe("EVERY_6H");
  });
});

describe("PUT /api/settings/lifecycle-schedule", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "DAILY" },
    });
    await expectJson(res, 401);
  });

  it("updates detection schedule only", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "DAILY" },
    });
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lifecycleExecutionSchedule: string;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("DAILY");
    expect(body.lifecycleExecutionSchedule).toBe("EVERY_6H");
  });

  it("updates execution schedule only", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: { lifecycleExecutionSchedule: "WEEKLY" },
    });
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lifecycleExecutionSchedule: string;
    }>(res);
    expect(body.lifecycleExecutionSchedule).toBe("WEEKLY");
  });

  it("updates both schedules at once", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: {
        lifecycleDetectionSchedule: "EVERY_12H",
        lifecycleExecutionSchedule: "DAILY",
      },
    });
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lifecycleExecutionSchedule: string;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("EVERY_12H");
    expect(body.lifecycleExecutionSchedule).toBe("DAILY");
  });

  it("accepts a valid cron expression", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "30 2 * * *" },
    });
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("30 2 * * *");
  });

  it("GET after PUT returns updated values", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: {
        lifecycleDetectionSchedule: "MANUAL",
        lifecycleExecutionSchedule: "MANUAL",
      },
    });

    const res = await callRoute(getLifecycleSchedule);
    const body = await expectJson<{
      lifecycleDetectionSchedule: string;
      lifecycleExecutionSchedule: string;
    }>(res);
    expect(body.lifecycleDetectionSchedule).toBe("MANUAL");
    expect(body.lifecycleExecutionSchedule).toBe("MANUAL");
  });

  it("rejects empty body (no schedule provided)", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("No schedule provided");
  });

  it("rejects invalid detection schedule", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: { lifecycleDetectionSchedule: "INVALID" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid detection schedule");
  });

  it("rejects invalid execution schedule", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLifecycleSchedule, {
      method: "PUT",
      body: { lifecycleExecutionSchedule: "INVALID" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid execution schedule");
  });
});

// ---------------------------------------------------------------------------
// /api/settings/schedule-info (GET only)
// ---------------------------------------------------------------------------
describe("GET /api/settings/schedule-info", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getScheduleInfo);
    await expectJson(res, 401);
  });

  it("returns null next-runs when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getScheduleInfo);
    const body = await expectJson<{
      sync: { nextRun: string | null; lastRun: string | null };
      detection: { nextRun: string | null; lastRun: string | null };
      execution: { nextRun: string | null; lastRun: string | null };
    }>(res);
    expect(body.sync).toHaveProperty("nextRun");
    expect(body.sync).toHaveProperty("lastRun");
    expect(body.detection).toHaveProperty("nextRun");
    expect(body.detection).toHaveProperty("lastRun");
    expect(body.execution).toHaveProperty("nextRun");
    expect(body.execution).toHaveProperty("lastRun");
  });

  it("returns computed next-run after settings are created", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    // Create settings with default schedules
    await prisma.appSettings.create({
      data: { userId: user.id, syncSchedule: "DAILY" },
    });

    const res = await callRoute(getScheduleInfo);
    const body = await expectJson<{
      sync: { nextRun: string | null; lastRun: string | null };
    }>(res);
    // DAILY with no lastRun should return now (immediate next run)
    expect(body.sync.nextRun).not.toBeNull();
    expect(body.sync.lastRun).toBeNull();
  });

  it("returns null nextRun for MANUAL schedule", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    await prisma.appSettings.create({
      data: {
        userId: user.id,
        syncSchedule: "MANUAL",
        lifecycleDetectionSchedule: "MANUAL",
        lifecycleExecutionSchedule: "MANUAL",
      },
    });

    const res = await callRoute(getScheduleInfo);
    const body = await expectJson<{
      sync: { nextRun: string | null };
      detection: { nextRun: string | null };
      execution: { nextRun: string | null };
    }>(res);
    expect(body.sync.nextRun).toBeNull();
    expect(body.detection.nextRun).toBeNull();
    expect(body.execution.nextRun).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /api/settings/accent-color
// ---------------------------------------------------------------------------
describe("GET /api/settings/accent-color", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getAccentColor);
    await expectJson(res, 401);
  });

  it("returns default accent color for new user", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getAccentColor);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("default");
  });
});

describe("PUT /api/settings/accent-color", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putAccentColor, {
      method: "PUT",
      body: { accentColor: "blue" },
    });
    await expectJson(res, 401);
  });

  it("updates accent color to a valid preset", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putAccentColor, {
      method: "PUT",
      body: { accentColor: "blue" },
    });
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("blue");
  });

  it("GET after PUT returns updated accent color", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    await callRoute(putAccentColor, {
      method: "PUT",
      body: { accentColor: "rose" },
    });

    const res = await callRoute(getAccentColor);
    const body = await expectJson<{ accentColor: string }>(res);
    expect(body.accentColor).toBe("rose");
  });

  it("rejects invalid accent color name", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putAccentColor, {
      method: "PUT",
      body: { accentColor: "neon-pink" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid accent color");
  });

  it("rejects missing accent color", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putAccentColor, {
      method: "PUT",
      body: {},
    });
    await expectJson(res, 400);
  });
});

// ---------------------------------------------------------------------------
// /api/settings/chip-colors
// ---------------------------------------------------------------------------
describe("GET /api/settings/chip-colors", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getChipColors);
    await expectJson(res, 401);
  });

  it("returns null chipColors when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getChipColors);
    const body = await expectJson<{ chipColors: unknown }>(res);
    expect(body.chipColors).toBeNull();
  });
});

describe("PUT /api/settings/chip-colors", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putChipColors, {
      method: "PUT",
      body: { chipColors: { "1080p": "#ff0000" } },
    });
    await expectJson(res, 401);
  });

  it("updates chip colors with a valid object", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const chipColors = {
      resolution: { "1080p": "#3b82f6", "4K": "#22c55e" },
      dynamicRange: { SDR: "#ef4444" },
    };

    const res = await callRoute(putChipColors, {
      method: "PUT",
      body: { chipColors },
    });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("GET after PUT returns updated chip colors", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const chipColors = {
      resolution: { "1080p": "#3b82f6", "4K": "#22c55e" },
    };

    await callRoute(putChipColors, {
      method: "PUT",
      body: { chipColors },
    });

    const res = await callRoute(getChipColors);
    const body = await expectJson<{ chipColors: Record<string, string> }>(res);
    expect(body.chipColors).toEqual(chipColors);
  });

  it("rejects missing chipColors field", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putChipColors, {
      method: "PUT",
      body: {},
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("rejects non-object chipColors", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putChipColors, {
      method: "PUT",
      body: { chipColors: "not-an-object" },
    });
    await expectJson(res, 400);
  });
});

// ---------------------------------------------------------------------------
// /api/settings/column-preferences
// ---------------------------------------------------------------------------
describe("GET /api/settings/column-preferences", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getColumnPreferences);
    await expectJson(res, 401);
  });

  it("returns null preferences when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getColumnPreferences);
    const body = await expectJson<{ preferences: unknown }>(res);
    expect(body.preferences).toBeNull();
  });
});

describe("PUT /api/settings/column-preferences", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "MOVIE", columns: ["title", "year"] },
    });
    await expectJson(res, 401);
  });

  it("updates column preferences for MOVIE type", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "MOVIE", columns: ["title", "year", "resolution"] },
    });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("updates column preferences for SERIES type", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "SERIES", columns: ["title", "seasonNumber"] },
    });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
  });

  it("GET after PUT returns updated column preferences", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const columns = ["title", "year", "fileSize"];
    await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "MOVIE", columns },
    });

    const res = await callRoute(getColumnPreferences);
    const body = await expectJson<{
      preferences: Record<string, string[]>;
    }>(res);
    expect(body.preferences).toEqual({ MOVIE: columns });
  });

  it("merges preferences for different media types", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "MOVIE", columns: ["title", "year"] },
    });

    await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "SERIES", columns: ["title", "seasonNumber"] },
    });

    const res = await callRoute(getColumnPreferences);
    const body = await expectJson<{
      preferences: Record<string, string[]>;
    }>(res);
    expect(body.preferences).toEqual({
      MOVIE: ["title", "year"],
      SERIES: ["title", "seasonNumber"],
    });
  });

  it("rejects missing type", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { columns: ["title"] },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("rejects missing columns", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "MOVIE" },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("rejects invalid media type", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putColumnPreferences, {
      method: "PUT",
      body: { type: "INVALID", columns: ["title"] },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });
});

// ---------------------------------------------------------------------------
// /api/settings/dashboard-layout
// ---------------------------------------------------------------------------
describe("GET /api/settings/dashboard-layout", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getDashboardLayout);
    await expectJson(res, 401);
  });

  it("returns null layout for new user", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getDashboardLayout);
    const body = await expectJson<{ layout: unknown }>(res);
    // Default dashboardLayout is null in the schema
    expect(body.layout).toBeNull();
  });
});

describe("PUT /api/settings/dashboard-layout", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putDashboardLayout, {
      method: "PUT",
      body: {
        layout: {
          main: [{ id: "stats", size: 12 }],
          movies: [],
          series: [],
          music: [],
        },
      },
    });
    await expectJson(res, 401);
  });

  it("updates dashboard layout with a valid layout", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const layout = {
      main: [
        { id: "stats", size: 12 },
        { id: "top-played", size: 12 },
      ],
      movies: [{ id: "quality-breakdown", size: 12 }],
      series: [{ id: "quality-breakdown", size: 6 }],
      music: [],
    };

    const res = await callRoute(putDashboardLayout, {
      method: "PUT",
      body: { layout },
    });
    const body = await expectJson<{ layout: unknown }>(res);
    expect(body.layout).toEqual(layout);
  });

  it("GET after PUT returns updated layout", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const layout = {
      main: [{ id: "stats", size: 12 }],
      movies: [],
      series: [],
      music: [],
    };

    await callRoute(putDashboardLayout, {
      method: "PUT",
      body: { layout },
    });

    const res = await callRoute(getDashboardLayout);
    const body = await expectJson<{ layout: unknown }>(res);
    expect(body.layout).toEqual(layout);
  });

  it("rejects layout with missing tabs", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putDashboardLayout, {
      method: "PUT",
      body: {
        layout: {
          main: [{ id: "stats", size: 12 }],
          // missing movies, series, music
        },
      },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toContain("Invalid dashboard layout");
  });

  it("rejects layout with invalid card id", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putDashboardLayout, {
      method: "PUT",
      body: {
        layout: {
          main: [{ id: "nonexistent-card", size: 12 }],
          movies: [],
          series: [],
          music: [],
        },
      },
    });
    await expectJson(res, 400);
  });

  it("rejects layout with card in disallowed tab", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    // "stats" is only allowed in "main" tab
    const res = await callRoute(putDashboardLayout, {
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

  it("rejects non-object layout", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putDashboardLayout, {
      method: "PUT",
      body: { layout: "not-an-object" },
    });
    await expectJson(res, 400);
  });
});

// ---------------------------------------------------------------------------
// /api/settings/log-retention
// ---------------------------------------------------------------------------
describe("GET /api/settings/log-retention", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(getLogRetention);
    await expectJson(res, 401);
  });

  it("returns default log retention (7 days) when no settings exist", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(getLogRetention);
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(7);
  });
});

describe("PUT /api/settings/log-retention", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 30 },
    });
    await expectJson(res, 401);
  });

  it("updates log retention to a valid value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 30 },
    });
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(30);
  });

  it("GET after PUT returns updated value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 90 },
    });

    const res = await callRoute(getLogRetention);
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(90);
  });

  it("accepts minimum value of 1", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 1 },
    });
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(1);
  });

  it("accepts maximum value of 365", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 365 },
    });
    const body = await expectJson<{ logRetentionDays: number }>(res);
    expect(body.logRetentionDays).toBe(365);
  });

  it("rejects value less than 1", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 0 },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("rejects value greater than 365", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: 366 },
    });
    const body = await expectJson<{ error: string }>(res, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("rejects non-number value", async () => {
    const user = await createTestUser();
    setMockSession({
      isLoggedIn: true,
      userId: user.id,
      plexToken: "tok",
    });

    const res = await callRoute(putLogRetention, {
      method: "PUT",
      body: { logRetentionDays: "thirty" },
    });
    await expectJson(res, 400);
  });
});
