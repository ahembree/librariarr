import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { isUnreachable } from "@/lib/media-server/health-cache";
import { cacheImage, computeCacheKey, getCachedImageInfo } from "@/lib/image-cache/image-cache";
import { CACHE_WIDTH_GRID, CACHE_WIDTH_GRID_WIDE } from "@/lib/image-url";

/**
 * Warm the artwork cache for a server's library grids.
 *
 * The cache is otherwise populated lazily by `/api/media/[id]/image`, which
 * means the first browse of a cold library pays a media-server round trip plus
 * a sharp transcode per visible card — seconds of blank posters. This walks the
 * artwork the grids will ask for and fetches it ahead of time, right after a
 * sync, so the first visit is a disk read.
 *
 * Deliberately narrow:
 * - **Grid widths only.** Detail-panel (800px) and hero (1920px) variants stay
 *   lazy; they're one-per-page-view, not one-per-card.
 * - **Skips what's already cached**, so a re-run after an incremental sync
 *   costs a stat() per target rather than a refetch.
 * - **Capped per run** (see PREWARM_MAX_PER_RUN). The budget is spent on actual
 *   fetches, never on list positions: an already-cached target costs a stat()
 *   and no budget, so the next run skips everything previous runs warmed and
 *   spends its whole budget on new artwork. Capping the *list* instead would
 *   re-examine the same prefix every run and never reach the tail — the
 *   deliberately-deferred episode stills would stay cold forever.
 * - **Ordered cheapest-value-first** — posters before episode stills — so when
 *   the cap does bite, it trims the artwork least likely to be on screen.
 */

/** Concurrent fetch+transcode slots. sharp is CPU-bound and the media server
 *  generates thumbnails on demand, so this stays small on purpose: the job is
 *  background work and must not compete with live browsing. */
const PREWARM_CONCURRENCY = 3;

/** Upper bound on media-server fetches in a single run — successes and failures
 *  both spend it, since each one cost a round trip. Already-cached targets are
 *  skipped without spending budget, which is what makes progress monotonic
 *  across runs: a large library warms over several syncs rather than in one
 *  long burst. */
const PREWARM_MAX_PER_RUN = 5000;

/** Consecutive failures after which the run gives up. A media server that has
 *  started refusing requests will refuse the next 5000 too. */
const PREWARM_FAILURE_LIMIT = 20;

export interface PrewarmResult {
  /** Distinct artwork targets the grids would request. */
  considered: number;
  /** Fetched and cached during this run. */
  warmed: number;
  /** Already on disk — no media-server round trip. */
  alreadyCached: number;
  failed: number;
  /** True when the per-run fetch budget cut the run short. */
  capped: boolean;
  /** True when the failure limit or an unreachable server aborted the run. */
  abandoned: boolean;
}

interface Target {
  url: string;
  width: number;
}

/**
 * Collect the distinct artwork the library grids request, in warm order.
 *
 * The `COALESCE` chains mirror `resolveArtworkPath` for the `?type=` each grid
 * uses (series → `parent`, seasons/albums → `season`), and DISTINCT pushes the
 * dedup into Postgres — one show poster is shared by all of its episodes.
 */
async function collectTargets(serverId: string): Promise<Target[]> {
  const distinct = async (sql: Promise<{ url: string | null }[]>, width: number): Promise<Target[]> =>
    (await sql).flatMap((r) => (r.url ? [{ url: r.url, width }] : []));

  const [moviePosters, showPosters, seasonPosters, musicArtists, musicAlbums, episodeStills] =
    await Promise.all([
      distinct(prisma.$queryRaw`
        SELECT DISTINCT mi."thumbUrl" AS url FROM "MediaItem" mi
        JOIN "Library" l ON l.id = mi."libraryId"
        WHERE l."mediaServerId" = ${serverId} AND l.type = 'MOVIE' AND mi."thumbUrl" IS NOT NULL
      `, CACHE_WIDTH_GRID),
      distinct(prisma.$queryRaw`
        SELECT DISTINCT COALESCE(mi."parentThumbUrl", mi."thumbUrl") AS url FROM "MediaItem" mi
        JOIN "Library" l ON l.id = mi."libraryId"
        WHERE l."mediaServerId" = ${serverId} AND l.type = 'SERIES'
          AND COALESCE(mi."parentThumbUrl", mi."thumbUrl") IS NOT NULL
      `, CACHE_WIDTH_GRID),
      distinct(prisma.$queryRaw`
        SELECT DISTINCT COALESCE(mi."seasonThumbUrl", mi."parentThumbUrl", mi."thumbUrl") AS url
        FROM "MediaItem" mi JOIN "Library" l ON l.id = mi."libraryId"
        WHERE l."mediaServerId" = ${serverId} AND l.type = 'SERIES'
          AND COALESCE(mi."seasonThumbUrl", mi."parentThumbUrl", mi."thumbUrl") IS NOT NULL
      `, CACHE_WIDTH_GRID),
      distinct(prisma.$queryRaw`
        SELECT DISTINCT COALESCE(mi."parentThumbUrl", mi."thumbUrl") AS url FROM "MediaItem" mi
        JOIN "Library" l ON l.id = mi."libraryId"
        WHERE l."mediaServerId" = ${serverId} AND l.type = 'MUSIC'
          AND COALESCE(mi."parentThumbUrl", mi."thumbUrl") IS NOT NULL
      `, CACHE_WIDTH_GRID),
      distinct(prisma.$queryRaw`
        SELECT DISTINCT COALESCE(mi."seasonThumbUrl", mi."parentThumbUrl", mi."thumbUrl") AS url
        FROM "MediaItem" mi JOIN "Library" l ON l.id = mi."libraryId"
        WHERE l."mediaServerId" = ${serverId} AND l.type = 'MUSIC'
          AND COALESCE(mi."seasonThumbUrl", mi."parentThumbUrl", mi."thumbUrl") IS NOT NULL
      `, CACHE_WIDTH_GRID),
      // Landscape cards, and the one target that scales with episode count
      // rather than show count — warmed last so the cap trims these first.
      distinct(prisma.$queryRaw`
        SELECT DISTINCT mi."thumbUrl" AS url FROM "MediaItem" mi
        JOIN "Library" l ON l.id = mi."libraryId"
        WHERE l."mediaServerId" = ${serverId} AND l.type = 'SERIES' AND mi."thumbUrl" IS NOT NULL
      `, CACHE_WIDTH_GRID_WIDE),
    ]);

  // Plex appends a timestamp that `normalizeCacheUrl` strips, so two rows can
  // still collapse to one cached file — dedupe on the cache key, not the URL.
  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const t of [...moviePosters, ...showPosters, ...seasonPosters, ...musicArtists, ...musicAlbums, ...episodeStills]) {
    const key = computeCacheKey(t.url, t.width);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(t);
  }
  return targets;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order of start. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Warm grid artwork for one media server. Never throws — a prewarm failure must
 * not fail the sync that scheduled it; the lazy path still works.
 */
