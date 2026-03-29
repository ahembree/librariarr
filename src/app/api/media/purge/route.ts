import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { appCache } from "@/lib/cache/memory-cache";

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
      select: { id: true, title: true, type: true },
    });

    if (!library) {
      return NextResponse.json({ error: "Library not found" }, { status: 404 });
    }

    const result = await prisma.mediaItem.deleteMany({
      where: { libraryId: library.id },
    });

    appCache.invalidatePrefix("server-filter:");
    appCache.invalidate("distinct-values");

    apiLogger.info(
      "Media",
      `Purged ${result.count} media items from library "${library.title}"`
    );

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
    select: { id: true },
  });
  const libraryIds = libraries.map((l) => l.id);

  if (libraryIds.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  const result = await prisma.mediaItem.deleteMany({
    where: { libraryId: { in: libraryIds } },
  });

  appCache.invalidatePrefix("server-filter:");
  appCache.invalidate("distinct-values");

  apiLogger.info(
    "Media",
    `Purged ${result.count} ${type} media items from ${libraryIds.length} libraries`
  );

  return NextResponse.json({ deleted: result.count });
}
