import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, blackoutUpdateSchema } from "@/lib/validation";

// HH:mm, 00:00–23:59. The looser \d{2}:\d{2} accepted e.g. "27:99", which
// stored a schedule whose window never activates.
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Verify ownership
  const existing = await prisma.blackoutSchedule.findFirst({
    where: { id, userId: session.userId! },
  });

  if (!existing) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  const { data, error } = await validateRequest(request, blackoutUpdateSchema);
  if (error) return error;
  const { name, scheduleType, startDate, endDate, daysOfWeek, startTime, endTime, action, message, delay, enabled, excludedUsers } = data;

  // The type this update resolves against: either an explicit switch, or the
  // schedule's current type for a partial edit.
  const effectiveType = scheduleType ?? existing.scheduleType;

  // Any provided time must be well-formed, whichever way the update is shaped.
  for (const [label, value] of [["startTime", startTime], ["endTime", endTime]] as const) {
    if (value != null && !TIME_REGEX.test(value)) {
      return NextResponse.json({ error: `${label} must be in HH:mm format` }, { status: 400 });
    }
  }

  // Validate based on scheduleType (full definition on a type set/switch)
  if (scheduleType === "one_time") {
    if (!startDate || !endDate) {
      return NextResponse.json({ error: "startDate and endDate are required for one_time schedules" }, { status: 400 });
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ error: "startDate and endDate must be valid dates" }, { status: 400 });
    }
    if (start >= end) {
      return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
    }
  }

  if (scheduleType === "recurring") {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      return NextResponse.json({ error: "daysOfWeek must be a non-empty array for recurring schedules" }, { status: 400 });
    }
    if (!startTime || !endTime) {
      return NextResponse.json({ error: "startTime and endTime are required for recurring schedules" }, { status: 400 });
    }
  }

  // A partial edit that changes daysOfWeek must not leave an empty set.
  if (scheduleType === undefined && daysOfWeek !== undefined) {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      return NextResponse.json({ error: "daysOfWeek must be a non-empty array" }, { status: 400 });
    }
  }

  // When scheduleType is sent, rewrite the whole date/time definition. When it
  // is NOT sent, apply only the individually-provided fields against the
  // existing type — so editing just the times of a recurring schedule persists
  // (previously those fields were silently dropped), while a toggle-only body
  // ({ enabled }) still changes nothing else. (A blanket unconditional rewrite
  // was the original bug: it nulled the date/time columns on every partial PUT.)
  const scheduleTypeFields =
    scheduleType !== undefined
      ? {
          scheduleType,
          startDate: scheduleType === "one_time" ? new Date(startDate!) : null,
          endDate: scheduleType === "one_time" ? new Date(endDate!) : null,
          daysOfWeek: scheduleType === "recurring" && Array.isArray(daysOfWeek) ? daysOfWeek : [],
          startTime: scheduleType === "recurring" ? startTime : null,
          endTime: scheduleType === "recurring" ? endTime : null,
        }
      : {
          ...(effectiveType === "one_time" && startDate !== undefined && startDate !== null && { startDate: new Date(startDate) }),
          ...(effectiveType === "one_time" && endDate !== undefined && endDate !== null && { endDate: new Date(endDate) }),
          ...(effectiveType === "recurring" && Array.isArray(daysOfWeek) && { daysOfWeek }),
          ...(effectiveType === "recurring" && startTime !== undefined && startTime !== null && { startTime }),
          ...(effectiveType === "recurring" && endTime !== undefined && endTime !== null && { endTime }),
        };

  const schedule = await prisma.blackoutSchedule.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...scheduleTypeFields,
      ...(action !== undefined && { action }),
      ...(message !== undefined && { message }),
      ...(delay !== undefined && { delay }),
      ...(enabled !== undefined && { enabled }),
      ...(Array.isArray(excludedUsers) && { excludedUsers }),
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
  const existing = await prisma.blackoutSchedule.findFirst({
    where: { id, userId: session.userId! },
  });

  if (!existing) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  await prisma.blackoutSchedule.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
