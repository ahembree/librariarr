import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRouteWithParams, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PUT } from "@/app/api/tools/blackout/[id]/route";

const prisma = getTestPrisma();
let userId: string;

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  const user = await createTestUser();
  userId = user.id;
  setMockSession({ isLoggedIn: true, userId });
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

function oneTime() {
  return prisma.blackoutSchedule.create({
    data: {
      userId,
      name: "Outage",
      scheduleType: "one_time",
      startDate: new Date("2030-01-01T00:00:00Z"),
      endDate: new Date("2030-01-02T00:00:00Z"),
      action: "terminate_immediate",
    },
  });
}

function recurring() {
  return prisma.blackoutSchedule.create({
    data: {
      userId,
      name: "Nightly",
      scheduleType: "recurring",
      daysOfWeek: [1, 3],
      startTime: "02:00",
      endTime: "04:00",
      action: "block_new_only",
    },
  });
}

function put(id: string, body: Record<string, unknown>) {
  return callRouteWithParams(PUT, { id }, { method: "PUT", body });
}

async function errorOf(res: Response) {
  return (await expectJson<{ error: string }>(res, 400)).error;
}

describe("PUT /api/tools/blackout/[id] validation", () => {
  it("rejects a body that fails the schema", async () => {
    const s = await oneTime();
    await expectJson(await put(s.id, { delay: -1 }), 400);
  });

  it("names the malformed startTime", async () => {
    const s = await recurring();
    expect(await errorOf(await put(s.id, { startTime: "7:00" }))).toBe("startTime must be in HH:mm format");
  });

  it("requires both dates when switching to one_time", async () => {
    const s = await recurring();
    expect(await errorOf(await put(s.id, { scheduleType: "one_time", startDate: "2030-01-01" }))).toBe(
      "startDate and endDate are required for one_time schedules",
    );
  });

  it("rejects unparseable dates", async () => {
    const s = await recurring();
    expect(
      await errorOf(await put(s.id, { scheduleType: "one_time", startDate: "soon", endDate: "later" })),
    ).toBe("startDate and endDate must be valid dates");
  });

  it("rejects a start date that is not before the end date", async () => {
    const s = await recurring();
    expect(
      await errorOf(
        await put(s.id, { scheduleType: "one_time", startDate: "2030-02-01T00:00:00Z", endDate: "2030-01-01T00:00:00Z" }),
      ),
    ).toBe("startDate must be before endDate");
  });

  it("requires days of week and times when switching to recurring", async () => {
    const s = await oneTime();
    expect(await errorOf(await put(s.id, { scheduleType: "recurring", daysOfWeek: [] }))).toBe(
      "daysOfWeek must be a non-empty array for recurring schedules",
    );
    expect(await errorOf(await put(s.id, { scheduleType: "recurring", daysOfWeek: [2], startTime: "01:00" }))).toBe(
      "startTime and endTime are required for recurring schedules",
    );
  });

  it("refuses a partial edit that empties or nulls daysOfWeek", async () => {
    const s = await recurring();
    expect(await errorOf(await put(s.id, { daysOfWeek: [] }))).toBe("daysOfWeek must be a non-empty array");
    expect(await errorOf(await put(s.id, { daysOfWeek: null }))).toBe("daysOfWeek must be a non-empty array");
  });
});

