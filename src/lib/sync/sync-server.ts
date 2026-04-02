import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaServerClient } from "@/lib/media-server/client";
import { PlexClient } from "@/lib/plex/client";
import { logger, dbLogger } from "@/lib/logger";
import type { MediaMetadataItem, MediaStream, MediaPart } from "@/lib/media-server/types";
import axios from "axios";
import v8 from "v8";
import { randomUUID } from "crypto";
import { invalidateCachedUrls, normalizeCacheUrl } from "@/lib/image-cache/image-cache";
import { computeDedupKey } from "@/lib/dedup/compute-dedup-key";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { withDeadlockRetry } from "@/lib/db-retry";
import { appCache } from "@/lib/cache/memory-cache";
import { normalizeResolutionFromDimensions } from "@/lib/resolution";
import { eventBus } from "@/lib/events/event-bus";
import { acquireSyncSlot, releaseSyncSlot } from "@/lib/sync/sync-semaphore";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";

// --- Filename-based detection using Trash-Guides naming conventions ---
// These regex patterns are derived from Trash-Guides custom format definitions:
// https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/
// https://trash-guides.info/Sonarr/sonarr-collection-of-custom-formats/

// Dynamic range patterns (order matters — check most specific first)
const DV_PATTERN = /\b(dv|dovi|dolby[. ]?vision)\b/i;
const HDR10_PLUS_PATTERN = /\b(hdr10(?:p(?:lus)?|[. ]?\+))\b/i;
const HDR10_PATTERN = /\b(hdr[. ]?10)\b/i;
const HLG_PATTERN = /\bhlg\b/i;
const PQ_PATTERN = /\b(pq|smpte[. ]?2084)\b/i;
const HDR_GENERIC_PATTERN = /\bhdr\b/i;

export function detectDynamicRangeFromFilename(filePath: string | null): string {
  if (!filePath) return "SDR";

  // Extract just the filename from the path
  const filename = filePath.split("/").pop() ?? filePath;

  const hasDV = DV_PATTERN.test(filename);
  const hasHDR10Plus = HDR10_PLUS_PATTERN.test(filename);
  const hasHDR10 = HDR10_PATTERN.test(filename) && !hasHDR10Plus;
  const hasHLG = HLG_PATTERN.test(filename);

  // DV combinations (most specific first)
  if (hasDV && hasHDR10Plus) return "Dolby Vision";
  if (hasDV && hasHDR10) return "Dolby Vision";
  if (hasDV && hasHLG) return "Dolby Vision";
  if (hasDV) return "Dolby Vision";

  // Standalone HDR formats
  if (hasHDR10Plus) return "HDR10+";
  if (hasHDR10) return "HDR10";
  if (hasHLG) return "HLG";
  if (PQ_PATTERN.test(filename)) return "HDR10";
  if (HDR_GENERIC_PATTERN.test(filename)) return "HDR";

  return "SDR";
}

// Audio profile patterns (order matters — check most specific first)
const TRUEHD_ATMOS_PATTERN = /\b(true[. ]?hd[. ]?atmos|atmos[. ]?true[. ]?hd)\b/i;
const DDP_ATMOS_PATTERN = /\b(dd[p+]|e[- ]?ac[- ]?3|eac3)\b.*\batmos\b|\batmos\b.*\b(dd[p+]|e[- ]?ac[- ]?3|eac3)\b/i;
const ATMOS_PATTERN = /\batmos\b/i;
const DTSX_PATTERN = /\b(dts[- .:]+x(?!\d))\b/i;
const DTS_HD_MA_PATTERN = /\b(dts[- .]?hd[. ]?ma)\b/i;
const TRUEHD_PATTERN = /\b(true[. ]?hd)\b/i;

export function detectAudioProfileFromFilename(filePath: string | null): string | null {
  if (!filePath) return null;

  const filename = filePath.split("/").pop() ?? filePath;

  // TrueHD Atmos (most specific combo first)
  if (TRUEHD_ATMOS_PATTERN.test(filename)) return "Dolby Atmos";

  // DTS:X
  if (DTSX_PATTERN.test(filename)) return "DTS:X";

  // DD+ Atmos (streaming Atmos)
  if (DDP_ATMOS_PATTERN.test(filename)) return "Dolby Atmos";

  // Generic Atmos (without TrueHD qualifier — still Atmos)
  if (ATMOS_PATTERN.test(filename)) return "Dolby Atmos";

  // TrueHD (without Atmos)
  if (TRUEHD_PATTERN.test(filename)) return "Dolby TrueHD";

  // DTS-HD MA
  if (DTS_HD_MA_PATTERN.test(filename)) return "DTS-HD MA";

  return null;
}

// --- Stream-metadata-based detection (preferred over filename) ---

/**
 * Detect dynamic range from Plex video stream metadata first,
 * falling back to filename regex when stream data is absent.
 */
export function detectDynamicRange(
  videoStream: MediaStream | undefined,
  filePath: string | null,
): string {
  if (videoStream) {
    const rangeType = videoStream.videoRangeType;
    if (rangeType) {
      const upper = rangeType.toUpperCase();
      // Dolby Vision variants: "DOVI", "DOVIWithHDR10", "DOVIWithSMPTE2020", etc.
      if (upper.includes("DOVI") || upper.includes("DV")) return "Dolby Vision";
      if (upper.includes("HDR10+") || upper.includes("HDR10PLUS") || upper.includes("HDR10P")) return "HDR10+";
      if (upper === "HDR10") return "HDR10";
      if (upper === "HLG") return "HLG";
      if (upper === "PQ") return "HDR10";
      if (upper === "SDR") return "SDR";
      // Catch-all for any other HDR type
      if (upper.includes("HDR")) return "HDR";
    }
    // DOVI flags as secondary signal
    if (videoStream.DOVIPresent) return "Dolby Vision";
    // HDR10+ flag as secondary signal (Jellyfin-specific)
    if (videoStream.HDR10PlusPresent) return "HDR10+";
  }

  return detectDynamicRangeFromFilename(filePath);
}

/**
 * Detect audio profile from Plex audio stream / part metadata first,
 * falling back to filename regex when stream data is absent.
 */
