import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { announceDisplaySettingsChanged } from "@/lib/settings/display-settings-events";
import { validateRequest, accentColorSchema } from "@/lib/validation";
import { ACCENT_NAMES } from "@/lib/theme/accent-colors";

export const GET = withSession(async (session) => {
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

  // A preset that has since been removed ("blue") reads as the default.
  const accentColor = ACCENT_NAMES.includes(settings.accentColor)
    ? settings.accentColor
    : "default";
  return NextResponse.json({ accentColor });
});

export const PUT = withSession(async (session, request: NextRequest) => {
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

  announceDisplaySettingsChanged(session.userId);
  return NextResponse.json({ accentColor: settings.accentColor });
});
