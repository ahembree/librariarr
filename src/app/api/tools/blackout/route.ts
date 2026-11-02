import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, blackoutCreateSchema, TIME_REGEX } from "@/lib/validation";

export const GET = withSession(async (session) => {
  const schedules = await prisma.blackoutSchedule.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ schedules });
});

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, blackoutCreateSchema);
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

  const schedule = await prisma.blackoutSchedule.create({
    data: {
      userId: session.userId,
      name: name.trim(),
      scheduleType,
      startDate: scheduleType === "one_time" ? new Date(startDate!) : null,
      endDate: scheduleType === "one_time" ? new Date(endDate!) : null,
      daysOfWeek: scheduleType === "recurring" && Array.isArray(daysOfWeek) ? daysOfWeek : undefined,
      startTime: scheduleType === "recurring" ? startTime : null,
      endTime: scheduleType === "recurring" ? endTime : null,
      action,
      ...(message !== undefined && { message }),
      ...(delay !== undefined && { delay }),
      ...(enabled !== undefined && { enabled }),
      ...(Array.isArray(excludedUsers) && { excludedUsers }),
    },
  });

  return NextResponse.json({ schedule }, { status: 201 });
});