export function detectAudioProfile(
  audioStream: MediaStream | undefined,
  part: MediaPart | undefined,
  filePath: string | null,
): string | null {
  // Check spatial audio format (Jellyfin-specific, highest confidence)
  if (audioStream?.audioSpatialFormat) {
    if (audioStream.audioSpatialFormat === "DolbyAtmos") return "Dolby Atmos";
    if (audioStream.audioSpatialFormat === "DTSX") return "DTS:X";
  }

  // Check stream display titles for profile keywords
  const displayText = audioStream?.extendedDisplayTitle ?? audioStream?.displayTitle ?? "";
  if (displayText) {
    const upper = displayText.toUpperCase();
    // Order matters — check most specific first
    if (upper.includes("ATMOS")) return "Dolby Atmos";
    if (upper.includes("DTS:X") || upper.includes("DTS-X")) return "DTS:X";
    if (upper.includes("DTS-HD MA") || upper.includes("DTS-HD MASTER")) return "DTS-HD MA";
    if (upper.includes("TRUEHD")) return "Dolby TrueHD";
  }

  // Check audio stream profile field (e.g., "dts", "truehd")
  if (audioStream?.profile) {
    const profile = audioStream.profile.toLowerCase();
    if (profile === "truehd") return "Dolby TrueHD";
  }

  // Check part-level audioProfile (e.g., "ma" for DTS-HD MA)
  if (part?.audioProfile) {
    const partProfile = part.audioProfile.toLowerCase();
    if (partProfile === "ma") return "DTS-HD MA";
  }

  return detectAudioProfileFromFilename(filePath);
}

// Chunk size for batched DB transactions
const UPSERT_BATCH_SIZE = 50;
const PAGE_SIZE = 500;
const ENRICHMENT_CONCURRENCY = 10;

/**
 * Enrich a single batch of items by fetching detailed per-item metadata.
 * Mutates the batch array in-place to avoid holding two large copies.
 * Uses concurrency-limited parallel requests to avoid overwhelming the server.
 * Falls back to the original bulk listing item if a per-item fetch fails.
 */
async function enrichBatch(
  client: MediaServerClient,
  batch: MediaMetadataItem[],
): Promise<void> {
  for (let i = 0; i < batch.length; i += ENRICHMENT_CONCURRENCY) {
    const end = Math.min(i + ENRICHMENT_CONCURRENCY, batch.length);
    const results = await Promise.allSettled(
      batch.slice(i, end).map((item) => client.getItemMetadata(item.ratingKey))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled") {
        batch[i + j] = (results[j] as PromiseFulfilledResult<MediaMetadataItem>).value;
      }
    }
    // Yield between enrichment chunks to allow GC
    if (end < batch.length) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }
}

/**
 * Log V8 heap statistics and optionally force garbage collection.
 * When --expose-gc is enabled, calls global.gc() to reclaim memory from the
 * previous page's metadata objects instead of letting V8 defer collection.
 */
