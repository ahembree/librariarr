import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { announceDisplaySettingsChanged } from "@/lib/settings/display-settings-events";
import { validateRequest, cardDisplayPreferencesSchema } from "@/lib/validation";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { cardDisplayPreferences: true },
  });

  return NextResponse.json({
    preferences: settings?.cardDisplayPreferences ?? null,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, cardDisplayPreferencesSchema);
  if (error) return error;

  const json = JSON.parse(JSON.stringify(data.preferences));

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { cardDisplayPreferences: json },
    create: {
      userId: session.userId,
      cardDisplayPreferences: json,
    },
  });

  announceDisplaySettingsChanged(session.userId);
  return NextResponse.json({ success: true });
});
