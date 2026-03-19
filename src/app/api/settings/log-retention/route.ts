import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, logRetentionSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { logRetentionDays: true },
  });

  return NextResponse.json({
    logRetentionDays: settings?.logRetentionDays ?? 7,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, logRetentionSchema);
  if (error) return error;

  const { logRetentionDays } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    create: {
      userId: session.userId!,
      logRetentionDays,
    },
    update: { logRetentionDays },
  });

  return NextResponse.json({ logRetentionDays });
}
