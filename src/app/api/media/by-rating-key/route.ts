import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { sessionMediaType } from "@/lib/media/detail-panel-item";

/**
 * The synced library item a media server's rating key names — what the Stream
 * Manager opens the media detail panel on for a playing session. A rating key
 * is unique only within a library, so the session's type narrows the match,
 * and an answer still naming more than one item is a 404: opening the wrong
 * item's panel is worse than opening none.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const serverId = params.get("serverId");
  const ratingKey = params.get("ratingKey");
  if (!serverId || !ratingKey || serverId.length > 200 || ratingKey.length > 200) {
    return NextResponse.json({ error: "serverId and ratingKey are required" }, { status: 400 });
  }
  const type = sessionMediaType(params.get("type"));

  const items = await prisma.mediaItem.findMany({
    where: {
      ratingKey,
      ...(type && { type }),
      library: { mediaServerId: serverId, mediaServer: { userId: session.userId } },
    },
    select: { id: true, type: true },
    take: 2,
  });

  if (items.length !== 1) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ id: items[0].id, type: items[0].type });
}
