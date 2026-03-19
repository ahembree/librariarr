import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { validateRequest, titlePreferenceSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
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

  return NextResponse.json({
    preferredTitleServerId: settings.preferredTitleServerId,
    preferredArtworkServerId: settings.preferredArtworkServerId,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, titlePreferenceSchema);
  if (error) return error;
  const { serverId, field } = data;

  // null means "no preference", otherwise validate the server belongs to user
  if (serverId != null) {
    const server = await prisma.mediaServer.findFirst({
      where: { id: serverId, userId: session.userId },
      select: { id: true },
    });
    if (!server) {
      return NextResponse.json(
        { error: "Server not found" },
        { status: 400 }
      );
    }
  }

  const updateData: Record<string, string | null> = {};
  if (field === "artwork") {
    updateData.preferredArtworkServerId = serverId ?? null;
  } else {
    updateData.preferredTitleServerId = serverId ?? null;
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: updateData,
    create: { userId: session.userId, ...updateData },
  });

  // Recompute canonical items based on new server preference
  await recomputeCanonical(session.userId);

  return NextResponse.json({
    preferredTitleServerId: settings.preferredTitleServerId,
    preferredArtworkServerId: settings.preferredArtworkServerId,
  });
}
