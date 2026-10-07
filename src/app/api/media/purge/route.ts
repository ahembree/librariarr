import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { invalidateWatchHistoryEvidence, requireLibraryResync } from "@/lib/media/watch-evidence";
import { eventBus } from "@/lib/events/event-bus";

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const libraryId = searchParams.get("libraryId");
  const type = searchParams.get("type");

  // Per-library purge
  if (libraryId) {
    const library = await prisma.library.findFirst({
      where: {
        id: libraryId,
        mediaServer: { userId: session.userId },
      },
      select: { id: true, title: true, type: true, mediaServerId: true, enabled: true },
    });

    if (!library) {
      return NextResponse.json({ error: "Library not found" }, { status: 404 });
    }

    // Deleting the items cascades through `WatchHistory.mediaItem`, so the
    // server's plays of them go too, and the re-sync brings the items back as
    // fresh rows with none. Until a complete library sync has re-added them,
    // no history pass may vouch for the server's play history — the next
    // detection run would read the missing plays as "nobody watched anything",
    // and `watchedByUser`'s negative forms, `playCount = 0` and "not played in
    // N months" would match everything the re-sync brings back. Taken BEFORE
    // the delete, so a history pass already running cannot establish the
    // marker over the gap; a Tracearr-mapped server's archive walk restarts
    // with it, since Tracearr still holds those plays.
    //
    // Not for a DISABLED library (Settings disables a library, then purges it
    // when asked to delete its data): no sync re-adds its items, so a hold
    // would pause the server's play-activity rules for nothing, until some
    // full sync released it. Re-enabling it later populates an empty library,
    // which takes the population hold then. The marker is still withdrawn, as
    // for any bulk loss of plays, until the next history sync re-establishes
    // it.
    if (library.mediaServerId) {
      if (library.enabled) {
        await requireLibraryResync([library.mediaServerId]);
      } else {
        await invalidateWatchHistoryEvidence([library.mediaServerId]);
      }
    }

    const result = await prisma.mediaItem.deleteMany({
      where: { libraryId: library.id },
    });
    // A shortfall the library's last pass recorded described the rows just
    // deleted; it must not count toward releasing the hold its refill is
    // waited on with (see `Library.shortPassSeenAt` in `sync-server.ts`).
    await prisma.library.update({ where: { id: library.id }, data: { shortPassSeenAt: null } });

    // Recompute canonical so surviving duplicates on other servers don't stay
    // non-canonical (and therefore vanish from multi-server listings) when the
    // purged library held the canonical copy.
    await recomputeCanonical(session.userId!);
    invalidateMediaCaches();

    apiLogger.info(
      "Media",
      `Purged ${result.count} media items from library "${library.title}"`
    );


    // Purge deletes MediaItems (and cascades their WatchHistory), so every open
    // library listing is pointing at rows that no longer exist. `sync:completed`
    // is the event the 16 library subscribers already refetch on.
    eventBus.emit({
      type: "sync:completed",
      userId: session.userId!,
      meta: { purged: result.count },
    });

    return NextResponse.json({ deleted: result.count });
  }

  // Type-wide purge (legacy path)
  if (!type || !["MOVIE", "SERIES", "MUSIC"].includes(type)) {
    return NextResponse.json(
      { error: "Invalid type. Must be MOVIE, SERIES, or MUSIC" },
      { status: 400 }
    );
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId, enabled: true },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  if (serverIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  const libraries = await prisma.library.findMany({
    where: {
      mediaServerId: { in: serverIds },
      type: type as "MOVIE" | "SERIES" | "MUSIC",
    },
    select: { id: true, mediaServerId: true, enabled: true },
  });
  const libraryIds = libraries.map((l) => l.id);

  if (libraryIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  // Same cascade and the same rule as the per-library purge, before the
  // delete: hold every server owning an ENABLED purged library, and only
  // withdraw the marker of a server whose purged libraries are all disabled.
  const serversOf = (enabled: boolean) =>
    new Set(
      libraries
        .filter((l) => l.enabled === enabled)
        .map((l) => l.mediaServerId)
        .filter((id): id is string => id !== null),
    );
  const heldServerIds = serversOf(true);
  await requireLibraryResync([...heldServerIds]);
  await invalidateWatchHistoryEvidence(
    [...serversOf(false)].filter((id) => !heldServerIds.has(id)),
  );

  const result = await prisma.mediaItem.deleteMany({
    where: { libraryId: { in: libraryIds } },
  });
  await prisma.library.updateMany({
    where: { id: { in: libraryIds } },
    data: { shortPassSeenAt: null },
  });

  await recomputeCanonical(session.userId!);
  invalidateMediaCaches();

  apiLogger.info(
    "Media",
    `Purged ${result.count} ${type} media items from ${libraryIds.length} libraries`
  );


  // Purge deletes MediaItems (and cascades their WatchHistory), so every open
  // library listing is pointing at rows that no longer exist. `sync:completed`
  // is the event the 16 library subscribers already refetch on.
  eventBus.emit({
    type: "sync:completed",
    userId: session.userId!,
    meta: { purged: result.count },
  });

  return NextResponse.json({ deleted: result.count });
}
