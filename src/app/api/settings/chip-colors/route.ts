import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { announceDisplaySettingsChanged } from "@/lib/settings/display-settings-events";
import { validateRequest, chipColorsSchema } from "@/lib/validation";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { chipColors: true },
  });

  return NextResponse.json({
    chipColors: settings?.chipColors ?? null,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, chipColorsSchema);
  if (error) return error;

  const { chipColors } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { chipColors },
    create: {
      userId: session.userId,
      chipColors,
    },
  });

  announceDisplaySettingsChanged(session.userId);
  return NextResponse.json({ success: true });
});
