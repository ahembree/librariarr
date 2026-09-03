import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { apiLogger } from "@/lib/logger";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { validateRequest, serverEditSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { eventBus } from "@/lib/events/event-bus";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const { data, error } = await validateRequest(request, serverEditSchema);
  if (error) return error;

  const { url, externalUrl, tlsSkipVerify, accessToken, enabled, deleteData, tracearrServerId } =
    data;

  // Did this server's watch-history source actually change? `undefined` means
  // the client never sent the field at all (leave the mapping alone), so only a
  // value that was sent AND differs from what is stored counts — re-saving the
  // same mapping must not trigger the wipe below.
  const tracearrMappingChanged =
    tracearrServerId !== undefined && tracearrServerId !== server.tracearrServerId;

  // Test connection if URL or access token changed (skip if just toggling enabled)
  if ((url || accessToken) && enabled !== false) {
    const testUrl = url ?? server.url;
    const testToken = accessToken ?? server.accessToken;
    const client = createMediaServerClient(server.type, testUrl, testToken, {
      skipTlsVerify: tlsSkipVerify ?? server.tlsSkipVerify,
    });
    const result = await client.testConnection();
    if (!result.ok) {
      return NextResponse.json(
        { error: "Failed to connect to server", detail: sanitizeErrorDetail(result.error) },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.mediaServer.update({
    where: { id: server.id },
    data: {
      ...(url !== undefined && { url }),
      ...(externalUrl !== undefined && { externalUrl: externalUrl || null }),
      ...(tlsSkipVerify !== undefined && { tlsSkipVerify }),
      ...(accessToken !== undefined && accessToken !== "" && { accessToken }),
      ...(enabled !== undefined && { enabled }),
      // `!== undefined`, never a truthy check: `null` is the meaningful
      // "unlink, go back to native history" value, and a truthy check would
      // make unlinking impossible to express.
      ...(tracearrServerId !== undefined && { tracearrServerId }),
    },
  });

  // A source switch (native <-> Tracearr, or one Tracearr server to another)
  // invalidates every WatchHistory row already stored for this server, because
  // the two sources have incompatible row models: the native sync is a
  // full-replace that leaves all of the rich Tracearr columns null, while the
  // Tracearr sync is an incremental append keyed on `sourceEventId`. Neither
  // path ever revisits the other's rows — the append model never wipes, and the
  // native full-replace only deletes rows on a *successful* fetch — so without
  // this one-shot delete the server would keep a permanent stratum of stale
  // rows from its previous source. The next sync repopulates from the new one.
  // Placed after the update so a failed write can't destroy history.
  if (tracearrMappingChanged) {
    const wiped = await prisma.watchHistory.deleteMany({
      where: { mediaServerId: server.id },
    });

    // Every watch-history-derived cache (`watch-history-filters:` among them)
    // now describes rows that no longer exist.
    invalidateMediaCaches();

    // Not a bug that the denormalized `MediaItem.playCount`/`lastPlayedAt` are
    // left standing: both watch-reconcile helpers are monotonic
    // (GREATEST/Math.max) by design, so nothing can make an item look *less*
    // recently watched — the safe direction for an engine that deletes files.
    // The next sync's reconcile re-establishes them from the new source's rows.

    apiLogger.info(
      "Auth",
      `Watch-history source for media server "${server.name}" changed ` +
        `(${server.tracearrServerId ?? "native"} -> ${tracearrServerId ?? "native"}); ` +
        `cleared ${wiped.count} stored watch-history rows`
    );
  }

  // Purge media data when disabling with deleteData
  if (enabled === false && deleteData) {
    const libraries = await prisma.library.findMany({
      where: { mediaServerId: server.id },
      select: { id: true },
    });
    const libraryIds = libraries.map((l) => l.id);

    if (libraryIds.length > 0) {
      await prisma.lifecycleAction.deleteMany({
        where: { mediaItem: { libraryId: { in: libraryIds } } },
      });
      await prisma.mediaItem.deleteMany({
        where: { libraryId: { in: libraryIds } },
      });
    }

    apiLogger.info(
      "Auth",
      `Media server "${server.name}" disabled with data purge`
    );
  }

  // Recompute canonical + invalidate caches whenever the enabled state changes:
  // enabling/disabling a server changes the enabled-server set that dedup
  // canonical selection is computed over, so items whose canonical lived on the
  // toggled server must be re-canonicalized to a still-enabled copy (otherwise
  // they vanish from multi-server listings). Also covers the delete-data path.
  if (enabled !== undefined) {
    await recomputeCanonical(session.userId!);
    invalidateMediaCaches();
  }

  // Reconcile the realtime WebSocket: an enable/disable, url/token, or TLS
  // change all affect whether/how we connect to this server.
  eventBus.emit({ type: "server:changed", userId: session.userId!, meta: { serverId: server.id } });

  return NextResponse.json({ server: sanitize(updated) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const deleteData = searchParams.get("deleteData") === "true";
  const userId = session.userId!;

  // Query libraries before server deletion (needed for lifecycle cleanup in both paths;
  // after deletion the SetNull cascade clears mediaServerId so we can't identify them)
  const libraries = await prisma.library.findMany({
    where: { mediaServerId: server.id },
    select: { id: true },
  });
  const libraryIds = libraries.map((l) => l.id);

  if (deleteData && libraryIds.length > 0) {
    // Delete all synced data: libraries, media items, and related records
    await prisma.lifecycleAction.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
    await prisma.mediaStream.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
    await prisma.mediaItemExternalId.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
    await prisma.mediaItem.deleteMany({
      where: { libraryId: { in: libraryIds } },
    });
    await prisma.library.deleteMany({
      where: { id: { in: libraryIds } },
    });
  }

  // Delete sync jobs and the server record.
  // Libraries with onDelete: SetNull will have mediaServerId set to null
  // if deleteData was false, preserving the library and media item data.
  await prisma.syncJob.deleteMany({ where: { mediaServerId: server.id } });
  await prisma.mediaServer.delete({ where: { id: server.id } });

  // Remove the deleted server from all lifecycle rule sets' serverIds arrays
  await prisma.$executeRawUnsafe(
    `UPDATE "RuleSet" SET "serverIds" = array_remove("serverIds", $1) WHERE $1 = ANY("serverIds") AND "userId" = $2`,
    server.id,
    userId
  );

  // Clean up stale matches and pending actions for items from the deleted server's libraries
  // (covers both orphaned rule sets and multi-server rule sets that still have other servers)
  if (libraryIds.length > 0 && !deleteData) {
    await prisma.lifecycleAction.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } }, status: "PENDING" },
    });
    await prisma.ruleMatch.deleteMany({
      where: { mediaItem: { libraryId: { in: libraryIds } } },
    });
  }

  // For rule sets that lost ALL servers, also clean up any remaining matches/actions
  // (catches edge cases like actions with null mediaItemId from prior orphaning)
  const orphanedRuleSets = await prisma.ruleSet.findMany({
    where: { userId, serverIds: { equals: [] } },
    select: { id: true },
  });
  if (orphanedRuleSets.length > 0) {
    const ruleSetIds = orphanedRuleSets.map((rs) => rs.id);
    await prisma.lifecycleAction.deleteMany({
      where: { ruleSetId: { in: ruleSetIds }, status: "PENDING" },
    });
    await prisma.ruleMatch.deleteMany({
      where: { ruleSetId: { in: ruleSetIds } },
    });
  }

  apiLogger.info("Auth", `Media server "${server.name}" removed (deleteData=${deleteData})`);

  // Invalidate caches that depend on server/media data
  invalidateMediaCaches();

  // Recompute canonical flags for remaining items
  await recomputeCanonical(userId);

  // Close the realtime WebSocket for the removed server.
  eventBus.emit({ type: "server:changed", userId, meta: { serverId: server.id } });

  return NextResponse.json({ success: true });
}