function logHeapAndCollect(label: string): { usedMB: number; rss: number } {
  const gcAvailable = typeof globalThis.gc === "function";
  if (gcAvailable) {
    globalThis.gc!();
  }
  const heap = v8.getHeapStatistics();
  const rss = process.memoryUsage().rss;
  const toMB = (b: number) => (b / 1024 / 1024).toFixed(1);
  const limitMB = heap.heap_size_limit / 1024 / 1024;
  const usedMB = heap.used_heap_size / 1024 / 1024;
  const pct = ((usedMB / limitMB) * 100).toFixed(0);
  logger.info(
    "Sync",
    `[Memory] ${label}: heap ${toMB(heap.used_heap_size)}/${toMB(heap.heap_size_limit)} MB (${pct}%), ` +
    `RSS ${toMB(rss)} MB, external ${toMB(heap.external_memory)}` +
    (gcAvailable ? "" : " [gc unavailable]"),
  );
  return { usedMB, rss };
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs > 0 ? ` ${rs}s` : ""}`;
}

// ─── Raw SQL batch upsert ─────────────────────────────────────────────────────
// Replaces N individual `prisma.mediaItem.upsert()` calls with a single
// INSERT ... ON CONFLICT query. This eliminates Prisma internal state that
// accumulated ~130 MB per page (34K-item sync) and was never garbage-collected.

const MEDIA_ITEM_COLUMNS = [
  "id", "libraryId", "ratingKey", "parentRatingKey", "grandparentRatingKey", "type",
  "title", "year", "summary", "thumbUrl", "artUrl",
  "parentThumbUrl", "seasonThumbUrl", "parentTitle", "albumTitle",
  "seasonNumber", "episodeNumber",
  "contentRating", "rating", "audienceRating", "userRating",
  "studio", "tagline", "originalTitle", "originallyAvailableAt", "viewOffset",
  "genres", "directors", "writers", "roles", "countries",
  "resolution", "videoWidth", "videoHeight", "videoCodec", "videoProfile",
  "videoFrameRate", "videoBitDepth", "videoBitrate",
  "videoColorPrimaries", "videoColorRange", "videoChromaSubsampling",
  "aspectRatio", "scanType",
  "audioCodec", "audioChannels", "audioProfile", "audioBitrate", "audioSamplingRate",
  "container", "dynamicRange", "optimizedForStreaming",
  "fileSize", "filePath", "duration",
  "playCount", "lastPlayedAt", "addedAt", "serverUpdatedAt",
  "dedupKey", "isWatchlisted",
  "titleSort", "ratingCount", "ratingImage", "audienceRatingImage",
  "absoluteIndex", "chapterSource", "labels", "videoRangeType",
  "createdAt", "updatedAt",
] as const;

const COLS_PER_ROW = MEDIA_ITEM_COLUMNS.length;

// Indices of columns needing explicit SQL type casts
const COLUMN_CASTS: Record<number, string> = {
  5: '::"LibraryType"',
  26: "::jsonb", 27: "::jsonb", 28: "::jsonb", 29: "::jsonb", 30: "::jsonb",
  52: "::bigint",
  67: "::jsonb",
};

// JSON columns use COALESCE on update to preserve existing values when the
// incoming data has no value (matches Prisma's undefined-means-skip behavior).
const COALESCE_ON_UPDATE = new Set(["genres", "directors", "writers", "roles", "countries"]);

// Columns that should not be overwritten on conflict
const SKIP_ON_UPDATE = new Set(["id", "libraryId", "ratingKey", "type", "createdAt"]);

function buildUpsertSql(rowCount: number): string {
  const cols = MEDIA_ITEM_COLUMNS.map((c) => `"${c}"`).join(",");
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const ps: string[] = [];
    for (let c = 0; c < COLS_PER_ROW; c++) {
      ps.push(`$${r * COLS_PER_ROW + c + 1}${COLUMN_CASTS[c] ?? ""}`);
    }
    rows.push(`(${ps.join(",")})`);
  }
  const sets = MEDIA_ITEM_COLUMNS
    .filter((c) => !SKIP_ON_UPDATE.has(c))
    .map((c) =>
      COALESCE_ON_UPDATE.has(c)
        ? `"${c}"=COALESCE(EXCLUDED."${c}","MediaItem"."${c}")`
        : `"${c}"=EXCLUDED."${c}"`
    );
  return (
    `INSERT INTO "MediaItem" (${cols}) VALUES ${rows.join(",")} ` +
    `ON CONFLICT ("libraryId","ratingKey") DO UPDATE SET ${sets.join(",")} ` +
    `RETURNING "id","ratingKey"`
  );
}

function buildRowParams(
  item: MediaMetadataItem,
  libraryId: string,
  libraryType: "MOVIE" | "SERIES" | "MUSIC",
  watchCounts: Map<string, { count: number; lastWatchedAt: number }>,
  showGenreMap: Map<string, string[]> | undefined,
  showGuidsMap: Map<string, Array<{ id: string }>> | undefined,
  now: Date,
  watchlistGuids?: Set<string>,
): unknown[] {
  const d = buildItemData(item, libraryType, watchCounts, showGenreMap);

  // Parse external IDs from Guid for dedupKey computation.
  // For series episodes, prefer show-level Guids (series-level TVDB/TMDB)
  // since Arr and Seerr correlation needs series-level IDs.
  // Fall back to episode-level Guids only when show-level aren't available.
  let guids = item.Guid;
  if (showGuidsMap) {
    const showGuids = showGuidsMap.get(item.grandparentTitle ?? "");
    if (showGuids && showGuids.length > 0) {
      guids = showGuids;
    }
  }
  const externalIds: { source: string; id: string }[] = [];
  if (guids) {
    for (const guid of guids) {
      const match = guid.id.match(/^(\w+):\/\/(.+)$/);
      if (match) externalIds.push({ source: match[1].toUpperCase(), id: match[2] });
    }
  }

  const dedupKey = computeDedupKey(libraryType, d.title, {
    year: d.year,
    parentTitle: d.parentTitle,
    seasonNumber: d.seasonNumber,
    episodeNumber: d.episodeNumber,
    externalIds,
  });

  // Determine watchlist status: Jellyfin/Emby set d.isWatchlisted directly;
  // for Plex, cross-reference the item's external GUIDs with the watchlist set
  let isWatchlisted = d.isWatchlisted;
  if (watchlistGuids && !isWatchlisted && externalIds.length > 0) {
    for (const ext of externalIds) {
      const guidStr = `${ext.source.toLowerCase()}://${ext.id}`;
      if (watchlistGuids.has(guidStr)) {
        isWatchlisted = true;
        break;
      }
    }
  }

  return [
    randomUUID(),
    libraryId,
    item.ratingKey,
    item.parentRatingKey ?? null,
    item.grandparentRatingKey ?? null,
    libraryType,
    d.title,
    d.year ?? null,
    d.summary ?? null,
    d.thumbUrl ?? null,
    d.artUrl ?? null,
    d.parentThumbUrl ?? null,
    d.seasonThumbUrl ?? null,
    d.parentTitle ?? null,
    d.albumTitle ?? null,
    d.seasonNumber ?? null,
    d.episodeNumber ?? null,
    d.contentRating ?? null,
    d.rating ?? null,
    d.audienceRating ?? null,
    d.userRating ?? null,
    d.studio ?? null,
    d.tagline ?? null,
    d.originalTitle ?? null,
    d.originallyAvailableAt ?? null,
    d.viewOffset ?? null,
    d.genres ? JSON.stringify(d.genres) : null,
    d.directors ? JSON.stringify(d.directors) : null,
    d.writers ? JSON.stringify(d.writers) : null,
    d.roles ? JSON.stringify(d.roles) : null,
    d.countries ? JSON.stringify(d.countries) : null,
    d.resolution ?? null,
    d.videoWidth ?? null,
    d.videoHeight ?? null,
    d.videoCodec ?? null,
    d.videoProfile ?? null,
    d.videoFrameRate ?? null,
    d.videoBitDepth ?? null,
    d.videoBitrate ?? null,
    d.videoColorPrimaries ?? null,
    d.videoColorRange ?? null,
    d.videoChromaSubsampling ?? null,
    d.aspectRatio ?? null,
    d.scanType ?? null,
    d.audioCodec ?? null,
    d.audioChannels ?? null,
    d.audioProfile ?? null,
    d.audioBitrate ?? null,
    d.audioSamplingRate ?? null,
    d.container ?? null,
    d.dynamicRange ?? null,
    d.optimizedForStreaming ?? null,
    d.fileSize != null ? d.fileSize.toString() : null,
    d.filePath ?? null,
    d.duration ?? null,
    d.playCount,
    d.lastPlayedAt ?? null,
    d.addedAt ?? null,
    item.updatedAt ? new Date(item.updatedAt * 1000) : null,
    dedupKey,
    isWatchlisted,
    d.titleSort ?? d.title,
    d.ratingCount ?? null,
    d.ratingImage ?? null,
    d.audienceRatingImage ?? null,
    d.absoluteIndex ?? null,
    d.chapterSource ?? null,
    d.labels ? JSON.stringify(d.labels) : null,
    d.videoRangeType ?? null,
    now,
    now,
  ];
}

/**
 * Process a single batch of items: upsert to DB, sync external IDs, subtitles,
 * and invalidate changed artwork cache entries.
 *
 * Isolated as a separate function so ALL local variables (Prisma results, Maps,
 * intermediate arrays) are definitively out of scope when it returns, making them
 * immediately eligible for garbage collection.
 */
