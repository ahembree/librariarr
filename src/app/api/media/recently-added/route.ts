import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const serverId = searchParams.get("serverId");

  const [servers, settings] = await Promise.all([
    prisma.mediaServer.findMany({
      where: { userId: session.userId, enabled: true },
      select: { id: true },
    }),
    prisma.appSettings.findUnique({
      where: { userId: session.userId! },
      select: { dedupStats: true },
    }),
  ]);
  let serverIds = servers.map((s) => s.id);
  const dedupEnabled = (settings?.dedupStats ?? true) && serverIds.length > 1 && !serverId;

  if (serverId) {
    if (!serverIds.includes(serverId)) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    serverIds = [serverId];
  }

  if (serverIds.length === 0) {
    return NextResponse.json({ items: [], total: 0 });
  }

  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "10", 10) || 10, 1), 50);
  const type = searchParams.get("type") as "MOVIE" | "SERIES" | null;

  const serverFilter = { library: { mediaServerId: { in: serverIds } } };
  const where = {
    ...serverFilter,
    addedAt: { not: null as null },
    ...(type ? { type } : {}),
    ...(dedupEnabled ? { dedupCanonical: true } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.mediaItem.findMany({
      where,
      orderBy: { addedAt: "desc" },
      take: limit,
      select: {
        id: true,
        title: true,
        year: true,
        type: true,
        parentTitle: true,
        seasonNumber: true,
        episodeNumber: true,
        addedAt: true,
        thumbUrl: true,
        parentThumbUrl: true,
      },
    }),
    prisma.mediaItem.count({ where }),
  ]);

  return NextResponse.json({
    items: items.map((item) => ({
      ...item,
      addedAt: item.addedAt?.toISOString() ?? null,
    })),
    total,
  });
}
