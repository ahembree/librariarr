import { NextResponse } from "next/server";
import { withApiKey, v1Error } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";
import type { LibraryType, Prisma } from "@/generated/prisma/client";

const LIBRARY_TYPES = new Set<string>(["MOVIE", "SERIES", "MUSIC"]);

/**
 * Flat list of every library across the user's servers — the shape an
 * integration needs to map a library id to a server without walking the nested
 * `/servers` payload first.
 */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const serverId = searchParams.get("serverId");

  if (type && !LIBRARY_TYPES.has(type)) {
    return v1Error("type must be one of MOVIE, SERIES, MUSIC", 400);
  }

  // Ownership lives on the server, so the filter is expressed through the
  // relation rather than trusting the caller-supplied serverId on its own.
  const where: Prisma.LibraryWhereInput = {
    mediaServer: { userId, ...(serverId ? { id: serverId } : {}) },
    ...(type ? { type: type as LibraryType } : {}),
  };

  const libraries = await prisma.library.findMany({
    where,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      enabled: true,
      lastSyncedAt: true,
      _count: { select: { mediaItems: true } },
      mediaServer: { select: { id: true, name: true, type: true } },
    },
  });

  const items = libraries.map((library) => ({
    id: library.id,
    key: library.key,
    title: library.title,
    type: library.type,
    enabled: library.enabled,
    lastSyncedAt: library.lastSyncedAt,
    itemCount: library._count.mediaItems,
    // Non-null by construction: the where clause requires an owning server.
    server: library.mediaServer!,
  }));

  return NextResponse.json({ libraries: sanitize(items) });
});
