import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, prerollScheduleCreateSchema } from "@/lib/validation";

const VALID_SCHEDULE_TYPES = ["one_time", "recurring", "seasonal"];
const VALID_DAYS = [0, 1, 2, 3, 4, 5, 6];
const TIME_REGEX = /^\d{2}:\d{2}$/;

interface ScheduleInput {
  name?: string;
  prerollPath?: string;
  scheduleType?: string;
  startDate?: string;
  endDate?: string;
  daysOfWeek?: number[];
  startTime?: string;
  endTime?: string;
  priority?: number;
  enabled?: boolean;
}

function validateScheduleInput(body: ScheduleInput) {
  const { name, prerollPath, scheduleType, startDate, endDate, daysOfWeek, startTime, endTime } = body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return "Name is required";
  }
  if (!prerollPath || typeof prerollPath !== "string" || prerollPath.trim() === "") {
    return "Preroll path is required";
  }
  if (!scheduleType || !VALID_SCHEDULE_TYPES.includes(scheduleType)) {
    return "Schedule type must be one_time, recurring, or seasonal";
  }

  if (scheduleType === "one_time" || scheduleType === "seasonal") {
    if (!startDate || !endDate) {
      return "Start date and end date are required for this schedule type";
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return "Invalid date format";
    }
    if (start >= end) {
      return "Start date must be before end date";
    }
  }

  if (scheduleType === "recurring") {
    if (!daysOfWeek || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      return "Days of week must be a non-empty array for recurring schedules";
    }
    if (!daysOfWeek.every((d) => VALID_DAYS.includes(d))) {
      return "Days of week must contain values 0-6";
    }
    if (!startTime || !endTime) {
      return "Start time and end time are required for recurring schedules";
    }
    if (!TIME_REGEX.test(startTime) || !TIME_REGEX.test(endTime)) {
      return "Time must be in HH:mm format";
    }
  }

  return null;
}

interface ScheduleRecord {
  id: string;
  enabled: boolean;
  scheduleType: string;
  startDate: Date | null;
  endDate: Date | null;
  daysOfWeek: unknown;
  startTime: string | null;
  endTime: string | null;
  name: string;
}

function checkConflict(
  input: ScheduleInput,
  existing: ScheduleRecord[],
  excludeId?: string
): { id: string; name: string } | null {
  const candidates = existing.filter(
    (s) => s.enabled && s.id !== excludeId
  );

  for (const other of candidates) {
    if (
      (input.scheduleType === "one_time" || input.scheduleType === "seasonal") &&
      (other.scheduleType === "one_time" || other.scheduleType === "seasonal")
    ) {
      // Date range overlap check
      const inputStart = new Date(input.startDate!);
      const inputEnd = new Date(input.endDate!);
      const otherStart = other.startDate!;
      const otherEnd = other.endDate!;

      if (inputStart < otherEnd && inputEnd > otherStart) {
        return { id: other.id, name: other.name };
      }
    }

    if (input.scheduleType === "recurring" && other.scheduleType === "recurring") {
      // Check day overlap
      const inputDays = new Set(input.daysOfWeek!);
      const otherDays = (other.daysOfWeek as number[]) || [];
      const hasOverlappingDay = otherDays.some((d) => inputDays.has(d));

      if (hasOverlappingDay && other.startTime && other.endTime && input.startTime && input.endTime) {
        // Check time overlap
        const inputStartMin = timeToMinutes(input.startTime);
        const inputEndMin = timeToMinutes(input.endTime);
        const otherStartMin = timeToMinutes(other.startTime);
        const otherEndMin = timeToMinutes(other.endTime);

        if (inputStartMin < otherEndMin && inputEndMin > otherStartMin) {
          return { id: other.id, name: other.name };
        }
      }
    }
  }

  return null;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const schedules = await prisma.prerollSchedule.findMany({
    where: { userId: session.userId! },
    orderBy: { priority: "desc" },
  });

  return NextResponse.json({ schedules });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, prerollScheduleCreateSchema);
  if (error) return error;
  const body = data as ScheduleInput;
  const validationError = validateScheduleInput(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Conflict detection
  const existingSchedules = await prisma.prerollSchedule.findMany({
    where: { userId: session.userId! },
  });

  const conflict = checkConflict(body, existingSchedules);
  if (conflict) {
    return NextResponse.json(
      {
        error: "Schedule conflicts with existing schedule",
        conflictingSchedule: conflict,
      },
      { status: 409 }
    );
  }

  const isDateType = body.scheduleType === "one_time" || body.scheduleType === "seasonal";
  const isRecurring = body.scheduleType === "recurring";

  const schedule = await prisma.prerollSchedule.create({
    data: {
      userId: session.userId!,
      name: body.name!.trim(),
      prerollPath: body.prerollPath!.trim(),
      scheduleType: body.scheduleType!,
      startDate: isDateType && body.startDate ? new Date(body.startDate) : null,
      endDate: isDateType && body.endDate ? new Date(body.endDate) : null,
      daysOfWeek: isRecurring ? body.daysOfWeek : undefined,
      startTime: isRecurring ? body.startTime ?? null : null,
      endTime: isRecurring ? body.endTime ?? null : null,
      priority: body.priority ?? 0,
      enabled: body.enabled ?? true,
    },
  });

  return NextResponse.json({ schedule }, { status: 201 });
}
