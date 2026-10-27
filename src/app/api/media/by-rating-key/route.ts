import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { sessionMediaType } from "@/lib/media/detail-panel-item";

/**
 * The synced library item a media server's rating key names — what the Stream
 * Manager opens the media detail panel on for a playing session. A rating key
 * is unique only within a library, so the session's type narrows the match,
 * and an answer still naming more than one item is a 404: opening the wrong
 * item's panel is worse than opening none.
 */
export const GET = withSession(async (session, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const serverId = params.get("serverId");
  const ratingKey = params.get("ratingKey");
  if (!serverId || !ratingKey || serverId.length > 200 || ratingKey.length > 200) {
    return NextResponse.json({ error: "serverId and ratingKey are required" }, { status: 400 });
  }
  // A type that names no library type (a trailer, a photo) has no item to
  // find; ignoring it would let the key match whatever else carries it.
  const rawType = params.get("type");
  const type = sessionMediaType(rawType);
  if (rawType && !type) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
});