describe("PUT /api/tools/blackout/[id] writes", () => {
  it("switching to one_time rewrites the definition and clears the recurring fields", async () => {
    const s = await recurring();
    const body = await expectJson<{ schedule: Record<string, unknown> }>(
      await put(s.id, {
        scheduleType: "one_time",
        startDate: "2030-03-01T00:00:00Z",
        endDate: "2030-03-02T00:00:00Z",
      }),
      200,
    );
    expect(body.schedule).toMatchObject({
      scheduleType: "one_time",
      daysOfWeek: [],
      startTime: null,
      endTime: null,
    });
    expect(new Date(body.schedule.startDate as string).toISOString()).toBe("2030-03-01T00:00:00.000Z");
  });

  it("switching to recurring clears the dates", async () => {
    const s = await oneTime();
    const body = await expectJson<{ schedule: Record<string, unknown> }>(
      await put(s.id, { scheduleType: "recurring", daysOfWeek: [5], startTime: "20:00", endTime: "21:30" }),
      200,
    );
    expect(body.schedule).toMatchObject({
      scheduleType: "recurring",
      startDate: null,
      endDate: null,
      daysOfWeek: [5],
      startTime: "20:00",
      endTime: "21:30",
    });
  });

  it("applies a partial date edit to a one_time schedule and ignores recurring-only fields", async () => {
    const s = await oneTime();
    const body = await expectJson<{ schedule: Record<string, unknown> }>(
      await put(s.id, { endDate: "2030-01-05T00:00:00Z", startTime: "10:00", daysOfWeek: [1] }),
      200,
    );
    expect(new Date(body.schedule.endDate as string).toISOString()).toBe("2030-01-05T00:00:00.000Z");
    expect(new Date(body.schedule.startDate as string).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(body.schedule.startTime).toBeNull();
  });

  it("applies a partial daysOfWeek edit to a recurring schedule and ignores dates", async () => {
    const s = await recurring();
    const body = await expectJson<{ schedule: Record<string, unknown> }>(
      await put(s.id, { daysOfWeek: [0, 6], startDate: "2030-01-01T00:00:00Z" }),
      200,
    );
    expect(body.schedule.daysOfWeek).toEqual([0, 6]);
    expect(body.schedule.startDate).toBeNull();
    expect(body.schedule.startTime).toBe("02:00");
  });

  it("writes the general fields", async () => {
    const s = await oneTime();
    const body = await expectJson<{ schedule: Record<string, unknown> }>(
      await put(s.id, {
        name: "  Renamed ",
        action: "warn_then_terminate",
        message: "Back soon",
        delay: 60,
        enabled: false,
        excludedUsers: ["alice"],
      }),
      200,
    );
    expect(body.schedule).toMatchObject({
      name: "Renamed",
      action: "warn_then_terminate",
      message: "Back soon",
      delay: 60,
      enabled: false,
      excludedUsers: ["alice"],
    });
  });
});

describe("PUT /api/tools/blackout/[id] partial date edits", () => {
  it("refuses an end date before the stored start, and keeps the stored window", async () => {
    const s = await oneTime();
    expect(await errorOf(await put(s.id, { endDate: "2029-01-01T00:00:00Z" }))).toBe("startDate must be before endDate");
    const row = await prisma.blackoutSchedule.findUnique({ where: { id: s.id } });
    expect(row?.endDate?.toISOString()).toBe("2030-01-02T00:00:00.000Z");
  });

  it("refuses a start date after the stored end", async () => {
    const s = await oneTime();
    expect(await errorOf(await put(s.id, { startDate: "2031-01-01T00:00:00Z" }))).toBe("startDate must be before endDate");
  });

  it("refuses an unparseable date with a 400 rather than failing the write", async () => {
    const s = await oneTime();
    expect(await errorOf(await put(s.id, { startDate: "soon" }))).toBe("startDate and endDate must be valid dates");
    expect(await errorOf(await put(s.id, { endDate: "later" }))).toBe("startDate and endDate must be valid dates");
  });

  it("accepts a partial date edit that keeps the window in order", async () => {
    const s = await oneTime();
    const body = await expectJson<{ schedule: { startDate: string; endDate: string } }>(
      await put(s.id, { endDate: "2030-01-05T00:00:00Z" }),
      200,
    );
    expect(new Date(body.schedule.startDate).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(new Date(body.schedule.endDate).toISOString()).toBe("2030-01-05T00:00:00.000Z");
  });

  it("leaves a recurring schedule's ignored date fields unchecked", async () => {
    const s = await recurring();
    await expectJson(await put(s.id, { startDate: "not a date", name: "Renamed" }), 200);
    const row = await prisma.blackoutSchedule.findUnique({ where: { id: s.id } });
    expect(row?.name).toBe("Renamed");
    expect(row?.startDate).toBeNull();
  });
});
