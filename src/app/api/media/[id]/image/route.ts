import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { apiLogger } from "@/lib/logger";
import { appCache } from "@/lib/cache/memory-cache";
import {
  cacheImage,
  getCachedImageInfo,
  streamCachedImage,
  CACHE_WIDTH_ART,
} from "@/lib/image-cache/image-cache";

const IMAGE_META_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");

  // Cache the DB query — this is the hottest path (hundreds of image requests per page)
  const item = await appCache.getOrSet(
    `image-meta:${id}`,
    () =>
      prisma.mediaItem.findUnique({
        where: { id },
        select: {
          thumbUrl: true,
          artUrl: true,
          parentThumbUrl: true,
          seasonThumbUrl: true,
          roles: true,
          library: {
            select: {
              mediaServer: {
                select: {
                  userId: true,
                  url: true,
                  accessToken: true,
                  tlsSkipVerify: true,
                  type: true,
                },
              },
            },
          },
        },
      }),
    IMAGE_META_TTL,
  );

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!item.library.mediaServer) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve thumb path based on type
  let thumbPath: string | null;
  if (type === "role") {
    const index = parseInt(searchParams.get("index") ?? "", 10);
    const roles = Array.isArray(item.roles) ? item.roles as Array<{ thumb?: string | null }> : [];
    thumbPath = (!isNaN(index) && index >= 0 && index < roles.length) ? roles[index]?.thumb ?? null : null;
  } else if (type === "art") {
    thumbPath = item.artUrl;
  } else if (type === "parent") {
    thumbPath = item.parentThumbUrl || item.thumbUrl;
  } else if (type === "season") {
    thumbPath = item.seasonThumbUrl || item.parentThumbUrl || item.thumbUrl;
  } else {
    thumbPath = item.thumbUrl;
  }

  if (!thumbPath) {
    return NextResponse.json({ error: "No thumbnail" }, { status: 404 });
  }

  const maxWidth = type === "art" ? CACHE_WIDTH_ART : undefined;

  // Fast path: check if cached image exists and handle ETag/304
  const cached = await getCachedImageInfo(thumbPath, { maxWidth });
  if (cached) {
    const etag = `"${cached.cacheKey}"`;

    // 304 Not Modified — browser already has this image
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, max-age=86400" },
      });
    }

    // Stream cached file directly — avoids loading full buffer into Node memory
    return new NextResponse(streamCachedImage(cached.filePath), {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(cached.size),
        "Cache-Control": "public, max-age=86400",
        "ETag": etag,
      },
    });
  }

  // Cache miss — fetch from media server, optimize, and cache
  const server = item.library.mediaServer;
  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
    skipTlsVerify: server.tlsSkipVerify,
  });

  try {
    const result = await cacheImage(
      thumbPath,
      () => client.fetchImage(thumbPath),
      maxWidth ? { maxWidth } : undefined,
    );
    const etag = `"${result.cacheKey}"`;
    return new NextResponse(new Uint8Array(result.data), {
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.data.length),
        "Cache-Control": "public, max-age=86400",
        "ETag": etag,
      },
    });
  } catch (error) {
    apiLogger.error("Media", "Failed to proxy image", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to fetch image" },
      { status: 502 }
    );
  }
}
