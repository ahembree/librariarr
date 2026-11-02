import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, lifecycleScheduleSchema } from "@/lib/validation";
// The dispatcher's own rule: a cron it cannot evaluate would save and never run.
import { isValidSchedule } from "@/lib/jobs/schedule";

export const GET = withSession(async (session) => {
  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId },
    });
  }

  return NextResponse.json({
    lifecycleDetectionSchedule: settings.lifecycleDetectionSchedule,
    lastScheduledLifecycleDetection: settings.lastScheduledLifecycleDetection,
    lifecycleExecutionSchedule: settings.lifecycleExecutionSchedule,
    lastScheduledLifecycleExecution: settings.lastScheduledLifecycleExecution,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, lifecycleScheduleSchema);
  if (error) return error;

  const { lifecycleDetectionSchedule, lifecycleExecutionSchedule } = data;

  const updateData: Record<string, string> = {};

  if (lifecycleDetectionSchedule !== undefined) {
    if (!isValidSchedule(lifecycleDetectionSchedule)) {
      return NextResponse.json(
        { error: "Invalid detection schedule. Must be a preset or a valid cron expression." },
        { status: 400 }
      );
    }
    updateData.lifecycleDetectionSchedule = lifecycleDetectionSchedule;
  }

  if (lifecycleExecutionSchedule !== undefined) {
    if (!isValidSchedule(lifecycleExecutionSchedule)) {
      return NextResponse.json(
        { error: "Invalid execution schedule. Must be a preset or a valid cron expression." },
        { status: 400 }
      );
    }
    updateData.lifecycleExecutionSchedule = lifecycleExecutionSchedule;
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: "No schedule provided" }, { status: 400 });
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: updateData,
    create: { userId: session.userId, ...updateData },
  });

  return NextResponse.json({
    lifecycleDetectionSchedule: settings.lifecycleDetectionSchedule,
    lifecycleExecutionSchedule: settings.lifecycleExecutionSchedule,
  });
});
