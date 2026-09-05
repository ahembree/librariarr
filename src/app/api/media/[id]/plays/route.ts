import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { fetchPlayHistory, parsePlayHistoryPaging } from "@/lib/media/play-history";

/**
 * Per-play watch history for ONE media item — the movie/track equivalent of the
 * series-scoped route, and the reason both now share
 * `src/lib/media/play-history.ts`.
 *
 * Sibling to `/api/media/[id]/history`, and deliberately a separate endpoint
 * rather than a change to it, because the two answer different questions:
 *
 *  - `/history` — a per-user AGGREGATE (username, play count, last played),
 *    fetched LIVE from the media server. No per-play timestamps, no device, no
 *    completion, and nothing Tracearr adds. It is what the built-in Watch
 *    History card has always shown.
 *  - `/plays` (this route) — the individual play EVENTS from the stored
 *    `WatchHistory` table: who, exactly when, on what device, and for a
 *    Tracearr-sourced row the completion percentage, transcode decisions,
 *    player and stream quality.
 *
 * Series pages have had the per-play view since the series watch-history
 * feature; movies and tracks were still on the aggregate card, so the richer
 * Tracearr detail was visible on the History page and on episodes but not on a
 * film. This closes that gap without changing what `/history` returns, since
 * the aggregate is still the right answer for a server with no stored history.
 *
 * Every user's plays are included: `session.userId` is the Librariarr admin who
 * owns the server record, not a media-server account, and nothing filters on
 * `serverUsername`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Ownership guard on the ITEM, before any history is read — `findFirst`
  // through the library→server chain rather than a bare `findUnique`, so an id
  // belonging to another owner 404s instead of leaking its plays.
  const item = await prisma.mediaItem.findFirst({
    where: { id, library: { mediaServer: { userId: session.userId! } } },
    select: { id: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const { page, limit, serverId } = parsePlayHistoryPaging(searchParams);

  // Scoped to this one item deliberately, with no cross-server merge by
  // `dedupKey`. The same film on two servers is two rows the user can see and
  // navigate between, and a play belongs to the copy it happened on; merging
  // here would attribute another server's plays to this page.
  return NextResponse.json(
    await fetchPlayHistory({
      userId: session.userId!,
      mediaItemIds: [item.id],
      serverId,
      page,
      limit,
    }),
  );
}
