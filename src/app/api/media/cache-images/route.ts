import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { cacheImage, getCachedImageInfo, CACHE_WIDTH_ART } from "@/lib/image-cache/image-cache";
import { validateRequest, cacheImagesSchema } from "@/lib/validation";
import { logger } from "@/lib/logger";

interface CacheJob {
  userId: string;
  libraryTypes: string[];
  status: "RUNNING" | "COMPLETED" | "FAILED";
  totalItems: number;
  processedItems: number;
  cachedImages: number;
  skippedImages: number;
  failedImages: number;
  startedAt: number;
  /** Updated every time an item is processed — used for stale detection */
  lastHeartbeat: number;
  error?: string;
}

/** If no heartbeat for this long, the job is considered dead (server restarted). */
const HEARTBEAT_STALE_MS = 60_000;

// In-memory job state keyed by userId
const activeJobs = new Map<string, CacheJob>();

function getJobForUser(userId: string): CacheJob | null {
  const job = activeJobs.get(userId);
  if (!job) return null;

  // If the job claims to be running but hasn't heartbeated recently, mark it failed
  if (job.status === "RUNNING" && Date.now() - job.lastHeartbeat > HEARTBEAT_STALE_MS) {
    job.status = "FAILED";
    job.error = "Job interrupted (server may have restarted)";
    return job;
  }

  return job;
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = getJobForUser(session.userId);
  return NextResponse.json({ job: job ? sanitizeJob(job) : null });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, cacheImagesSchema);
  if (error) return error;

  const { libraryTypes } = data;

  // Check if already running
  const existing = getJobForUser(session.userId);
  if (existing && existing.status === "RUNNING") {
    return NextResponse.json(
      { error: "Image caching already in progress" },
      { status: 409 },
    );
  }

  // Find all media items across selected library types
  const items = await prisma.mediaItem.findMany({
    where: {
      library: {
        type: { in: libraryTypes },
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
      { error: "No media items found for the selected library types" },
      { status: 404 },
    );
  }

  const now = Date.now();
  const job: CacheJob = {
    userId: session.userId,
    libraryTypes,
    status: "RUNNING",
    totalItems: items.length,
    processedItems: 0,
    cachedImages: 0,
    skippedImages: 0,
    failedImages: 0,
    startedAt: now,
    lastHeartbeat: now,
  };
  activeJobs.set(session.userId, job);

  // Run caching in background
  processCacheJob(session.userId, job, items).catch((err) => {
    logger.error("ImageCache", "Bulk cache job failed", { error: String(err) });
    job.status = "FAILED";
    job.error = String(err);
  });

  return NextResponse.json({
    message: "Image caching started",
    totalItems: items.length,
  });
}

function sanitizeJob(job: CacheJob) {
  return {
    libraryTypes: job.libraryTypes,
    status: job.status,
    totalItems: job.totalItems,
    processedItems: job.processedItems,
    cachedImages: job.cachedImages,
    skippedImages: job.skippedImages,
    failedImages: job.failedImages,
    startedAt: job.startedAt,
    error: job.error,
  };
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
  userId: string,
  job: CacheJob,
  items: MediaItemForCache[],
) {
  const serverClients = new Map<string, ReturnType<typeof createMediaServerClient>>();

  for (const item of items) {
    const server = item.library.mediaServer;
    if (!server) {
      job.processedItems++;
      job.lastHeartbeat = Date.now();
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
    job.lastHeartbeat = Date.now();
  }

  job.status = "COMPLETED";
  logger.info("ImageCache", `Bulk cache completed for ${job.libraryTypes.join(", ")}`, {
    totalItems: job.totalItems,
    cachedImages: job.cachedImages,
    skippedImages: job.skippedImages,
    failedImages: job.failedImages,
    durationMs: Date.now() - job.startedAt,
  });

  // Clean up completed jobs after 60 seconds
  setTimeout(() => {
    const current = activeJobs.get(userId);
    if (current && current.status !== "RUNNING") {
      activeJobs.delete(userId);
    }
  }, 60_000);
}
