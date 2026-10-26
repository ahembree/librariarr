import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, actionRetentionSchema } from "@/lib/validation";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { actionHistoryRetentionDays: true },
  });

  return NextResponse.json({
    actionHistoryRetentionDays: settings?.actionHistoryRetentionDays ?? 30,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, actionRetentionSchema);
  if (error) return error;

  const { actionHistoryRetentionDays } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    create: {
      userId: session.userId,
      actionHistoryRetentionDays,
    },
    update: { actionHistoryRetentionDays },
  });

  return NextResponse.json({ actionHistoryRetentionDays });
});
