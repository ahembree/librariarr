import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, backupScheduleSchema } from "@/lib/validation";
// The dispatcher's own rule: a cron it cannot evaluate would save and never run.
import { isValidSchedule } from "@/lib/jobs/schedule";

export const GET = withSession(async (session) => {
  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId },
      select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true },
    });
  }

  return NextResponse.json(settings);
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, backupScheduleSchema);
  if (error) return error;
  const { backupSchedule, backupRetentionCount } = data;

  if (backupSchedule !== undefined) {
    if (!isValidSchedule(backupSchedule)) {
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
    where: { userId: session.userId },
    update: updateData,
    create: { userId: session.userId, ...updateData },
    select: { backupSchedule: true, backupRetentionCount: true, lastBackupAt: true },
  });

  return NextResponse.json(settings);
});
