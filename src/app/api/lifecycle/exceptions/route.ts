import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, exceptionCreateSchema } from "@/lib/validation";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");

  const where: Record<string, unknown> = {
    userId: session.userId,
  };

  if (type && type !== "ALL") {
    where.mediaItem = { type };
  }

  const exceptions = await prisma.lifecycleException.findMany({
    where,
    include: {
      mediaItem: {
        select: {
          id: true,
          title: true,
          parentTitle: true,
          type: true,
          year: true,
          thumbUrl: true,
          resolution: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ exceptions });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, exceptionCreateSchema);
  if (error) return error;

  const { mediaItemId, reason } = data;

  // Validate ownership: media item must belong to user's server
  const mediaItem = await prisma.mediaItem.findFirst({
    where: {
      id: mediaItemId,
      library: { mediaServer: { userId: session.userId } },
    },
    select: { id: true, title: true },
  });

  if (!mediaItem) {
    return NextResponse.json({ error: "Media item not found" }, { status: 404 });
  }

  // Upsert to handle duplicates gracefully
  const exception = await prisma.lifecycleException.upsert({
    where: {
      userId_mediaItemId: {
        userId: session.userId!,
        mediaItemId,
      },
    },
    update: { reason },
    create: {
      userId: session.userId!,
      mediaItemId,
      reason,
    },
  });

  // Remove any existing RuleMatch records for this media item
  await prisma.ruleMatch.deleteMany({
    where: {
      mediaItemId,
      ruleSet: { userId: session.userId },
    },
  });

  // Delete any PENDING LifecycleAction records for this media item
  await prisma.lifecycleAction.deleteMany({
    where: {
      mediaItemId,
      userId: session.userId!,
      status: "PENDING",
    },
  });

  return NextResponse.json({ exception }, { status: 201 });
}
