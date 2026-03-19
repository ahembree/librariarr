import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, authSettingsSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      plexId: true,
      localUsername: true,
      passwordHash: true,
      username: true,
      appSettings: {
        select: { localAuthEnabled: true },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    plexConnected: !!user.plexId,
    localUsername: user.localUsername,
    hasPassword: !!user.passwordHash,
    localAuthEnabled: user.appSettings?.localAuthEnabled ?? false,
    displayName: user.username,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify user still exists (handles stale sessions after DB reset)
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, plexId: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, authSettingsSchema);
  if (error) return error;
  const { localAuthEnabled } = data;

  // Ensure the user has Plex connected before allowing local auth to be disabled
  if (!localAuthEnabled && !user.plexId) {
    return NextResponse.json(
      { error: "Cannot disable local auth without a connected Plex account" },
      { status: 400 }
    );
  }

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { localAuthEnabled },
    create: { userId: session.userId, localAuthEnabled },
  });

  return NextResponse.json({ localAuthEnabled });
}