export async function prewarmServerArtwork(serverId: string): Promise<PrewarmResult> {
  const empty: PrewarmResult = {
    considered: 0, warmed: 0, alreadyCached: 0, failed: 0, capped: false, abandoned: false,
  };

  const server = await prisma.mediaServer.findUnique({
    where: { id: serverId },
    select: { id: true, userId: true, type: true, url: true, accessToken: true, tlsSkipVerify: true, enabled: true },
  });
  if (!server || !server.enabled) return empty;

  const settings = await prisma.appSettings.findUnique({
    where: { userId: server.userId },
    select: { prewarmArtwork: true },
  });
  if (settings && !settings.prewarmArtwork) return empty;

  if (isUnreachable(server.url)) {
    logger.info("ImageCache", "Skipping artwork prewarm — server is unreachable");
    return { ...empty, abandoned: true };
  }

  let targets: Target[];
  try {
    targets = await collectTargets(serverId);
  } catch (error) {
    // Best-effort by contract: a prewarm failure must never surface as a failed
    // job or disturb the sync that scheduled it. The lazy path still works.
    logger.error("ImageCache", "Artwork prewarm could not collect targets", { error: String(error) });
    return { ...empty, abandoned: true };
  }

  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
    skipTlsVerify: server.tlsSkipVerify,
  });

  const result: PrewarmResult = { ...empty, considered: targets.length };
  let consecutiveFailures = 0;
  /** Media-server fetches spent this run — a budget, not a list position. */
  let budgetSpent = 0;
  const started = Date.now();

  await mapWithConcurrency(targets, PREWARM_CONCURRENCY, async (target) => {
    // Once the budget is gone nothing further can be warmed, so stop rather
    // than stat()-ing the whole tail for no reason.
    if (result.abandoned || result.capped) return;

    if (await getCachedImageInfo(target.url, { maxWidth: target.width })) {
      result.alreadyCached++;
      return;
    }

    // Reserve synchronously, before any await, so concurrent workers cannot
    // collectively overshoot the budget.
    if (budgetSpent >= PREWARM_MAX_PER_RUN) {
      result.capped = true;
      return;
    }
    budgetSpent++;

    try {
      await cacheImage(
        target.url,
        () => client.fetchImage(target.url, { width: target.width }),
        { maxWidth: target.width },
      );
      result.warmed++;
      consecutiveFailures = 0;
    } catch (error) {
      result.failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= PREWARM_FAILURE_LIMIT || isUnreachable(server.url)) {
        result.abandoned = true;
        logger.warn("ImageCache", "Abandoning artwork prewarm — media server stopped responding", {
          error: String(error),
          warmed: result.warmed,
          failed: result.failed,
        });
      }
    }
  });

  if (result.warmed > 0 || result.failed > 0) {
    logger.info(
      "ImageCache",
      `Artwork prewarm: ${result.warmed} warmed, ${result.alreadyCached} already cached` +
        `${result.failed > 0 ? `, ${result.failed} failed` : ""} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }
  if (result.capped) {
    // Never let a truncated run read as "everything is warm".
    logger.info(
      "ImageCache",
      `Artwork prewarm hit the per-run fetch budget after ${budgetSpent} fetches ` +
        `(${result.warmed} warmed) across ${targets.length} targets; the rest follow on the next sync`,
    );
  }
  return result;
}