async function processBatch(
  items: MediaMetadataItem[],
  libraryId: string,
  libraryType: "MOVIE" | "SERIES" | "MUSIC",
  watchCounts: Map<string, { count: number; lastWatchedAt: number }>,
  existingThumbUrls: Map<string, { ratingKey: string; thumbUrl: string | null; parentThumbUrl: string | null; seasonThumbUrl: string | null }>,
  showGenreMap?: Map<string, string[]>,
  showGuidsMap?: Map<string, Array<{ id: string }>>,
  watchlistGuids?: Set<string>,
): Promise<void> {
  if (items.length === 0) return;

  // Raw SQL upsert — single INSERT ON CONFLICT query replaces N individual
  // Prisma upserts, eliminating per-operation internal state retention.
  const now = new Date();
  const params: unknown[] = [];
  for (const item of items) {
    params.push(...buildRowParams(item, libraryId, libraryType, watchCounts, showGenreMap, showGuidsMap, now, watchlistGuids));
  }
  const upsertResults = await withDeadlockRetry("processBatch upsert", () =>
    prisma.$queryRawUnsafe<{ id: string; ratingKey: string }[]>(
      buildUpsertSql(items.length), ...params
    ),
  );
  const ratingKeyToId = new Map(upsertResults.map((r) => [r.ratingKey, r.id]));

  // Invalidate image cache for items with changed artwork URLs.
  // Normalize URLs before comparing to ignore Plex timestamp-only changes
  // (e.g. /library/metadata/123/thumb/OLD vs /library/metadata/123/thumb/NEW).
  for (const item of items) {
    const old = existingThumbUrls.get(item.ratingKey);
    if (!old) continue;
    const changedUrls: (string | null)[] = [];
    if (normalizeCacheUrl(old.thumbUrl ?? "") !== normalizeCacheUrl(item.thumb ?? "") && old.thumbUrl) changedUrls.push(old.thumbUrl);
    if (normalizeCacheUrl(old.parentThumbUrl ?? "") !== normalizeCacheUrl(item.grandparentThumb ?? "") && old.parentThumbUrl) changedUrls.push(old.parentThumbUrl);
    if (normalizeCacheUrl(old.seasonThumbUrl ?? "") !== normalizeCacheUrl(item.parentThumb ?? "") && old.seasonThumbUrl) changedUrls.push(old.seasonThumbUrl);
    if (changedUrls.length > 0) {
      await invalidateCachedUrls(changedUrls);
    }
  }

  // Collect external IDs and streams from the batch
  const externalIdRows: unknown[][] = [];
  const streamRows: unknown[][] = [];
  const mediaItemIdsWithExternalIds = new Set<string>();
  const mediaItemIdsWithStreams = new Set<string>();

  for (const item of items) {
    const mediaItemId = ratingKeyToId.get(item.ratingKey);
    if (!mediaItemId) continue;

    // For series episodes, prefer show-level Guids (series-level TVDB/TMDB)
    // since Arr and Seerr correlation needs series-level IDs.
    // Fall back to episode-level Guids only when show-level aren't available.
    let guids = item.Guid;
    if (showGuidsMap) {
      const showGuids = showGuidsMap.get(item.grandparentTitle ?? "");
      if (showGuids && showGuids.length > 0) {
        guids = showGuids;
      }
    }
    if (guids && guids.length > 0) {
      const seen = new Set<string>();
      for (const guid of guids) {
        const match = guid.id.match(/^(\w+):\/\/(.+)$/);
        if (!match) continue;
        const source = match[1].toUpperCase();
        const dedupKey = `${mediaItemId}:${source}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        mediaItemIdsWithExternalIds.add(mediaItemId);
        externalIdRows.push([randomUUID(), mediaItemId, source, match[2], now]);
      }
    }

    const media = item.Media?.[0];
    const part = media?.Part?.[0];
    const allStreams = (part?.Stream || []).filter(
      (s) => s.streamType === 1 || s.streamType === 2 || s.streamType === 3
    );
    if (allStreams.length > 0) {
      mediaItemIdsWithStreams.add(mediaItemId);
      for (const s of allStreams) {
        streamRows.push([
          randomUUID(),
          mediaItemId,
          s.streamType,
          s.index ?? null,
          s.codec ?? null,
          s.profile ?? null,
          s.bitrate ?? null,
          s.default ?? false,
          s.displayTitle ?? null,
          s.extendedDisplayTitle ?? null,
          s.language ?? null,
          s.languageCode ?? null,
          s.width ?? null,
          s.height ?? null,
          s.frameRate ?? null,
          s.scanType ?? null,
          s.colorPrimaries ?? null,
          s.colorRange ?? null,
          s.chromaSubsampling ?? null,
          s.bitDepth ?? null,
          s.videoRangeType ?? null,
          s.channels ?? null,
          s.samplingRate ?? null,
          s.audioChannelLayout ?? null,
          s.forced ?? null,
          now,
        ]);
      }
    }
  }

  // Raw SQL for external IDs — delete old + bulk insert to avoid Prisma state
  if (externalIdRows.length > 0) {
    const deleteIds = [...mediaItemIdsWithExternalIds];
    await prisma.$queryRawUnsafe(
      `DELETE FROM "MediaItemExternalId" WHERE "mediaItemId" IN (${deleteIds.map((_, i) => `$${i + 1}`).join(",")})`,
      ...deleteIds,
    );

    const extIdParams: unknown[] = [];
    const extIdValueSets: string[] = [];
    for (let r = 0; r < externalIdRows.length; r++) {
      const base = r * 5;
      extIdValueSets.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
      extIdParams.push(...externalIdRows[r]);
    }
    await prisma.$queryRawUnsafe(
      `INSERT INTO "MediaItemExternalId" ("id","mediaItemId","source","externalId","createdAt") VALUES ${extIdValueSets.join(",")} ON CONFLICT ("mediaItemId","source") DO UPDATE SET "externalId"=EXCLUDED."externalId"`,
      ...extIdParams,
    );
  }

  // Raw SQL for streams — delete old + bulk insert to avoid Prisma state
  if (streamRows.length > 0) {
    const deleteIds = [...mediaItemIdsWithStreams];
    await prisma.$queryRawUnsafe(
      `DELETE FROM "MediaStream" WHERE "mediaItemId" IN (${deleteIds.map((_, i) => `$${i + 1}`).join(",")})`,
      ...deleteIds,
    );

    const streamParams: unknown[] = [];
    const streamValueSets: string[] = [];
    const STREAM_COLS = 26;
    for (let r = 0; r < streamRows.length; r++) {
      const base = r * STREAM_COLS;
      const placeholders: string[] = [];
      for (let c = 0; c < STREAM_COLS; c++) {
        placeholders.push(`$${base + c + 1}`);
      }
      streamValueSets.push(`(${placeholders.join(",")})`);
      streamParams.push(...streamRows[r]);
    }
    await prisma.$queryRawUnsafe(
      `INSERT INTO "MediaStream" ("id","mediaItemId","streamType","index","codec","profile","bitrate","isDefault","displayTitle","extendedDisplayTitle","language","languageCode","width","height","frameRate","scanType","colorPrimaries","colorRange","chromaSubsampling","bitDepth","videoRangeType","channels","samplingRate","audioChannelLayout","forced","createdAt") VALUES ${streamValueSets.join(",")}`,
      ...streamParams,
    );
  }
}

export async function syncMediaServer(serverId: string, libraryKey?: string, options?: { skipWatchHistory?: boolean }) {
  // Create the job as PENDING immediately so the UI can show a "Pending" indicator
  // while the server waits for its turn (semaphore allows one sync at a time).
  const syncJobRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "SyncJob" ("id","mediaServerId","status","startedAt") VALUES ($1,$2,$3,$4) RETURNING "id"`,
    randomUUID(), serverId, "PENDING", new Date(),
  );
  const syncJob = syncJobRows[0];

  let syncUserId: string | undefined;

  await acquireSyncSlot();
  try {
  // Transition from PENDING → RUNNING now that we have the slot
  await prisma.$queryRawUnsafe(
    `UPDATE "SyncJob" SET "status"=$1,"startedAt"=$2 WHERE "id"=$3`,
    "RUNNING", new Date(), syncJob.id,
  );

  try {
    const serverRows = await prisma.$queryRawUnsafe<
      { id: string; name: string; url: string; accessToken: string; type: string; userId: string; tlsSkipVerify: boolean; enabled: boolean }[]
    >(
      `SELECT "id","name","url","accessToken","type","userId","tlsSkipVerify","enabled" FROM "MediaServer" WHERE "id"=$1`,
      serverId,
    );
    if (serverRows.length === 0) throw new Error(`MediaServer not found: ${serverId}`);
    let server = serverRows[0];
    syncUserId = server.userId;

    // If the server was disabled, cancel the sync job gracefully
    if (!server.enabled) {
      await prisma.$queryRawUnsafe(
        `UPDATE "SyncJob" SET "status"=$1,"completedAt"=$2,"currentLibrary"=NULL WHERE "id"=$3`,
        "CANCELLED", new Date(), syncJob.id,
      );
      logger.info("Sync", `Skipping sync for disabled server "${server.name}"`);
      return;
    }

    eventBus.emit({ type: "sync:started", userId: server.userId, meta: { serverId } });

    const client = createMediaServerClient(server.type as import("@/generated/prisma/client").MediaServerType, server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    });

    // Update server name from the API if it changed
    try {
      const connResult = await client.testConnection();
      if (connResult.ok && connResult.serverName && connResult.serverName !== server.name) {
        await prisma.$queryRawUnsafe(
          `UPDATE "MediaServer" SET "name"=$1 WHERE "id"=$2`,
          connResult.serverName, server.id,
        );
        logger.info("Sync", `Server name updated: "${server.name}" → "${connResult.serverName}"`);
        server = { ...server, name: connResult.serverName };
      }
    } catch {
      // Non-fatal — continue with existing name
    }

    logger.info("Sync", `Starting sync for server "${server.name}"`);
    logHeapAndCollect("sync start");

    // Track completed operation timings for status display
    const completedOps: string[] = [];
    const syncStatus = (...current: string[]) =>
      [...completedOps, ...current].join(" · ");

    const libraries = await client.getLibraries();

    // Look up which libraries are disabled in the DB so we can skip them early
    const disabledLibraries = await prisma.$queryRawUnsafe<{ key: string }[]>(
      `SELECT "key" FROM "Library" WHERE "mediaServerId"=$1 AND "enabled"=false`,
      serverId,
    );
    const disabledKeys = new Set(disabledLibraries.map((l) => l.key));

    // Filter to the libraries we'll actually sync
    const targetLibraries = libraries.filter((lib) => {
      if (disabledKeys.has(lib.key)) {
        logger.info("Sync", `Skipping disabled library "${lib.title}"`);
        return false;
      }
      if (libraryKey && lib.key !== libraryKey) return false;
      return true;
    });

    // Fetch play counts (one Map kept in memory for the whole sync)
    await prisma.$queryRawUnsafe(
      `UPDATE "SyncJob" SET "currentLibrary"=$1 WHERE "id"=$2`,
      "Fetching play counts...", syncJob.id,
    );
    const opStart = Date.now();
    const watchCounts = await client.getWatchCounts();
    completedOps.push(`Play counts: ${formatDuration(Date.now() - opStart)}`);
    logger.info("Sync", `Play counts loaded (${watchCounts.size} items with plays)`);
    logHeapAndCollect("after play counts");

    // Fetch Plex watchlist GUIDs for cross-referencing during sync.
    // Jellyfin/Emby set isWatchlisted via IsFavorite in the item data directly.
    let watchlistGuids: Set<string> | undefined;
    if (client instanceof PlexClient) {
      const wlStart = Date.now();
      watchlistGuids = await client.getWatchlistGuids();
      if (watchlistGuids.size > 0) {
        completedOps.push(`Watchlist: ${formatDuration(Date.now() - wlStart)}`);
        logger.info("Sync", `Plex watchlist loaded (${watchlistGuids.size} GUIDs)`);
      }
    }

    // Process libraries one at a time to limit peak memory usage.
    // Each library's items are fetched, processed, then released before the next.
    let processedItems = 0;
    let totalItems = 0;

    for (const lib of targetLibraries) {
      // Check for cancellation between libraries
      const cancelRows1 = await prisma.$queryRawUnsafe<{ cancelRequested: boolean }[]>(
        `SELECT "cancelRequested" FROM "SyncJob" WHERE "id"=$1`, syncJob.id,
      );
      if (!cancelRows1[0] || cancelRows1[0].cancelRequested) {
        logger.info("Sync", `Sync cancelled for server (${processedItems} items processed before cancel)`);
        if (cancelRows1[0]) {
          await prisma.$queryRawUnsafe(
            `UPDATE "SyncJob" SET "status"=$1,"completedAt"=$2,"itemsProcessed"=$3,"currentLibrary"=NULL WHERE "id"=$4`,
            "CANCELLED", new Date(), processedItems, syncJob.id,
          );
        }
        return;
      }

      const libraryType = lib.type === "movie" ? "MOVIE" : lib.type === "artist" ? "MUSIC" : "SERIES";
      const fetchType = lib.type === "show" ? "episode" as const : lib.type === "artist" ? "track" as const : "movie" as const;
      let showGenreMap: Map<string, string[]> | undefined;
      let showGuidsMap: Map<string, Array<{ id: string }>> | undefined;

      // For TV shows, fetch show-level data (small dataset, not paginated):
      // - genres (not available on episodes)
      // - external IDs (series-level TVDB/TMDB/IMDB for Arr correlation —
      //   episodes from Emby/Jellyfin only have episode-level ProviderIds)
      if (lib.type === "show") {
        const shows = await client.getLibraryShows(lib.key);
        showGenreMap = new Map<string, string[]>();
        showGuidsMap = new Map<string, Array<{ id: string }>>();
        for (const show of shows) {
          if (show.title) {
            const showGenres = show.Genre?.map((g) => g.tag) ?? [];
            if (showGenres.length > 0) showGenreMap.set(show.title, showGenres);
            if (show.Guid && show.Guid.length > 0) showGuidsMap.set(show.title, show.Guid);
          }
        }
      }

      // Small page size keeps API response times fast and limits GC pressure
      // from normalizing large batches of items with nested media/stream objects.
      const shouldEnrich = client.bulkListingIncomplete ?? false;
      const effectivePageSize = PAGE_SIZE;

      // Fetch first page to learn total count without loading everything
      const firstPage = await client.getLibraryItemsPage(lib.key, fetchType, 0, effectivePageSize);
      const libraryTotal = firstPage.total;
      logger.info("Sync", `Library "${lib.title}": ${libraryTotal} items (pageSize=${effectivePageSize}, enrichment=${shouldEnrich})`);
      logHeapAndCollect(`start library "${lib.title}"`);

      totalItems += libraryTotal;

      await prisma.$queryRawUnsafe(
        `UPDATE "SyncJob" SET "totalItems"=$1 WHERE "id"=$2`,
        totalItems, syncJob.id,
      );

      const libraryNow = new Date();
      const libraryRows = await prisma.$queryRawUnsafe<{ id: string; enabled: boolean }[]>(
        `INSERT INTO "Library" ("id","mediaServerId","key","title","type","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT ("mediaServerId","key") DO UPDATE SET "title"=EXCLUDED."title","updatedAt"=$6
         RETURNING "id","enabled"`,
        randomUUID(), serverId, lib.key, lib.title, libraryType, libraryNow,
      );
      const library = libraryRows[0];

      // Skip disabled libraries
      if (!library.enabled) continue;

      await prisma.$queryRawUnsafe(
        `UPDATE "SyncJob" SET "currentLibrary"=$1 WHERE "id"=$2`,
        syncStatus(lib.title), syncJob.id,
      );
      const libOpStart = Date.now();

      // Record when this library sync started so we can identify stale items
      // (items not touched by upserts will have updatedAt < syncStartTime).
      const librarySyncStart = new Date();
      let libraryItemCount = 0;
      let skippedEnrichment = 0;

      // Fetch and process items page by page to limit peak memory.
      // Enrichment (per-item fetches) happens per-batch, not per-page,
      // to avoid holding 2000 enriched items in memory simultaneously.
      let pageItems: MediaMetadataItem[] | null = firstPage.items;
      let pageOffset = 0;
      let cancelled = false;

      while (pageItems && pageItems.length > 0) {
        // Pre-fetch existing thumb URLs for the entire page in a single query
        // (instead of per-batch) to reduce DB round trips.
        const pageRatingKeys = pageItems.map((item) => item.ratingKey);
        const existingThumbItems = await prisma.$queryRawUnsafe<
          { ratingKey: string; thumbUrl: string | null; parentThumbUrl: string | null; seasonThumbUrl: string | null; serverUpdatedAt: Date | null }[]
        >(
          `SELECT "ratingKey","thumbUrl","parentThumbUrl","seasonThumbUrl","serverUpdatedAt" FROM "MediaItem" WHERE "libraryId"=$1 AND "ratingKey" = ANY($2)`,
          library.id, pageRatingKeys,
        );
        const existingThumbUrls = new Map(
          existingThumbItems.map((e) => [e.ratingKey, e]),
        );

        // Process this page in DB batches
        for (let i = 0; i < pageItems.length; i += UPSERT_BATCH_SIZE) {
          // Check for cancellation between batches
          if (processedItems > 0 && i % (UPSERT_BATCH_SIZE * 5) === 0) {
            const cancelRows = await prisma.$queryRawUnsafe<{ cancelRequested: boolean }[]>(
              `SELECT "cancelRequested" FROM "SyncJob" WHERE "id"=$1`, syncJob.id,
            );
            if (!cancelRows[0] || cancelRows[0].cancelRequested) {
              cancelled = true;
              break;
            }
          }

          const batchEnd = Math.min(i + UPSERT_BATCH_SIZE, pageItems.length);
          const batch = pageItems.slice(i, batchEnd);

          if (shouldEnrich) {
            // Split batch: skip enrichment for items unchanged on the server.
            // Compare Plex's updatedAt (epoch) against stored serverUpdatedAt.
            const toEnrich: MediaMetadataItem[] = [];
            const unchangedKeys: string[] = [];
            for (const item of batch) {
              const existing = existingThumbUrls.get(item.ratingKey);
              const storedMs = existing?.serverUpdatedAt?.getTime();
              const itemMs = item.updatedAt ? item.updatedAt * 1000 : null;
              if (storedMs != null && itemMs != null && storedMs === itemMs) {
                unchangedKeys.push(item.ratingKey);
              } else {
                toEnrich.push(item);
              }
            }

            if (toEnrich.length > 0) {
              // Enrich only changed/new items — keeps peak memory low and
              // avoids unnecessary per-item API calls.
              await enrichBatch(client, toEnrich);
              await processBatch(toEnrich, library.id, libraryType, watchCounts, existingThumbUrls, showGenreMap, showGuidsMap, watchlistGuids);
            }

            // Touch updatedAt for unchanged items so stale-item detection
            // (WHERE updatedAt < librarySyncStart) doesn't delete them.
            if (unchangedKeys.length > 0) {
              await prisma.$queryRawUnsafe(
                `UPDATE "MediaItem" SET "updatedAt"=$1 WHERE "libraryId"=$2 AND "ratingKey" = ANY($3)`,
                new Date(), library.id, unchangedKeys,
              );
              skippedEnrichment += unchangedKeys.length;
            }
          } else {
            // No enrichment needed (Jellyfin/Emby) — process all items directly.
            await processBatch(batch, library.id, libraryType, watchCounts, existingThumbUrls, showGenreMap, showGuidsMap, watchlistGuids);
          }

          processedItems += batch.length;
          libraryItemCount += batch.length;

          // Null out processed items from the page array so V8 can collect
          // the heavy Plex metadata objects (Media/Part/Stream, summary text,
          // Role arrays, etc.) even while the page array is still alive.
          for (let j = i; j < batchEnd; j++) {
            (pageItems as unknown as (MediaMetadataItem | null)[])[j] = null;
          }

          await prisma.$queryRawUnsafe(
            `UPDATE "SyncJob" SET "itemsProcessed"=$1 WHERE "id"=$2`,
            processedItems, syncJob.id,
          );

          // Yield to event loop between batches so V8 can run incremental GC
          // on the nulled-out items and processBatch's released locals.
          await new Promise<void>((resolve) => { setImmediate(resolve); });

          // Log memory every 250 items to track climb within a library
          if (processedItems % 250 < UPSERT_BATCH_SIZE) {
            logHeapAndCollect(`batch ${processedItems}/${totalItems} (${lib.title})`);
          }
        }

        if (cancelled) break;

        // Release current page before fetching next
        pageItems = null;

        pageOffset += pageRatingKeys.length;
        if (pageRatingKeys.length < effectivePageSize || pageOffset >= libraryTotal) break;

        // Force GC between pages to reclaim the previous page's metadata objects
        // (each page holds items with nested Media/Part/Stream arrays).
        // Without this, V8 defers collection and memory climbs across pages.
        logHeapAndCollect("between pages");

        const nextPage = await client.getLibraryItemsPage(lib.key, fetchType, pageOffset, effectivePageSize);
        pageItems = nextPage.items;
      }

      if (cancelled) {
        logger.info("Sync", `Sync cancelled for server (${processedItems} items processed before cancel)`);
        const jobExists = await prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "SyncJob" WHERE "id"=$1`, syncJob.id,
        );
        if (jobExists.length > 0) {
          await prisma.$queryRawUnsafe(
            `UPDATE "SyncJob" SET "status"=$1,"completedAt"=$2,"itemsProcessed"=$3,"currentLibrary"=NULL WHERE "id"=$4`,
            "CANCELLED", new Date(), processedItems, syncJob.id,
          );
        }
        return;
      }

      // Remove items from DB that no longer exist on the server.
      // Items touched by upserts have updatedAt >= librarySyncStart.
      // Items NOT touched are stale (removed from the server since last sync).
      const staleItems = await prisma.$queryRawUnsafe<
        { id: string; thumbUrl: string | null; parentThumbUrl: string | null; seasonThumbUrl: string | null }[]
      >(
        `SELECT "id","thumbUrl","parentThumbUrl","seasonThumbUrl" FROM "MediaItem" WHERE "libraryId"=$1 AND "updatedAt"<$2`,
        library.id, librarySyncStart,
      );

      if (staleItems.length > 0) {
        // Invalidate image cache for items being removed
        for (const staleItem of staleItems) {
          await invalidateCachedUrls([staleItem.thumbUrl, staleItem.parentThumbUrl, staleItem.seasonThumbUrl]);
        }
        const staleIds = staleItems.map((s) => s.id);
        await prisma.$queryRawUnsafe(
          `DELETE FROM "MediaItem" WHERE "id" = ANY($1)`, staleIds,
        );
        logger.info("Sync", `Removed ${staleItems.length} stale item(s) from library "${lib.title}"`);
      }

      await prisma.$queryRawUnsafe(
        `UPDATE "Library" SET "lastSyncedAt"=$1 WHERE "id"=$2`,
        new Date(), library.id,
      );

      dbLogger.debug("DB", `Upserted ${libraryItemCount} media items for library "${lib.title}"`);
      if (skippedEnrichment > 0) {
        logger.info("Sync", `Library "${lib.title}": skipped enrichment for ${skippedEnrichment}/${libraryItemCount} unchanged items`);
      }
      completedOps.push(`${lib.title}: ${formatDuration(Date.now() - libOpStart)}`);

      // Release show maps between libraries and force GC
      showGenreMap = undefined;
      showGuidsMap = undefined;
      logHeapAndCollect("between libraries");
    }

    // Release watch counts and watchlist after all libraries are done
    watchCounts.clear();
    watchlistGuids?.clear();

    // Sync detailed watch history (per-user, per-play events)
    if (!options?.skipWatchHistory) {
      await prisma.$queryRawUnsafe(
        `UPDATE "SyncJob" SET "currentLibrary"=$1 WHERE "id"=$2`,
        syncStatus("Syncing detailed watch history..."), syncJob.id,
      );
      const whStart = Date.now();
      try {
        const { count: whCount } = await syncWatchHistory(serverId);
        completedOps.push(`Watch history: ${whCount} plays (${formatDuration(Date.now() - whStart)})`);
        logger.info("Sync", `Watch history sync completed: ${whCount} play events`);
      } catch (whError) {
        // Non-fatal: don't fail the entire sync if watch history fails
        logger.error("Sync", "Watch history sync failed", { error: String(whError) });
        completedOps.push(`Watch history: failed (${formatDuration(Date.now() - whStart)})`);
      }
      appCache.invalidatePrefix("watch-history-filters:");
    }
    logHeapAndCollect("after watch history sync");

    // Recompute dedup canonical flags for this user's items
    await recomputeCanonical(server.userId);

    await prisma.$queryRawUnsafe(
      `UPDATE "SyncJob" SET "status"=$1,"completedAt"=$2,"itemsProcessed"=$3,"currentLibrary"=NULL WHERE "id"=$4`,
      "COMPLETED", new Date(), processedItems, syncJob.id,
    );

    // Invalidate caches that depend on media data
    appCache.invalidate("distinct-values");
    appCache.invalidatePrefix("server-filter:");

    logger.info("Sync", `Sync completed for server (${processedItems} items processed)`);
    eventBus.emit({ type: "sync:completed", userId: server.userId, meta: { serverId } });
    logHeapAndCollect("sync complete");
  } catch (error) {
    let errorMessage = "Unknown error";
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const body = error.response?.data;
      const detail = typeof body === "string"
        ? body
        : body?.message ?? body?.Message ?? body?.title ?? body?.Title ?? (body ? JSON.stringify(body) : null);
      const url = error.config?.url;
      errorMessage = status
        ? `HTTP ${status}${url ? ` (${error.config?.method?.toUpperCase()} ${url})` : ""}: ${detail || error.message}`
        : error.message;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    logger.error("Sync", "Sync failed", { error: errorMessage });

    await prisma.$queryRawUnsafe(
      `UPDATE "SyncJob" SET "status"=$1,"completedAt"=$2,"error"=$3,"currentLibrary"=NULL WHERE "id"=$4`,
      "FAILED", new Date(), errorMessage, syncJob.id,
    );
    if (syncUserId) eventBus.emit({ type: "sync:failed", userId: syncUserId, meta: { serverId } });
    throw error;
  }
  } finally {
    releaseSyncSlot();
  }
}

/**
 * Build the data object for a media item upsert (shared between create and update).
 */
function buildItemData(
  item: MediaMetadataItem,
  libraryType: "MOVIE" | "SERIES" | "MUSIC",
  watchCounts: Map<string, { count: number; lastWatchedAt: number }>,
  showGenreMap?: Map<string, string[]>
) {
  const media = item.Media?.[0];
  const part = media?.Part?.[0];
  const streams = part?.Stream || [];
  const videoStream = streams.find((s) => s.streamType === 1);
  const audioStream = streams.find((s) => s.streamType === 2);

  const parentTitle = item.grandparentTitle ?? null;
  const albumTitle = libraryType === "MUSIC" ? (item.parentTitle ?? null) : null;
  const seasonNumber = item.parentIndex ?? null;
  const episodeNumber = item.index ?? null;

  let genres = item.Genre?.map((g) => g.tag) ?? null;
  if ((!genres || genres.length === 0) && showGenreMap && parentTitle) {
    genres = showGenreMap.get(parentTitle) ?? null;
  }
  const directors = item.Director?.map((d) => d.tag) ?? null;
  const writers = item.Writer?.map((w) => w.tag) ?? null;
  const roles = item.Role?.map((r) => ({ tag: r.tag, role: r.role ?? null, thumb: r.thumb ?? null })) ?? null;
  const countries = item.Country?.map((c) => c.tag) ?? null;

  const metadataCount = item.viewCount ?? 0;
  const history = watchCounts.get(item.ratingKey);
  const historyCount = history?.count ?? 0;
  const playCount = Math.max(metadataCount, historyCount);
  const metadataDate = item.lastViewedAt ? item.lastViewedAt * 1000 : 0;
  const historyDate = history?.lastWatchedAt ? history.lastWatchedAt * 1000 : 0;
  const latestDate = Math.max(metadataDate, historyDate);

  return {
    title: item.title,
    year: item.year,
    summary: item.summary,
    thumbUrl: item.thumb,
    artUrl: item.art ?? null,
    parentThumbUrl: item.grandparentThumb ?? null,
    seasonThumbUrl: item.parentThumb ?? null,
    parentTitle,
    albumTitle,
    seasonNumber,
    episodeNumber,
    contentRating: item.contentRating ?? null,
    rating: item.rating ?? null,
    audienceRating: item.audienceRating ?? null,
    userRating: item.userRating ?? null,
    studio: item.studio ?? null,
    tagline: item.tagline ?? null,
    originalTitle: item.originalTitle ?? null,
    originallyAvailableAt: item.originallyAvailableAt
      ? new Date(item.originallyAvailableAt)
      : null,
    viewOffset: item.viewOffset ?? null,
    genres: genres && genres.length > 0 ? genres : undefined,
    directors: directors && directors.length > 0 ? directors : undefined,
    writers: writers && writers.length > 0 ? writers : undefined,
    roles: roles && roles.length > 0 ? roles : undefined,
    countries: countries && countries.length > 0 ? countries : undefined,
    resolution: normalizeResolutionFromDimensions(
      videoStream?.width ?? media?.width,
      videoStream?.height ?? media?.height,
    ) ?? media?.videoResolution ?? null,
    videoWidth: videoStream?.width ?? media?.width ?? null,
    videoHeight: videoStream?.height ?? media?.height ?? null,
    videoCodec: videoStream?.codec ?? media?.videoCodec ?? null,
    videoProfile: videoStream?.profile ?? media?.videoProfile ?? null,
    videoFrameRate: media?.videoFrameRate ?? null,
    videoBitDepth: videoStream?.bitDepth ?? null,
    videoBitrate: media?.bitrate ?? null,
    videoColorPrimaries: videoStream?.colorPrimaries ?? null,
    videoColorRange: videoStream?.colorRange ?? null,
    videoChromaSubsampling: videoStream?.chromaSubsampling ?? null,
    aspectRatio: media?.aspectRatio != null ? String(media.aspectRatio) : null,
    scanType: videoStream?.scanType ?? null,
    audioCodec: audioStream?.codec ?? media?.audioCodec ?? null,
    audioChannels: audioStream?.channels ?? media?.audioChannels ?? null,
    audioProfile: detectAudioProfile(audioStream, part, part?.file ?? null),
    audioBitrate: audioStream?.bitrate ?? null,
    audioSamplingRate: audioStream?.samplingRate ?? null,
    container: media?.container ?? part?.container ?? null,
    dynamicRange: detectDynamicRange(videoStream, part?.file ?? null),
    optimizedForStreaming: part?.optimizedForStreaming ?? media?.optimizedForStreaming ?? null,
    fileSize: part?.size ? BigInt(part.size) : null,
    filePath: part?.file ?? null,
    duration: media?.duration ?? item.duration ?? null,
    // Enriched metadata fields
    titleSort: item.titleSort ?? item.title,
    ratingCount: item.ratingCount ?? null,
    ratingImage: item.ratingImage ?? null,
    audienceRatingImage: item.audienceRatingImage ?? null,
    absoluteIndex: item.absoluteIndex ?? null,
    chapterSource: item.chapterSource ?? null,
    labels: item.Label && item.Label.length > 0 ? item.Label.map((l) => l.tag) : undefined,
    videoRangeType: videoStream?.videoRangeType ?? null,
    isWatchlisted: item.isWatchlisted ?? false,
    playCount,
    lastPlayedAt: playCount > 0 && latestDate > 0 ? new Date(latestDate) : null,
    addedAt: item.addedAt ? new Date(item.addedAt * 1000) : null,
  };
}
