import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

import { POST } from "@/app/api/tools/preroll/schedules/route";

async function post(body: Record<string, unknown>) {
  return callRoute(POST, { url: "/api/tools/preroll/schedules", method: "POST", body });
}

const RECURRING = {
  name: "Weekend",
  prerollPath: "/prerolls/weekend.mp4",
  scheduleType: "recurring",
  daysOfWeek: [0, 6],
  startTime: "18:00",
  endTime: "23:00",
};

const ONE_TIME = {
  name: "Holiday",
  prerollPath: "/prerolls/holiday.mp4",
  scheduleType: "one_time",
  startDate: "2026-12-20T00:00:00Z",
  endDate: "2026-12-27T00:00:00Z",
};

describe("POST /api/tools/preroll/schedules — validation and conflicts", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true });
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it.each([
    ["a whitespace-only name", { ...RECURRING, name: "   " }, "Name is required"],
    ["a whitespace-only path", { ...RECURRING, prerollPath: "  " }, "Preroll path is required"],
    [
      "a one-time schedule without an end date",
      { ...ONE_TIME, endDate: undefined },
      "Start date and end date are required for this schedule type",
    ],
    ["an unparseable date", { ...ONE_TIME, startDate: "not-a-date" }, "Invalid date format"],
    [
      "a seasonal schedule whose start is after its end",
      { ...ONE_TIME, scheduleType: "seasonal", startDate: ONE_TIME.endDate, endDate: ONE_TIME.startDate },
      "Start date must be before end date",
    ],
    [
      "a recurring schedule with no days",
      { ...RECURRING, daysOfWeek: [] },
      "Days of week must be a non-empty array for recurring schedules",
    ],
    [
      "a recurring schedule without an end time",
      { ...RECURRING, endTime: undefined },
      "Start time and end time are required for recurring schedules",
    ],
    ["an out-of-range time", { ...RECURRING, startTime: "24:00" }, "Time must be in HH:mm format"],
    ["a malformed end time", { ...RECURRING, endTime: "7:00" }, "Time must be in HH:mm format"],
  ])("rejects %s with 400", async (_label, body, message) => {
    const res = await post(body);
    const json = await expectJson<{ error: string }>(res, 400);
    expect(json.error).toBe(message);
    expect(await getTestPrisma().prerollSchedule.count()).toBe(0);
  });

  it("refuses a recurring schedule that overlaps an enabled one with 409 and names it", async () => {
    const first = await expectJson<{ schedule: { id: string } }>(await post(RECURRING), 201);

    const res = await post({ ...RECURRING, name: "Saturday night", daysOfWeek: [6], startTime: "22:00", endTime: "02:00" });
    const json = await expectJson<{ error: string; conflictingSchedule: { id: string; name: string } }>(res, 409);
    expect(json.error).toBe("Schedule conflicts with existing schedule");
    expect(json.conflictingSchedule).toEqual({ id: first.schedule.id, name: "Weekend" });
    expect(await getTestPrisma().prerollSchedule.count()).toBe(1);
  });

  it("refuses overlapping one-time date ranges", async () => {
    const first = await expectJson<{ schedule: { id: string } }>(await post(ONE_TIME), 201);
    const res = await post({ ...ONE_TIME, name: "Overlap", startDate: "2026-12-26T00:00:00Z", endDate: "2027-01-02T00:00:00Z" });
    const json = await expectJson<{ error: string; conflictingSchedule: { id: string; name: string } }>(res, 409);
    expect(json).toEqual({
      error: "Schedule conflicts with existing schedule",
      conflictingSchedule: { id: first.schedule.id, name: "Holiday" },
    });
    expect(await getTestPrisma().prerollSchedule.count()).toBe(1);
  });

  it("trims name and path, stores only the fields of its type, and applies defaults", async () => {
    const res = await post({
      ...ONE_TIME,
      name: "  Holiday  ",
      prerollPath: "  /prerolls/holiday.mp4 ",
      // Recurring-only fields are ignored for a date schedule.
      daysOfWeek: [1],
      startTime: "10:00",
      endTime: "11:00",
    });
    const { schedule } = await expectJson<{
      schedule: Record<string, unknown>;
    }>(res, 201);
    expect(schedule).toMatchObject({
      name: "Holiday",
      prerollPath: "/prerolls/holiday.mp4",
      scheduleType: "one_time",
      startDate: ONE_TIME.startDate.replace("Z", ".000Z"),
      endDate: ONE_TIME.endDate.replace("Z", ".000Z"),
      startTime: null,
      endTime: null,
      priority: 0,
      enabled: true,
      userId,
    });
    expect(schedule.daysOfWeek ?? null).toBeNull();
  });

  it("stores a recurring schedule's days and times but no dates, honouring priority and enabled", async () => {
    const res = await post({ ...RECURRING, startDate: ONE_TIME.startDate, priority: 5, enabled: false });
    const { schedule } = await expectJson<{ schedule: Record<string, unknown> }>(res, 201);
    expect(schedule).toMatchObject({
      daysOfWeek: [0, 6],
      startTime: "18:00",
      endTime: "23:00",
      startDate: null,
      endDate: null,
      priority: 5,
      enabled: false,
    });
  });
});
