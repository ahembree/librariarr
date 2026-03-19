import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, actionRetentionSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { actionHistoryRetentionDays: true },
  });

  return NextResponse.json({
    actionHistoryRetentionDays: settings?.actionHistoryRetentionDays ?? 30,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, actionRetentionSchema);
  if (error) return error;

  const { actionHistoryRetentionDays } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    create: {
      userId: session.userId!,
      actionHistoryRetentionDays,
    },
    update: { actionHistoryRetentionDays },
  });

  return NextResponse.json({ actionHistoryRetentionDays });
}
