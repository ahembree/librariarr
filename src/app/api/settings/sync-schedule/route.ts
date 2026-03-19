import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, syncScheduleSchema } from "@/lib/validation";
import cron from "node-cron";

const PRESET_SCHEDULES = ["MANUAL", "EVERY_6H", "EVERY_12H", "DAILY", "WEEKLY"];

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId! },
    });
  }

  return NextResponse.json({ settings });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, syncScheduleSchema);
  if (error) return error;

  const { syncSchedule } = data;

  if (!PRESET_SCHEDULES.includes(syncSchedule) && !cron.validate(syncSchedule)) {
    return NextResponse.json(
      { error: "Invalid schedule. Must be a preset or a valid cron expression (e.g. '0 */4 * * *')." },
      { status: 400 }
    );
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { syncSchedule },
    create: { userId: session.userId!, syncSchedule },
  });

  return NextResponse.json({ settings });
}
