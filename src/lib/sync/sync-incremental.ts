import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaMetadataItem } from "@/lib/media-server/types";
import { isMediaItem, isItemForLibraryType } from "@/lib/media-server/item-types";
import type { MediaServerType } from "@/generated/prisma/client";
import { processBatch } from "@/lib/sync/sync-server";
import { loadWatchCountsFromHistory } from "@/lib/sync/watch-reconcile";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { invalidateCachedUrls } from "@/lib/image-cache/image-cache";
import { eventBus } from "@/lib/events/event-bus";

/**
 * Incremental sync: apply just the items a real-time `library-changed` event
 * reported, instead of re-listing the whole server.
 *
 * - `changedIds` are fetched individually and upserted (reusing the full sync's
 *   `processBatch`). An id the server reports as **gone** (404 / empty result)
 *   is treated as a deletion. A **transient** fetch failure (unreachable / 5xx /
 *   timeout) never guesses a delete — it returns `"fell-back"` so the caller
 *   runs a full sync that reconciles everything.
 * - `removedIds` are deleted directly.
 *
 * It deliberately does NOT run the server-wide play-count / watch-history scans
 * or stale-item detection — those belong to the full sync, which remains the
 * periodic reconciliation backstop.
 *
 * **The upsert overwrites every column it writes**, so any column whose
 * authoritative source this path lacks has to be handled explicitly or it is
 * silently destroyed until the next full sync:
 *
 * - Play state (`playCount` / `lastPlayedAt`) — read back from the **stored**
 *   `WatchHistory` rows (`loadWatchCountsFromHistory`), because the item
 *   metadata carries only the admin account's `viewCount`/`lastViewedAt`.
 * - `isWatchlisted` — carried forward from the stored row on Plex, whose
 *   watchlist lives behind an account-level plex.tv API this path never calls.
 * - Series-level external ids — a failed show-metadata fetch returns
 *   `"fell-back"` rather than letting `processBatch` read the gap as "this show
 *   has no ids" and clear them.
 */
export interface IncrementalSyncResult {
  status: "done" | "fell-back" | "skipped";
  upserted: number;
  deleted: number;
  reason?: string;
}

// Above this many changed items, listing the library is cheaper than fetching
// each item on its own — the caller runs a full sync instead.
const MAX_INCREMENTAL_ITEMS = 100;

interface ServerRow {
  id: string;
  name: string;
  url: string;
  accessToken: string;
  type: MediaServerType;
  tlsSkipVerify: boolean;
  enabled: boolean;
  userId: string;
}
interface LibraryRow {
  id: string;
  key: string;
  type: "MOVIE" | "SERIES" | "MUSIC";
}
interface ItemRow {
  id: string;
  ratingKey: string;
  libraryId: string;
  thumbUrl: string | null;
  parentThumbUrl: string | null;
  seasonThumbUrl: string | null;
  isWatchlisted: boolean;
}

function isNotFound(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 404;
}

