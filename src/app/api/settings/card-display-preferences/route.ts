import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, cardDisplayPreferencesSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { cardDisplayPreferences: true },
  });

  return NextResponse.json({
    preferences: settings?.cardDisplayPreferences ?? null,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, cardDisplayPreferencesSchema);
  if (error) return error;

  const json = JSON.parse(JSON.stringify(data.preferences));

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { cardDisplayPreferences: json },
    create: {
      userId: session.userId!,
      cardDisplayPreferences: json,
    },
  });

  return NextResponse.json({ success: true });
}
