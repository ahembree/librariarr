import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import type { MediaServerType } from "@/generated/prisma/client";

interface SiblingRow {
  id: string;
  ratingKey: string;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  serverId: string;
  serverName: string;
  serverUrl: string;
  externalUrl: string | null;
  serverType: MediaServerType;
  machineId: string | null;
}

export const GET = withSession(async (
  session,
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const itemQuery = prisma.mediaItem.findFirst({
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
          mediaServer: { select: { id: true, name: true, url: true, externalUrl: true, type: true, machineId: true } },
        },
      },
    },
  });

  // The copies on other servers, looked up beside the item rather than after
  // it: they need only its dedupKey, which a self-join reads from the same id,
  // so the two queries run together instead of one after the other. An item
  // that is not the caller's is refused below whatever this returns.
  const siblingsQuery = prisma.$queryRaw<SiblingRow[]>`
    SELECT s."id", s."ratingKey", s."parentRatingKey", s."grandparentRatingKey",
           ms."id" AS "serverId", ms."name" AS "serverName", ms."url" AS "serverUrl",
           ms."externalUrl", ms."type"::text AS "serverType", ms."machineId"
    FROM "MediaItem" self
    JOIN "MediaItem" s ON s."dedupKey" = self."dedupKey" AND s."id" <> self."id"
    JOIN "Library" l ON l."id" = s."libraryId"
    JOIN "MediaServer" ms ON ms."id" = l."mediaServerId"
    WHERE self."id" = ${id}
      AND self."dedupKey" IS NOT NULL
      AND ms."userId" = ${session.userId}
      AND ms."enabled" = true
    ORDER BY s."createdAt" ASC, s."id" ASC
  `;

  const [item, siblings] = await Promise.all([itemQuery, siblingsQuery]);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Build play servers list (this item's server + any dedup siblings)
  const ms = item.library.mediaServer;
  if (!ms) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const playServers = [
    {
      serverName: ms.name,
      serverType: ms.type,
      serverUrl: ms.url,
      externalUrl: ms.externalUrl,
      machineId: ms.machineId,
      ratingKey: item.ratingKey,
      parentRatingKey: item.parentRatingKey,
      grandparentRatingKey: item.grandparentRatingKey,
    },
  ];

  // Server presence array for metadata display
  const servers = [
    { serverId: ms.id, serverName: ms.name, serverType: ms.type, mediaItemId: item.id },
  ];

  // If item has a dedup key, list its copies on other servers. One entry per
  // server, the first copy kept: with two copies on one server, an unordered
  // read let heap order pick which copy's rating key the play link opens. The
  // oldest copy, as the grouped listings' presence (`getServerPresenceByGroup`)
  // picks it, then id — the query's order.
  if (item.dedupKey) {
    const seenServerIds = new Set([ms.id]);
    for (const sibling of siblings) {
      if (!seenServerIds.has(sibling.serverId)) {
        seenServerIds.add(sibling.serverId);
        playServers.push({
          serverName: sibling.serverName,
          serverType: sibling.serverType,
          serverUrl: sibling.serverUrl,
          externalUrl: sibling.externalUrl,
          machineId: sibling.machineId,
          ratingKey: sibling.ratingKey,
          parentRatingKey: sibling.parentRatingKey,
          grandparentRatingKey: sibling.grandparentRatingKey,
        });
        servers.push({
          serverId: sibling.serverId,
          serverName: sibling.serverName,
          serverType: sibling.serverType,
          mediaItemId: sibling.id,
        });
      }
    }

    playServers.sort((a, b) => a.serverName.localeCompare(b.serverName));
    servers.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  return jsonResponse(request, {
    item: {
      ...item,
      fileSize: item.fileSize?.toString() ?? null,
      servers,
    },
    playServers,
  });
});
