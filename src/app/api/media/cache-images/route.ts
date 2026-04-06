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
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  totalItems: number;
  processedItems: number;
  totalImages: number;
  processedImages: number;
  cachedImages: number;
  skippedImages: number;
  failedImages: number;
  totalCachedBytes: number;
  startedAt: number;
  lastHeartbeat: number;
  /** Set to true to signal the processing loop to stop */
  aborted: boolean;
  error?: string;
}

const HEARTBEAT_STALE_MS = 60_000;

const activeJobs = new Map<string, CacheJob>();

function getJobForUser(userId: string): CacheJob | null {
  const job = activeJobs.get(userId);
  if (!job) return null;

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

  const { libraryTypes, serverIds } = data;

  const existing = getJobForUser(session.userId);
  if (existing && existing.status === "RUNNING") {
    return NextResponse.json(
      { error: "Image caching already in progress" },
      { status: 409 },
    );
  }

  const serverFilter: Record<string, unknown> = { userId: session.userId, enabled: true };
  if (serverIds && serverIds.length > 0) {
    serverFilter.id = { in: serverIds };
  }

  const items = await prisma.mediaItem.findMany({
    where: {
      library: {
        type: { in: libraryTypes },
        mediaServer: serverFilter,
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

  let totalImages = 0;
  for (const item of items) {
    if (item.thumbUrl) totalImages++;
    if (item.artUrl) totalImages++;
    if (item.parentThumbUrl) totalImages++;
    if (item.seasonThumbUrl) totalImages++;
    if (Array.isArray(item.roles)) {
      for (const role of item.roles as Array<{ thumb?: string | null }>) {
        if (role.thumb) totalImages++;
      }
    }
  }

  const now = Date.now();
  const job: CacheJob = {
    userId: session.userId,
    libraryTypes,
    status: "RUNNING",
    totalItems: items.length,
    processedItems: 0,
    totalImages,
    processedImages: 0,
    cachedImages: 0,
    skippedImages: 0,
    failedImages: 0,
    totalCachedBytes: 0,
    startedAt: now,
    lastHeartbeat: now,
    aborted: false,
  };
  activeJobs.set(session.userId, job);

  processCacheJob(session.userId, job, items).catch((err) => {
    logger.error("ImageCache", "Bulk cache job failed", { error: String(err) });
    job.status = "FAILED";
    job.error = String(err);
  });

  return NextResponse.json({
    message: "Image caching started",
    totalItems: items.length,
    totalImages,
  });
}

export async function DELETE() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = activeJobs.get(session.userId);
  if (!job || job.status !== "RUNNING") {
    return NextResponse.json({ error: "No running cache job to stop" }, { status: 404 });
  }

  job.aborted = true;
  return NextResponse.json({ message: "Cache job stopping" });
}

function sanitizeJob(job: CacheJob) {
  return {
    libraryTypes: job.libraryTypes,
    status: job.status,
    totalItems: job.totalItems,
    processedItems: job.processedItems,
    totalImages: job.totalImages,
    processedImages: job.processedImages,
    cachedImages: job.cachedImages,
    skippedImages: job.skippedImages,
    failedImages: job.failedImages,
    totalCachedBytes: job.totalCachedBytes,
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
    if (job.aborted) break;

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

    if (Array.isArray(item.roles)) {
      for (const role of item.roles as Array<{ thumb?: string | null }>) {
        if (role.thumb) {
          imageUrls.push({ url: role.thumb });
        }
      }
    }

    for (const { url, maxWidth } of imageUrls) {
      if (job.aborted) break;

      try {
        const cached = await getCachedImageInfo(url, { maxWidth });
        if (cached) {
          job.skippedImages++;
          job.totalCachedBytes += cached.size;
          job.processedImages++;
          continue;
        }

        const result = await cacheImage(
          url,
          () => client.fetchImage(url),
          maxWidth ? { maxWidth } : undefined,
        );
        job.cachedImages++;
        job.totalCachedBytes += result.data.length;
      } catch {
        job.failedImages++;
      }
      job.processedImages++;
    }

    job.processedItems++;
    job.lastHeartbeat = Date.now();
  }

  if (job.aborted) {
    job.status = "CANCELLED";
    logger.info("ImageCache", `Bulk cache cancelled for ${job.libraryTypes.join(", ")}`, {
      totalItems: job.totalItems,
      processedItems: job.processedItems,
      cachedImages: job.cachedImages,
      durationMs: Date.now() - job.startedAt,
    });
  } else {
    job.status = "COMPLETED";
    logger.info("ImageCache", `Bulk cache completed for ${job.libraryTypes.join(", ")}`, {
      totalItems: job.totalItems,
      cachedImages: job.cachedImages,
      skippedImages: job.skippedImages,
      failedImages: job.failedImages,
      durationMs: Date.now() - job.startedAt,
    });
  }

  setTimeout(() => {
    const current = activeJobs.get(userId);
    if (current && current.status !== "RUNNING") {
      activeJobs.delete(userId);
    }
  }, 60_000);
}
