import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { cacheImage, getCachedImageInfo, CACHE_WIDTH_ART } from "@/lib/image-cache/image-cache";
import { validateRequest, cacheImagesSchema } from "@/lib/validation";
import { logger } from "@/lib/logger";

interface CacheJob {
  userId: string;
  libraryType: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  totalItems: number;
  processedItems: number;
  cachedImages: number;
  skippedImages: number;
  failedImages: number;
  startedAt: number;
  error?: string;
}

// In-memory job state keyed by `${userId}:${libraryType}`
const activeJobs = new Map<string, CacheJob>();

function jobKey(userId: string, libraryType: string): string {
  return `${userId}:${libraryType}`;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const libraryType = searchParams.get("libraryType");

  if (libraryType) {
    const job = activeJobs.get(jobKey(session.userId, libraryType));
    return NextResponse.json({ job: job ?? null });
  }

  // Return all jobs for the user
  const jobs: CacheJob[] = [];
  for (const [key, job] of activeJobs) {
    if (key.startsWith(session.userId)) {
      jobs.push(job);
    }
  }
  return NextResponse.json({ jobs });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, cacheImagesSchema);
  if (error) return error;

  const { libraryType } = data;
  const key = jobKey(session.userId, libraryType);

  // Check if already running
  const existing = activeJobs.get(key);
  if (existing && existing.status === "RUNNING") {
    return NextResponse.json(
      { error: "Image caching already in progress for this library type" },
      { status: 409 },
    );
  }

  // Find all media items with their server info
  const items = await prisma.mediaItem.findMany({
    where: {
      library: {
        type: libraryType,
        mediaServer: { userId: session.userId, enabled: true },
      },
    },
    select: {
      id: true,
      thumbUrl: true,
      artUrl: true,
      parentThumbUrl: true,
      seasonThumbUrl: true,
      roles: true,
      library: {
        select: {
          mediaServer: {
            select: {
              id: true,
              url: true,
              accessToken: true,
              tlsSkipVerify: true,
              type: true,
            },
          },
        },
      },
    },
  });

  if (items.length === 0) {
    return NextResponse.json(
      { error: "No media items found for this library type" },
      { status: 404 },
    );
  }

  const job: CacheJob = {
    userId: session.userId,
    libraryType,
    status: "RUNNING",
    totalItems: items.length,
    processedItems: 0,
    cachedImages: 0,
    skippedImages: 0,
    failedImages: 0,
    startedAt: Date.now(),
  };
  activeJobs.set(key, job);

  // Run caching in background
  processCacheJob(key, job, items).catch((err) => {
    logger.error("ImageCache", "Bulk cache job failed", { error: String(err) });
    job.status = "FAILED";
    job.error = String(err);
  });

  return NextResponse.json({
    message: "Image caching started",
    totalItems: items.length,
  });
}

type MediaItemForCache = {
  id: string;
  thumbUrl: string | null;
  artUrl: string | null;
  parentThumbUrl: string | null;
  seasonThumbUrl: string | null;
  roles: unknown;
  library: {
    mediaServer: {
      id: string;
      url: string;
      accessToken: string;
      tlsSkipVerify: boolean;
      type: "PLEX" | "JELLYFIN" | "EMBY";
    } | null;
  };
};

async function processCacheJob(
  key: string,
  job: CacheJob,
  items: MediaItemForCache[],
) {
  // Group items by server to reuse clients
  const serverClients = new Map<string, ReturnType<typeof createMediaServerClient>>();

  for (const item of items) {
    const server = item.library.mediaServer;
    if (!server) {
      job.processedItems++;
      continue;
    }

    if (!serverClients.has(server.id)) {
      serverClients.set(
        server.id,
        createMediaServerClient(server.type, server.url, server.accessToken, {
          skipTlsVerify: server.tlsSkipVerify,
        }),
      );
    }
    const client = serverClients.get(server.id)!;

    // Collect all image URLs for this item
    const imageUrls: Array<{ url: string; maxWidth?: number }> = [];

    if (item.thumbUrl) {
      imageUrls.push({ url: item.thumbUrl });
    }
    if (item.artUrl) {
      imageUrls.push({ url: item.artUrl, maxWidth: CACHE_WIDTH_ART });
    }
    if (item.parentThumbUrl) {
      imageUrls.push({ url: item.parentThumbUrl });
    }
    if (item.seasonThumbUrl) {
      imageUrls.push({ url: item.seasonThumbUrl });
    }

    // Cast/role thumbnails
    if (Array.isArray(item.roles)) {
      for (const role of item.roles as Array<{ thumb?: string | null }>) {
        if (role.thumb) {
          imageUrls.push({ url: role.thumb });
        }
      }
    }

    for (const { url, maxWidth } of imageUrls) {
      try {
        // Check if already cached
        const cached = await getCachedImageInfo(url, { maxWidth });
        if (cached) {
          job.skippedImages++;
          continue;
        }

        await cacheImage(
          url,
          () => client.fetchImage(url),
          maxWidth ? { maxWidth } : undefined,
        );
        job.cachedImages++;
      } catch {
        job.failedImages++;
      }
    }

    job.processedItems++;
  }

  job.status = "COMPLETED";
  logger.info("ImageCache", `Bulk cache completed for ${job.libraryType}`, {
    totalItems: job.totalItems,
    cachedImages: job.cachedImages,
    skippedImages: job.skippedImages,
    failedImages: job.failedImages,
    durationMs: Date.now() - job.startedAt,
  });

  // Clean up completed jobs after 30 seconds
  setTimeout(() => {
    const current = activeJobs.get(key);
    if (current && current.status !== "RUNNING") {
      activeJobs.delete(key);
    }
  }, 30_000);
}
