import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaMetadataItem } from "@/lib/media-server/types";
import { isMediaItem, isItemForLibraryType, canBelongToSyncedLibrary } from "@/lib/media-server/item-types";
import { MediaItemNotFoundError } from "@/lib/media-server/client";
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
 * **A mapping failure is per-item and does not escalate.** An id no evidence can
 * place in a library is counted as `unresolved`, logged, and dropped. This is
 * load-bearing: Plex emits unmappable ids on every routine add (one new movie
 * arrived alongside 27 extras/trailers belonging to no library section), and the
 * previous "first unmappable id aborts the batch and triggers a whole-server
 * sync" turned a single added movie into ~64k item-writes. A full sync lists one
 * type per enabled library, so it could not have stored those ids either —
 * escalating was pure cost. The exceptions are a section key with no matching
 * `Library` row (a genuinely new library, which only the full sync can create)
 * and Jellyfin/Emby, which report no section at all; both still fall back.
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
  /** Containers (collections/playlists) and items of the wrong type for their library. */
  skippedNonMedia?: number;
  /** Items resolved to a library the user has disabled — the full sync ignores those too. */
  skippedDisabled?: number;
  /** Items no evidence could place in a library. Dropped, NOT escalated (see below). */
  unresolved?: number;
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
  enabled: boolean;
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

