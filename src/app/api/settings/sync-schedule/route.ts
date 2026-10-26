import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, syncScheduleSchema } from "@/lib/validation";
// The dispatcher's own rule: a cron it cannot evaluate would save and never run.
import { isValidSchedule } from "@/lib/jobs/schedule";

// Only what the Scheduling tab reads. AppSettings also holds the backup
// passphrase, the OIDC client secret, the AI key and the Discord webhook URL;
// returning the whole row sent all four to the browser in plaintext, which the
// routes that own them take care never to do.
const SCHEDULE_SELECT = { syncSchedule: true, lastScheduledSync: true } as const;

export const GET = withSession(async (session) => {
  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: SCHEDULE_SELECT,
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId },
      select: SCHEDULE_SELECT,
    });
  }

  return NextResponse.json({ settings });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, syncScheduleSchema);
  if (error) return error;

  const { syncSchedule } = data;

  if (!isValidSchedule(syncSchedule)) {
    return NextResponse.json(
      { error: "Invalid schedule. Must be a preset or a valid cron expression (e.g. '0 */4 * * *')." },
      { status: 400 }
    );
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { syncSchedule },
    create: { userId: session.userId, syncSchedule },
    select: SCHEDULE_SELECT,
  });

  return NextResponse.json({ settings });
});
