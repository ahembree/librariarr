import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, scheduledJobTimeSchema } from "@/lib/validation";

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, scheduledJobTimeSchema);
  if (error) return error;

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { scheduledJobTime: data.scheduledJobTime },
    create: { userId: session.userId, scheduledJobTime: data.scheduledJobTime },
    select: { scheduledJobTime: true },
  });

  return NextResponse.json(settings);
});
