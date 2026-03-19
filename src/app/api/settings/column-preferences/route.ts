import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, columnPreferencesSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { columnPreferences: true },
  });

  return NextResponse.json({
    preferences: settings?.columnPreferences ?? null,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, columnPreferencesSchema);
  if (error) return error;

  const { type, columns } = data;

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { columnPreferences: true },
  });

  const existing = (settings?.columnPreferences ?? {}) as Record<string, string[]>;
  const updated = { ...existing, [type]: columns };
  const json = JSON.parse(JSON.stringify(updated));

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { columnPreferences: json },
    create: {
      userId: session.userId!,
      columnPreferences: json,
    },
  });

  return NextResponse.json({ success: true });
}
