import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import cron from "node-cron";
import { validateRequest, backupScheduleSchema } from "@/lib/validation";

const PRESET_SCHEDULES = ["MANUAL", "EVERY_6H", "EVERY_12H", "DAILY", "WEEKLY"];

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId! },
      select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true },
    });
  }

  return NextResponse.json(settings);
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, backupScheduleSchema);
  if (error) return error;
  const { backupSchedule, backupRetentionCount } = data;

  if (backupSchedule !== undefined) {
    if (!PRESET_SCHEDULES.includes(backupSchedule) && !cron.validate(backupSchedule)) {
      return NextResponse.json(
        { error: "Invalid schedule. Use a preset (MANUAL, EVERY_6H, EVERY_12H, DAILY, WEEKLY) or a valid cron expression." },
        { status: 400 }
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (backupSchedule !== undefined) updateData.backupSchedule = backupSchedule;
  if (backupRetentionCount !== undefined) updateData.backupRetentionCount = Number(backupRetentionCount);

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: updateData,
    create: { userId: session.userId!, ...updateData },
    select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true },
  });

  return NextResponse.json(settings);
}
