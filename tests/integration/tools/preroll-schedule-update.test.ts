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

import { PUT } from "@/app/api/tools/preroll/schedules/[id]/route";

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

function oneTime(overrides: Record<string, unknown> = {}) {
  return prisma.prerollSchedule.create({
    data: {
      userId,
      name: "Holiday",
      prerollPath: "/prerolls/holiday.mp4",
      scheduleType: "one_time",
      startDate: new Date("2030-12-20T00:00:00Z"),
      endDate: new Date("2030-12-27T00:00:00Z"),
      ...overrides,
    },
  });
}

function recurring(overrides: Record<string, unknown> = {}) {
  return prisma.prerollSchedule.create({
    data: {
      userId,
      name: "Weekend",
      prerollPath: "/prerolls/weekend.mp4",
      scheduleType: "recurring",
      daysOfWeek: [0, 6],
      startTime: "18:00",
      endTime: "23:00",
      ...overrides,
    },
  });
}

function put(id: string, body: Record<string, unknown>) {
  return callRouteWithParams(PUT, { id }, { method: "PUT", body });
}

describe("PUT /api/tools/preroll/schedules/[id] validation", () => {
  it("rejects a body that fails the schema", async () => {
    const s = await oneTime();
    await expectJson(await put(s.id, { scheduleType: "monthly" }), 400);
  });

  it("requires both dates when switching a recurring schedule to one_time", async () => {
    const s = await recurring();
    const body = await expectJson<{ error: string }>(await put(s.id, { scheduleType: "one_time" }), 400);
    expect(body.error).toBe("Start date and end date are required for this schedule type");
  });

  it("rejects a start date that is not before the stored end date", async () => {
    const s = await oneTime();
    const body = await expectJson<{ error: string }>(
      await put(s.id, { startDate: "2031-01-01T00:00:00Z" }),
      400,
    );
    expect(body.error).toBe("Start date must be before end date");
  });

  it("requires days of week when switching a one_time schedule to recurring", async () => {
    const s = await oneTime();
    const body = await expectJson<{ error: string }>(await put(s.id, { scheduleType: "recurring" }), 400);
    expect(body.error).toBe("Days of week must be a non-empty array for recurring schedules");
  });

  it("rejects an empty days-of-week list", async () => {
    const s = await recurring();
    const body = await expectJson<{ error: string }>(await put(s.id, { daysOfWeek: [] }), 400);
    expect(body.error).toMatch(/non-empty array/);
  });

  it("rejects day values outside 0-6 stored on the row", async () => {
    const s = await recurring({ daysOfWeek: [7] });
    const body = await expectJson<{ error: string }>(await put(s.id, { name: "Renamed" }), 400);
    expect(body.error).toBe("Days of week must contain values 0-6");
  });

  it("requires start and end times for a recurring schedule", async () => {
    const s = await oneTime();
    const body = await expectJson<{ error: string }>(
      await put(s.id, { scheduleType: "recurring", daysOfWeek: [1] }),
      400,
    );
    expect(body.error).toBe("Start time and end time are required for recurring schedules");
  });

  it("rejects an out-of-range time", async () => {
    const s = await recurring();
    const body = await expectJson<{ error: string }>(await put(s.id, { endTime: "24:00" }), 400);
    expect(body.error).toBe("Time must be in HH:mm format");
  });

  it("rejects a stored schedule type the route does not know", async () => {
    const s = await oneTime({ scheduleType: "legacy" });
    const body = await expectJson<{ error: string }>(await put(s.id, { name: "x" }), 400);
    expect(body.error).toBe("Schedule type must be one_time, recurring, or seasonal");
  });
});

describe("PUT /api/tools/preroll/schedules/[id] conflicts and writes", () => {
  it("answers 409 when the edit overlaps another enabled schedule", async () => {
    await oneTime({ name: "Existing" });
    const other = await oneTime({
      name: "Other",
      startDate: new Date("2031-01-10T00:00:00Z"),
      endDate: new Date("2031-01-20T00:00:00Z"),
    });
    const body = await expectJson<{ error: string; conflictingSchedule: { name: string } }>(
      await put(other.id, { startDate: "2030-12-22T00:00:00Z", endDate: "2030-12-25T00:00:00Z" }),
      409,
    );
    expect(body.error).toBe("Schedule conflicts with existing schedule");
    expect(body.conflictingSchedule.name).toBe("Existing");
  });

  it("does not conflict with itself and skips conflict detection when disabled", async () => {
    await oneTime({ name: "Existing" });
    const overlapping = await oneTime({ name: "Overlap", enabled: false });

    // Disabled: an overlap is allowed.
    const ok = await expectJson<{ schedule: { name: string } }>(await put(overlapping.id, { name: " Still off " }), 200);
    expect(ok.schedule.name).toBe("Still off");

    // Enabling it now conflicts with the first.
    await expectJson(await put(overlapping.id, { enabled: true }), 409);
  });

  it("writes every provided field, trimming name and path", async () => {
    const s = await oneTime();
    const body = await expectJson<{ schedule: Record<string, unknown> }>(
      await put(s.id, {
        name: "  Weeknights ",
        prerollPath: " /prerolls/night.mp4 ",
        scheduleType: "recurring",
        daysOfWeek: [1, 2, 3],
        startTime: "22:00",
        endTime: "02:00",
        priority: 5,
        enabled: true,
      }),
      200,
    );
    expect(body.schedule).toMatchObject({
      name: "Weeknights",
      prerollPath: "/prerolls/night.mp4",
      scheduleType: "recurring",
      daysOfWeek: [1, 2, 3],
      startTime: "22:00",
      endTime: "02:00",
      priority: 5,
      enabled: true,
    });
  });

  it("updates a seasonal schedule's dates", async () => {
    const s = await oneTime({ scheduleType: "seasonal" });
    const body = await expectJson<{ schedule: { startDate: string; endDate: string } }>(
      await put(s.id, { startDate: "2030-11-01T00:00:00Z", endDate: "2030-11-30T00:00:00Z" }),
      200,
    );
    expect(new Date(body.schedule.startDate).toISOString()).toBe("2030-11-01T00:00:00.000Z");
    expect(new Date(body.schedule.endDate).toISOString()).toBe("2030-11-30T00:00:00.000Z");
    const row = await prisma.prerollSchedule.findUnique({ where: { id: s.id } });
    expect(row?.prerollPath).toBe("/prerolls/holiday.mp4");
  });
});

describe("PUT /api/tools/preroll/schedules/[id] date parsing", () => {
  async function errorOf(res: Response) {
    return (await expectJson<{ error: string }>(res, 400)).error;
  }

  it("refuses an unparseable start date instead of writing an Invalid Date", async () => {
    const s = await oneTime();
    expect(await errorOf(await put(s.id, { startDate: "garbage" }))).toBe("Start date must be a valid date");
    const row = await prisma.prerollSchedule.findUnique({ where: { id: s.id } });
    expect(row?.startDate?.toISOString()).toBe("2030-12-20T00:00:00.000Z");
  });

  it("refuses an unparseable end date", async () => {
    const s = await oneTime();
    expect(await errorOf(await put(s.id, { endDate: "never" }))).toBe("End date must be a valid date");
  });

  it("refuses an unparseable date on a recurring schedule too, since it would still be written", async () => {
    const s = await recurring();
    expect(await errorOf(await put(s.id, { startDate: "garbage" }))).toBe("Start date must be a valid date");
  });
});
