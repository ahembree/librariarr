import { NextResponse } from "next/server";
import { CronExpressionParser } from "cron-parser";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { presetToCron, getSystemTimezone } from "@/lib/scheduler/scheduler";

function getNextRun(schedule: string, scheduledJobTime: string): string | null {
  if (schedule === "MANUAL") return null;

  const now = new Date();

  // Convert preset schedules to cron using the user's time anchor
  const cronExpr = presetToCron(schedule, scheduledJobTime) ?? schedule;

  try {
    const tz = getSystemTimezone();
    const interval = CronExpressionParser.parse(cronExpr, { currentDate: now, tz });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findFirst({
    where: { userId: session.userId! },
  });

  const timezone = getSystemTimezone();

  if (!settings) {
    return NextResponse.json({
      scheduledJobTime: "00:00",
      timezone,
      sync: { nextRun: null, lastRun: null },
      detection: { nextRun: null, lastRun: null },
      execution: { nextRun: null, lastRun: null },
    });
  }

  const { scheduledJobTime } = settings;

  return NextResponse.json({
    scheduledJobTime,
    timezone,
    sync: {
      nextRun: getNextRun(settings.syncSchedule, scheduledJobTime),
      lastRun: settings.lastScheduledSync?.toISOString() ?? null,
    },
    detection: {
      nextRun: getNextRun(settings.lifecycleDetectionSchedule, scheduledJobTime),
      lastRun: settings.lastScheduledLifecycleDetection?.toISOString() ?? null,
    },
    execution: {
      nextRun: getNextRun(settings.lifecycleExecutionSchedule, scheduledJobTime),
      lastRun: settings.lastScheduledLifecycleExecution?.toISOString() ?? null,
    },
  });
}
