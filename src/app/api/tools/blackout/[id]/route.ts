import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, blackoutUpdateSchema } from "@/lib/validation";

const TIME_REGEX = /^\d{2}:\d{2}$/;

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

  // Validate based on scheduleType
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
    if (!TIME_REGEX.test(startTime) || !TIME_REGEX.test(endTime)) {
      return NextResponse.json({ error: "startTime and endTime must be in HH:mm format" }, { status: 400 });
    }
  }

  const schedule = await prisma.blackoutSchedule.update({
    where: { id },
    data: {
      name: name?.trim(),
      scheduleType,
      startDate: scheduleType === "one_time" ? new Date(startDate!) : null,
      endDate: scheduleType === "one_time" ? new Date(endDate!) : null,
      daysOfWeek: scheduleType === "recurring" ? daysOfWeek : undefined,
      startTime: scheduleType === "recurring" ? startTime : null,
      endTime: scheduleType === "recurring" ? endTime : null,
      action,
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