/**
 * "The server answered, and said this item is gone."
 *
 * Only this may turn into a DELETE. A `MediaItemNotFoundError` is thrown by the
 * client for a well-formed response holding no item; a bare 404 says the same
 * thing over HTTP. Every other failure — an unparseable body, a proxy error
 * page, a timeout — is transient and must reconcile via a full sync instead,
 * because a delete here cascades `RuleMatch`, `LifecycleException` and
 * `WatchHistory`, and a re-added item then reads as never watched.
 */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof MediaItemNotFoundError ||
    (error as { response?: { status?: number } })?.response?.status === 404
  );
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

  // Disabled libraries are loaded too, carrying their `enabled` flag. They must
  // be RECOGNISED so an item in one can be skipped deliberately; filtering them
  // out here made such an item look like it belonged to an unknown library,
  // which escalated to a whole-server sync that then skipped the library anyway.
  const libraryRows = await prisma.$queryRawUnsafe<LibraryRow[]>(
    `SELECT "id","key","type"::text AS "type","enabled" FROM "Library" WHERE "mediaServerId"=$1`,
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
  // Keyed to a LIST, not a single row: the uniqueness constraint is
  // `@@unique([libraryId, ratingKey])`, so one server can legitimately hold the
  // same ratingKey in two libraries. Collapsing to one row let an arbitrary
  // "last row wins" pick decide an item's library — and with it the LibraryType
  // and the whole Arr/Seerr correlation.
  const existingByRatingKey = new Map<string, ItemRow[]>();
  for (const row of existingRows) {
    const bucket = existingByRatingKey.get(row.ratingKey);
    if (bucket) bucket.push(row);
    else existingByRatingKey.set(row.ratingKey, [row]);
  }
  /** The unambiguous stored row for a ratingKey, or undefined when 0 or >1 match. */
  const soleExisting = (ratingKey: string): ItemRow | undefined => {
    const bucket = existingByRatingKey.get(ratingKey);
    return bucket?.length === 1 ? bucket[0] : undefined;
  };
  /**
   * The stored row for a ratingKey in the library it actually resolved to.
   *
   * Used by the carry-forwards, which must not degrade just because a ratingKey
   * appears in two libraries: `soleExisting` gives up on that case (correctly —
   * it can't pick a library), but once mapping HAS picked one, the right row is
   * unambiguous. Falling back to `soleExisting` here would silently un-watchlist
   * the item and skip the artwork diff.
   */
  const storedFor = (ratingKey: string): ItemRow | undefined => {
    const libraryId = resolvedLibrary.get(ratingKey);
    const bucket = existingByRatingKey.get(ratingKey);
    if (!bucket) return undefined;
    return libraryId ? bucket.find((r) => r.libraryId === libraryId) : soleExisting(ratingKey);
  };

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
        // A container, not media (a Jellyfin box set, or a Plex collection
        // whose timeline entry carried no `type` — `normalize-plex` drops the
        // typed ones before they get here, and the self-write registry drops
        // the echo of librariarr's own collection writes). Kept as defence in
        // depth: without it a container would round-trip in as a phantom item.
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

  // Group upsert items by their DB library. Mapping evidence, in order:
  //   1. the item's own stored row (unambiguous ones only)
  //   2. the server-reported library section key
  //
  // A mapping failure is classified PER ITEM and never escalates the batch.
  // This used to `return fellBack(...)` on the first unmappable id, which threw
  // away the work already done for every other item and triggered a whole-server
  // sync — and Plex guarantees unmappable ids on a routine add: one new movie
  // arrived with 27 extras/trailers that belong to no library section at all.
  // A full sync cannot place those either, so escalating was pure cost.
  const groups = new Map<string, MediaMetadataItem[]>();
  const unresolvedIds: string[] = [];
  /** ratingKey → the library it resolved to, so carry-forwards read the right row. */
  const resolvedLibrary = new Map<string, string>();
  let skippedDisabled = 0;
  let newLibrarySeen = false;
  for (const item of fetched) {
    // The server's own section wins over the stored row. An item that MOVED
    // between libraries would otherwise be rewritten into its old one — and if
    // that library is disabled, skipped forever while the full sync eventually
    // creates a second row for the same ratingKey.
    let libraryId: string | undefined;
    if (item.librarySectionID != null) {
      const sectionKey = String(item.librarySectionID);
      const lib = libByKey.get(sectionKey);
      if (!lib) {
        // The server named a section we hold no `Library` row for. That is
        // positive evidence a NEW library appeared — but only when the item
        // could belong to a library we sync at all. A Plex Photos or Home
        // Videos section is filtered out by `getLibraries()` and will NEVER get
        // a row, so escalating for a photo buys a full server sync that cannot
        // fix anything, and the next photo does it again.
        if (canBelongToSyncedLibrary(item)) newLibrarySeen = true;
        unresolvedIds.push(item.ratingKey);
        continue;
      }
      libraryId = lib.id;
    } else {
      // No section reported at all — Jellyfin/Emby never populate it. Fall back
      // to the item's own stored row, and for an item never stored (a new add)
      // ask the server which library holds it. Without that lookup every new
      // Jellyfin/Emby item was unresolved — and unresolved escalates on those
      // servers — so every single add cost a whole-server sync.
      libraryId = soleExisting(item.ratingKey)?.libraryId;
      if (!libraryId && client.resolveLibraryKey) {
        try {
          const key = await client.resolveLibraryKey(item.ratingKey);
          if (key) {
            const lib = libByKey.get(key);
            if (lib) libraryId = lib.id;
            else if (canBelongToSyncedLibrary(item)) newLibrarySeen = true;
          }
        } catch (error) {
          // Left unresolved. On Jellyfin/Emby that still falls back to a full
          // sync below — exactly the behaviour before this lookup existed — so
          // a transient failure here costs what every add used to cost.
          logger.debug(
            "SyncIncremental",
            `Could not resolve the library holding ${item.ratingKey}; leaving it unresolved`,
            { error: String(error) },
          );
        }
      }
    }
    if (!libraryId || !libById.has(libraryId)) {
      // No evidence at all. Dropping is deliberate: a full sync lists one type
      // per enabled library and would never have stored this either, so
      // escalating buys nothing. The scheduled full sync stays the backstop.
      unresolvedIds.push(item.ratingKey);
      continue;
    }
    if (!libById.get(libraryId)!.enabled) {
      // The user disabled this library; the full sync skips it outright.
      skippedDisabled++;
      continue;
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
    resolvedLibrary.set(item.ratingKey, libraryId);
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
      if (storedFor(item.ratingKey)?.isWatchlisted) {
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
        .map((it) => storedFor(it.ratingKey))
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
    // Deliberately NOT scoped by `Library.enabled`, unlike the upsert path above.
    // The asymmetry is the point: we must not CREATE a row in a library the user
    // disabled (the full sync would never have listed it), but a row whose media
    // the server says is GONE has to go regardless of which library holds it.
    // Nothing else would remove it — the full sync skips disabled libraries, so
    // its stale purge never enumerates them — while no read path filters on
    // `Library.enabled` either, so the row stays live in listings, stats and the
    // rule engine. An immortal row for deleted media is the worse failure: a
    // "not played in N months" rule would match it and fire DELETE_RADARR
    // against media that no longer exists. The cascade into `RuleMatch` /
    // `LifecycleException` / `WatchHistory` is correct here — those records
    // describe an item that is genuinely gone.
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

  // One line per run, always. Every classification counter is here: before this,
  // a run that silently dropped every id it was handed logged nothing at all,
  // which is why diagnosing the escalation loop needed a WebSocket capture.
  const counters =
    `upserted ${upserted}, deleted ${deleted}` +
    (skippedNonMedia > 0 ? `, skipped ${skippedNonMedia} non-media` : "") +
    (skippedDisabled > 0 ? `, skipped ${skippedDisabled} in disabled librar${skippedDisabled === 1 ? "y" : "ies"}` : "") +
    (unresolvedIds.length > 0 ? `, ${unresolvedIds.length} unresolved` : "");
  logger.info("SyncIncremental", `Server "${server.name}": ${counters} (incremental)`);

  if (unresolvedIds.length > 0) {
    logger.warn(
      "SyncIncremental",
      `Server "${server.name}": could not map ${unresolvedIds.length} changed id(s) to a library — ` +
        `left for the scheduled full sync. ratingKeys: ${unresolvedIds.slice(0, 10).join(", ")}` +
        (unresolvedIds.length > 10 ? ` (+${unresolvedIds.length - 10} more)` : ""),
    );
  }

  // Two mapping failures still warrant a full reconcile:
  //
  //  - A section key we hold no `Library` row for: a library was added on the
  //    server, and only `syncMediaServer` creates `Library` rows.
  //  - ANY unresolved id on Jellyfin/Emby. Their `normalizeItem` never populates
  //    `librarySectionID`; a new item there is placed through
  //    `client.resolveLibraryKey` (`/Items/{id}/Ancestors`) above, so this now
  //    covers only an item that lookup could not place — a transient failure,
  //    or a library the server does not report as one. Escalating is bounded
  //    there (no Plex-style extras storm emitting dozens of sectionless ids per
  //    add) and keeps those servers from dropping a change on the floor.
  // Side effects run whenever rows actually changed, BEFORE any status decision.
  // A run can now both write rows and report `fell-back` (per-item classification
  // means the fallback is decided at the end, not on the first bad id), so
  // returning early here would leave the caches holding pre-write answers, the
  // dedup canonical flags stale — every list showing the item twice on a
  // multi-server install — and the UI unrefreshed until the enqueued full sync
  // eventually runs on the serial MAIN_QUEUE.
  if (upserted > 0 || deleted > 0) {
    await recomputeCanonical(server.userId).catch((e) =>
      logger.error("SyncIncremental", "recomputeCanonical failed", { error: String(e) }),
    );
    invalidateMediaCaches();
    eventBus.emit({ type: "sync:completed", userId: server.userId, meta: { serverId, incremental: true } });
  }

  const needsFullSync = newLibrarySeen || (server.type !== "PLEX" && unresolvedIds.length > 0);
  if (needsFullSync) {
    return {
      status: "fell-back",
      upserted, deleted, skippedNonMedia, skippedDisabled,
      unresolved: unresolvedIds.length,
      reason: newLibrarySeen
        ? "item reported a library section with no matching Library row (new library?)"
        : `${unresolvedIds.length} item(s) carry no library section (${server.type} reports none)`,
    };
  }

  return {
    status: "done",
    upserted, deleted, skippedNonMedia, skippedDisabled,
    unresolved: unresolvedIds.length,
  };
}
