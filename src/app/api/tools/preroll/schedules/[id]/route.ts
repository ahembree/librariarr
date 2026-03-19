import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, prerollScheduleUpdateSchema } from "@/lib/validation";

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

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
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
      const inputStart = new Date(input.startDate!);
      const inputEnd = new Date(input.endDate!);
      const otherStart = other.startDate!;
      const otherEnd = other.endDate!;

      if (inputStart < otherEnd && inputEnd > otherStart) {
        return { id: other.id, name: other.name };
      }
    }

    if (input.scheduleType === "recurring" && other.scheduleType === "recurring") {
      const inputDays = new Set(input.daysOfWeek!);
      const otherDays = (other.daysOfWeek as number[]) || [];
      const hasOverlappingDay = otherDays.some((d) => inputDays.has(d));

      if (hasOverlappingDay && other.startTime && other.endTime && input.startTime && input.endTime) {
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
  const existing = await prisma.prerollSchedule.findUnique({ where: { id } });
  if (!existing || existing.userId !== session.userId) {
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

  const schedule = await prisma.prerollSchedule.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.prerollPath !== undefined && { prerollPath: body.prerollPath.trim() }),
      ...(body.scheduleType !== undefined && { scheduleType: body.scheduleType }),
      ...(body.startDate !== undefined && { startDate: new Date(body.startDate) }),
      ...(body.endDate !== undefined && { endDate: new Date(body.endDate) }),
      ...(body.daysOfWeek !== undefined && { daysOfWeek: body.daysOfWeek }),
      ...(body.startTime !== undefined && { startTime: body.startTime }),
      ...(body.endTime !== undefined && { endTime: body.endTime }),
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
  const existing = await prisma.prerollSchedule.findUnique({ where: { id } });
  if (!existing || existing.userId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.prerollSchedule.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
