import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, accentColorSchema } from "@/lib/validation";
import { ACCENT_NAMES } from "@/lib/theme/accent-colors";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify user still exists (handles stale sessions after DB reset)
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId },
    });
  }

  return NextResponse.json({ accentColor: settings.accentColor });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, accentColorSchema);
  if (error) return error;

  const { accentColor } = data;

  if (!ACCENT_NAMES.includes(accentColor)) {
    return NextResponse.json(
      { error: `Invalid accent color. Must be one of: ${ACCENT_NAMES.join(", ")}` },
      { status: 400 }
    );
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { accentColor },
    create: { userId: session.userId, accentColor },
  });

  return NextResponse.json({ accentColor: settings.accentColor });
}
