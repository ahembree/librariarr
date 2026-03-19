import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const item = await prisma.mediaItem.findFirst({
    where: {
      id,
      library: {
        mediaServer: {
          userId: session.userId,
        },
      },
    },
    include: {
      streams: true,
      externalIds: {
        select: { source: true, externalId: true },
      },
      library: {
        include: {
          mediaServer: { select: { id: true, name: true, url: true, type: true, machineId: true } },
        },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Build play servers list (this item's server + any dedup siblings)
  const ms = item.library.mediaServer!;
  const playServers = [
    {
      serverName: ms.name,
      serverType: ms.type,
      serverUrl: ms.url,
      machineId: ms.machineId,
      ratingKey: item.ratingKey,
      parentRatingKey: item.parentRatingKey,
      grandparentRatingKey: item.grandparentRatingKey,
    },
  ];

  // If item has a dedup key, find copies on other servers
  if (item.dedupKey) {
    const siblings = await prisma.mediaItem.findMany({
      where: {
        dedupKey: item.dedupKey,
        id: { not: item.id },
        library: { mediaServer: { userId: session.userId } },
      },
      select: {
        ratingKey: true,
        parentRatingKey: true,
        grandparentRatingKey: true,
        library: {
          select: {
            mediaServer: { select: { id: true, name: true, url: true, type: true, machineId: true } },
          },
        },
      },
    });

    const seenServerIds = new Set([ms.id]);
    for (const sibling of siblings) {
      const sms = sibling.library.mediaServer!;
      if (!seenServerIds.has(sms.id)) {
        seenServerIds.add(sms.id);
        playServers.push({
          serverName: sms.name,
          serverType: sms.type,
          serverUrl: sms.url,
          machineId: sms.machineId,
          ratingKey: sibling.ratingKey,
          parentRatingKey: sibling.parentRatingKey,
          grandparentRatingKey: sibling.grandparentRatingKey,
        });
      }
    }

    playServers.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  return NextResponse.json({
    item: {
      ...item,
      fileSize: item.fileSize?.toString() ?? null,
    },
    playServers,
  });
}