export async function syncMediaServerItems(
  serverId: string,
  changedIds: string[],
  removedIds: string[],
): Promise<IncrementalSyncResult> {
  const fellBack = (reason: string): IncrementalSyncResult => ({ status: "fell-back", upserted: 0, deleted: 0, reason });
  const skipped = (reason: string): IncrementalSyncResult => ({ status: "skipped", upserted: 0, deleted: 0, reason });

  if (changedIds.length + removedIds.length > MAX_INCREMENTAL_ITEMS) {
    return fellBack(`change set of ${changedIds.length + removedIds.length} exceeds ${MAX_INCREMENTAL_ITEMS}`);
  }

  const serverRows = await prisma.$queryRawUnsafe<ServerRow[]>(
    `SELECT "id","name","url","accessToken","type","tlsSkipVerify","enabled","userId" FROM "MediaServer" WHERE "id"=$1`,
    serverId,
  );
  const server = serverRows[0];
  if (!server) return skipped("server not found");
  if (!server.enabled) return skipped("server disabled");

  // A full sync already running/queued covers these changes — don't double up.
  const runningSync = await prisma.syncJob.findFirst({
    where: { mediaServerId: serverId, status: { in: ["RUNNING", "PENDING"] } },
    select: { id: true },
  });
  if (runningSync) return skipped("full sync in progress");

  const libraryRows = await prisma.$queryRawUnsafe<LibraryRow[]>(
    `SELECT "id","key","type"::text AS "type" FROM "Library" WHERE "mediaServerId"=$1 AND "enabled"=true`,
    serverId,
  );
  const libById = new Map(libraryRows.map((l) => [l.id, l]));
  const libByKey = new Map(libraryRows.map((l) => [l.key, l]));

  const allIds = [...new Set([...changedIds, ...removedIds])];
  const existingRows = allIds.length > 0
    ? await prisma.$queryRawUnsafe<ItemRow[]>(
        `SELECT mi."id", mi."ratingKey", mi."libraryId", mi."thumbUrl", mi."parentThumbUrl", mi."seasonThumbUrl", mi."isWatchlisted"
           FROM "MediaItem" mi JOIN "Library" l ON mi."libraryId"=l."id"
          WHERE l."mediaServerId"=$1 AND mi."ratingKey" = ANY($2)`,
        serverId, allIds,
      )
    : [];
  const existingByRatingKey = new Map(existingRows.map((r) => [r.ratingKey, r]));

  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
    skipTlsVerify: server.tlsSkipVerify,
  });

  // Fetch each changed item; classify present (upsert) vs gone (delete).
  const fetched: MediaMetadataItem[] = [];
  const toDelete = new Set(removedIds);
  let skippedNonMedia = 0;
  for (const id of changedIds) {
    try {
      const item = await client.getItemMetadata(id);
      if (!item || !item.ratingKey) {
        toDelete.add(id);
      } else if (!isMediaItem(item)) {
        // A container, not media (Plex collection, Jellyfin box set). This is
        // the hot path for it: librariarr creates Plex collections itself, and
        // the server reports that write back as a library change — so without
        // this guard the app's own collections round-trip in as phantom items.
        // Route the id to the delete set so a phantom row synced before this
        // guard existed is cleaned up rather than waiting for a full sync
        // (nothing legitimate shares a container's ratingKey).
        toDelete.add(id);
        skippedNonMedia++;
      } else {
        fetched.push(item);
      }
    } catch (error) {
      if (isNotFound(error)) {
        toDelete.add(id);
      } else {
        // Never turn a transient error into a deletion — reconcile via full sync.
        return fellBack(`fetch failed for ${id}: ${String(error)}`);
      }
    }
  }

  // Group upsert items by their DB library (existing row's library, else Plex's
  // librarySectionID). Anything unmappable → full sync handles it.
  const groups = new Map<string, MediaMetadataItem[]>();
  for (const item of fetched) {
    let libraryId = existingByRatingKey.get(item.ratingKey)?.libraryId;
    if (!libraryId && item.librarySectionID != null) {
      libraryId = libByKey.get(String(item.librarySectionID))?.id;
    }
    if (!libraryId || !libById.has(libraryId)) {
      return fellBack(`cannot map item ${item.ratingKey} to a known library`);
    }
    if (!isItemForLibraryType(item, libById.get(libraryId)!.type)) {
      // Real media, but not the type this library stores — a show or season
      // alongside the episode that actually changed, an album alongside the
      // track. The full sync lists one type per library and would never store
      // these, so writing them here creates a phantom row that the next full
      // sync purges. Skip (don't delete: unlike a container, a mistyped id is
      // ambiguous enough that guessing a deletion isn't worth it — the full
      // sync's stale purge cleans up anything written before this guard).
      skippedNonMedia++;
      continue;
    }
    const bucket = groups.get(libraryId) ?? [];
    bucket.push(item);
    groups.set(libraryId, bucket);
  }

  // Plex reports watchlist membership only through the account-level plex.tv
  // watchlist API (`getWatchlistGuids`), which the full sync calls and this path
  // deliberately does not — one library change must not trigger a plex.tv round
  // trip. Plex item metadata carries no watchlist flag at all, so writing it
  // unguarded silently un-watchlists every Plex item this sync touches (and the
  // "Is Watchlisted" rule/query criterion with it). Carry the stored flag
  // forward; the full sync stays the reconciliation point for watchlist adds
  // and removals. Jellyfin/Emby need no carry-forward — their `isWatchlisted`
  // comes from the item's own `IsFavorite`, which this path does fetch, so
  // overriding it here would instead make un-favouriting take until a full sync.
  if (server.type === "PLEX") {
    for (const item of fetched) {
      if (existingByRatingKey.get(item.ratingKey)?.isWatchlisted) {
        item.isWatchlisted = true;
      }
    }
  }

  // Play state for the items we're about to write, taken from the stored
  // watch history (all users) rather than the fetched metadata (admin account
  // only). `buildItemData` maxes the two, so this keeps a play by another
  // household member from being overwritten with the admin's older view —
  // which is what made `lastPlayedAt`, and the `seriesLastPlayedAt` aggregate
  // built from it, disagree with the History page.
  const watchCounts = await loadWatchCountsFromHistory(
    serverId,
    fetched.map((it) => it.ratingKey),
  );

  // Episodes need series-level GUIDs/genres/summary — fetch the shows they
  // reference so Arr/Seerr correlation uses series ids, not episode ids. Done
  // for every SERIES group up front, before any write: a failure here has to
  // abort the whole run (see below), and dedeuping across groups also avoids
  // re-fetching a show that two libraries both carry.
  const showGuidsMap = new Map<string, Array<{ id: string }>>();
  const showGenreMap = new Map<string, string[]>();
  const showSummaryMap = new Map<string, string>();
  const seriesIds = [
    ...new Set(
      [...groups]
        .filter(([libraryId]) => libById.get(libraryId)!.type === "SERIES")
        .flatMap(([, items]) => items.map((it) => it.grandparentRatingKey))
        .filter((x): x is string => !!x),
    ),
  ];
  for (const seriesId of seriesIds) {
    try {
      const show = await client.getItemMetadata(seriesId);
      if (show?.Guid) showGuidsMap.set(seriesId, show.Guid);
      if (show?.Genre) showGenreMap.set(seriesId, show.Genre.map((g) => g.tag));
      if (show?.summary) showSummaryMap.set(seriesId, show.summary);
    } catch (error) {
      // NOT best-effort. `processBatch` reads an absent entry in `showGuidsMap`
      // as "this show has no series-level ids" and deliberately **clears** the
      // episode's external ids rather than falling back to its episode-level
      // guid (which would resolve the wrong Sonarr series). A transient fetch
      // failure is indistinguishable from that, so continuing would wipe the
      // TVDB id the series' whole Arr/Seerr correlation hangs on — making
      // `foundInArr` vacuously false for every Arr criterion until the next full
      // sync. Same rule as the item fetch above: never let a transient error
      // stand in for absent data; reconcile via full sync.
      return fellBack(`show metadata fetch failed for ${seriesId}: ${String(error)}`);
    }
  }

  // Upsert each library group via the shared batch processor.
  let upserted = 0;
  for (const [libraryId, items] of groups) {
    const lib = libById.get(libraryId)!;

    const existingThumbUrls = new Map(
      items
        .map((it) => existingByRatingKey.get(it.ratingKey))
        .filter((r): r is ItemRow => !!r)
        .map((r) => [
          r.ratingKey,
          { ratingKey: r.ratingKey, thumbUrl: r.thumbUrl, parentThumbUrl: r.parentThumbUrl, seasonThumbUrl: r.seasonThumbUrl },
        ]),
    );

    // Only SERIES groups consult the show maps; passing them for a MOVIE/MUSIC
    // group would be harmless but misleading, and `processBatch` treats a
    // *defined* map as authoritative.
    const isSeries = lib.type === "SERIES";

    await processBatch(
      items, libraryId, lib.type, watchCounts, existingThumbUrls,
      isSeries ? showGenreMap : undefined,
      isSeries ? showGuidsMap : undefined,
      undefined,
      isSeries ? showSummaryMap : undefined,
    );
    upserted += items.length;
  }

  // Delete removed / gone items (FK cascades external ids, streams, watch history).
  let deleted = 0;
  if (toDelete.size > 0) {
    const rows = await prisma.$queryRawUnsafe<ItemRow[]>(
      `SELECT mi."id", mi."ratingKey", mi."libraryId", mi."thumbUrl", mi."parentThumbUrl", mi."seasonThumbUrl", mi."isWatchlisted"
         FROM "MediaItem" mi JOIN "Library" l ON mi."libraryId"=l."id"
        WHERE l."mediaServerId"=$1 AND mi."ratingKey" = ANY($2)`,
      serverId, [...toDelete],
    );
    if (rows.length > 0) {
      for (const r of rows) await invalidateCachedUrls([r.thumbUrl, r.parentThumbUrl, r.seasonThumbUrl]);
      const ids = rows.map((r) => r.id);
      const exceptions = await prisma.lifecycleException.count({ where: { mediaItemId: { in: ids } } });
      if (exceptions > 0) {
        logger.warn(
          "SyncIncremental",
          `Removing ${rows.length} item(s) deletes ${exceptions} lifecycle exception(s) — re-create if the item(s) reappear`,
        );
      }
      await prisma.$queryRawUnsafe(`DELETE FROM "MediaItem" WHERE "id" = ANY($1)`, ids);
      deleted = rows.length;
    }
  }

  if (skippedNonMedia > 0) {
    logger.info(
      "SyncIncremental",
      `Server "${server.name}": skipped ${skippedNonMedia} changed id(s) that are not library media ` +
        `(collections/playlists, or shows/seasons/albums above the item that changed)`,
    );
  }

  if (upserted === 0 && deleted === 0) {
    return { status: "done", upserted: 0, deleted: 0 };
  }

  // Adding/removing an item can change which copy is canonical for a dedup group
  // (single atomic UPDATE, cheap), then drop media caches and refresh the UI.
  await recomputeCanonical(server.userId).catch((e) =>
    logger.error("SyncIncremental", "recomputeCanonical failed", { error: String(e) }),
  );
  invalidateMediaCaches();
  eventBus.emit({ type: "sync:completed", userId: server.userId, meta: { serverId, incremental: true } });

  logger.info("SyncIncremental", `Server "${server.name}": upserted ${upserted}, deleted ${deleted} (incremental)`);
  return { status: "done", upserted, deleted };
}
