import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { apiLogger } from "@/lib/logger";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { validateRequest, serverEditSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { appCache } from "@/lib/cache/memory-cache";

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

  const { url, externalUrl, tlsSkipVerify, accessToken, enabled, deleteData } = data;

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
    },
  });

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

    await recomputeCanonical(session.userId!);

    apiLogger.info(
      "Auth",
      `Media server "${server.name}" disabled with data purge`
    );
  }

  // Invalidate caches when enabled state changes so media queries reflect immediately
  if (enabled !== undefined) {
    appCache.invalidatePrefix("server-filter:");
    appCache.invalidate("distinct-values");
  }

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

  if (deleteData) {
    // Delete all synced data: libraries, media items, and related records
    const libraries = await prisma.library.findMany({
      where: { mediaServerId: server.id },
      select: { id: true },
    });
    const libraryIds = libraries.map((l) => l.id);

    if (libraryIds.length > 0) {
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
  }

  // Delete sync jobs and the server record.
  // Libraries with onDelete: SetNull will have mediaServerId set to null
  // if deleteData was false, preserving the library and media item data.
  await prisma.syncJob.deleteMany({ where: { mediaServerId: server.id } });
  await prisma.mediaServer.delete({ where: { id: server.id } });

  apiLogger.info("Auth", `Media server "${server.name}" removed (deleteData=${deleteData})`);

  // Recompute canonical flags for remaining items
  await recomputeCanonical(session.userId!);

  return NextResponse.json({ success: true });
}
