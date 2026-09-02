import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";

/**
 * The user's media servers with their libraries and item counts.
 *
 * Fields are selected explicitly (so `accessToken` is never loaded) and the
 * result still goes through `sanitize()` — the select list is the thing most
 * likely to grow a sensitive field by accident later, and the mask is the
 * backstop that makes that mistake harmless.
 */
export const GET = withApiKey(async (_request, { userId }) => {
  const servers = await prisma.mediaServer.findMany({
    where: { userId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      type: true,
      url: true,
      enabled: true,
      createdAt: true,
      libraries: {
        orderBy: [{ title: "asc" }, { id: "asc" }],
        select: {
          id: true,
          key: true,
          title: true,
          type: true,
          enabled: true,
          lastSyncedAt: true,
          _count: { select: { mediaItems: true } },
        },
      },
    },
  });

  const items = servers.map((server) => {
    const libraries = server.libraries.map((library) => ({
      id: library.id,
      key: library.key,
      title: library.title,
      type: library.type,
      enabled: library.enabled,
      lastSyncedAt: library.lastSyncedAt,
      itemCount: library._count.mediaItems,
    }));

    return {
      id: server.id,
      name: server.name,
      type: server.type,
      url: server.url,
      enabled: server.enabled,
      createdAt: server.createdAt,
      itemCount: libraries.reduce((sum, library) => sum + library.itemCount, 0),
      libraries,
    };
  });

  return NextResponse.json({ servers: sanitize(items) });
});
