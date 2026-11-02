import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, logRetentionSchema } from "@/lib/validation";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { logRetentionDays: true },
  });

  return NextResponse.json({
    logRetentionDays: settings?.logRetentionDays ?? 7,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, logRetentionSchema);
  if (error) return error;

  const { logRetentionDays } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    create: {
      userId: session.userId,
      logRetentionDays,
    },
    update: { logRetentionDays },
  });

  return NextResponse.json({ logRetentionDays });
});
