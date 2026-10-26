import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { validateRequest, prerollScheduleUpdateSchema, TIME_REGEX } from "@/lib/validation";
import { checkConflict } from "@/lib/preroll/schedule-conflict";

const VALID_SCHEDULE_TYPES = ["one_time", "recurring", "seasonal"];
const VALID_DAYS = [0, 1, 2, 3, 4, 5, 6];

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

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, prerollScheduleUpdateSchema);
  if (error) return error;
  const body = data as ScheduleInput;

  // Verify ownership
  const existing = await prisma.prerollSchedule.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Build merged input for validation
  const merged: ScheduleInput = {
    name: body.name ?? existing.name,
    prerollPath: body.prerollPath ?? existing.prerollPath,
    scheduleType: body.scheduleType ?? existing.scheduleType,
    startDate: body.startDate ?? existing.startDate?.toISOString(),
    endDate: body.endDate ?? existing.endDate?.toISOString(),
    daysOfWeek: body.daysOfWeek ?? (existing.daysOfWeek as number[] | undefined) ?? undefined,
    startTime: body.startTime ?? existing.startTime ?? undefined,
    endTime: body.endTime ?? existing.endTime ?? undefined,
    priority: body.priority ?? existing.priority,
    enabled: body.enabled ?? existing.enabled,
  };

  // Refused as on create: a blank name or path passed the schema and was
  // stored as "" once trimmed.
  if (body.name !== undefined && body.name.trim() === "") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (body.prerollPath !== undefined && body.prerollPath.trim() === "") {
    return NextResponse.json({ error: "Preroll path is required" }, { status: 400 });
  }

  // A date sent without a type is written whatever the schedule's type, so it
  // must parse: an unparseable one compared as NaN (passing the start-before-end
  // check) and reached the database write as an Invalid Date.
  for (const [label, value] of [["Start date", body.startDate], ["End date", body.endDate]] as const) {
    if (value !== undefined && isNaN(new Date(value).getTime())) {
      return NextResponse.json({ error: `${label} must be a valid date` }, { status: 400 });
    }
  }

  // Validate schedule type specific fields if schedule type is being changed or set
  if (merged.scheduleType && !VALID_SCHEDULE_TYPES.includes(merged.scheduleType)) {
    return NextResponse.json(
      { error: "Schedule type must be one_time, recurring, or seasonal" },
      { status: 400 }
    );
  }

  if (merged.scheduleType === "one_time" || merged.scheduleType === "seasonal") {
    if (!merged.startDate || !merged.endDate) {
      return NextResponse.json(
        { error: "Start date and end date are required for this schedule type" },
        { status: 400 }
      );
    }
    const start = new Date(merged.startDate);
    const end = new Date(merged.endDate);
    if (start >= end) {
      return NextResponse.json(
        { error: "Start date must be before end date" },
        { status: 400 }
      );
    }
  }

  if (merged.scheduleType === "recurring") {
    if (!merged.daysOfWeek || !Array.isArray(merged.daysOfWeek) || merged.daysOfWeek.length === 0) {
      return NextResponse.json(
        { error: "Days of week must be a non-empty array for recurring schedules" },
        { status: 400 }
      );
    }
    if (!merged.daysOfWeek.every((d) => VALID_DAYS.includes(d))) {
      return NextResponse.json(
        { error: "Days of week must contain values 0-6" },
        { status: 400 }
      );
    }
    if (!merged.startTime || !merged.endTime) {
      return NextResponse.json(
        { error: "Start time and end time are required for recurring schedules" },
        { status: 400 }
      );
    }
    if (!TIME_REGEX.test(merged.startTime) || !TIME_REGEX.test(merged.endTime)) {
      return NextResponse.json(
        { error: "Time must be in HH:mm format" },
        { status: 400 }
      );
    }
  }

  // Conflict detection (exclude self)
  if (merged.enabled !== false) {
    const allSchedules = await prisma.prerollSchedule.findMany({
      where: { userId: session.userId! },
    });
    const conflict = checkConflict(merged, allSchedules, id);
    if (conflict) {
      return NextResponse.json(
        {
          error: "Schedule conflicts with existing schedule",
          conflictingSchedule: conflict,
        },
        { status: 409 }
      );
    }
  }

  // With a type sent, the whole date/time definition is rewritten for it (the
  // validated merged values), as on create and in the blackout PUT: switching
  // type used to leave the old type's dates, days or times stored. Without
  // one, only the fields sent are written.
  const isDateType = merged.scheduleType === "one_time" || merged.scheduleType === "seasonal";
  const isRecurring = merged.scheduleType === "recurring";
  const definition =
    body.scheduleType !== undefined
      ? {
          scheduleType: body.scheduleType,
          startDate: isDateType ? new Date(merged.startDate!) : null,
          endDate: isDateType ? new Date(merged.endDate!) : null,
          daysOfWeek: isRecurring ? merged.daysOfWeek! : Prisma.DbNull,
          startTime: isRecurring ? merged.startTime! : null,
          endTime: isRecurring ? merged.endTime! : null,
        }
      : {
          ...(body.startDate !== undefined && { startDate: new Date(body.startDate) }),
          ...(body.endDate !== undefined && { endDate: new Date(body.endDate) }),
          ...(body.daysOfWeek !== undefined && { daysOfWeek: body.daysOfWeek }),
          ...(body.startTime !== undefined && { startTime: body.startTime }),
          ...(body.endTime !== undefined && { endTime: body.endTime }),
        };

  const schedule = await prisma.prerollSchedule.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.prerollPath !== undefined && { prerollPath: body.prerollPath.trim() }),
      ...definition,
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
    },
  });

  return NextResponse.json({ schedule });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Verify ownership
  const existing = await prisma.prerollSchedule.findFirst({
    where: { id, userId: session.userId! },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.prerollSchedule.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
