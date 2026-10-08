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

    // The delete cascades through `WatchHistory.mediaItem`, and the re-sync
    // brings the items back with no plays: hold the server's play history until
    // a complete library sync, BEFORE the delete so a history pass already
    // running cannot vouch for the gap. A DISABLED library is never re-synced,
    // so it only withdraws the marker (re-enabling it takes the population hold).
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
    // A shortfall recorded against the deleted rows must not count toward the
    // release (`Library.shortPassSeenAt`).
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

  // As per library, before the delete: hold servers owning an ENABLED purged
  // library; only withdraw the marker where every purged library is disabled.
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
