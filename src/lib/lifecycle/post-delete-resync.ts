import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { wholeRecordDeleteWhere, type DeletedItem } from "@/lib/lifecycle/deleted-bytes";
import type { ActionOutcome } from "@/lib/lifecycle/actions";

export const POST_DELETE_SYNC_TRIGGER = "lifecycle execution: re-sync after destructive actions";

/**
 * How many items one server's re-check may name before listing the library is
 * the cheaper way to find what went. The same limit the incremental sync
 * applies itself (it answers "fell-back" past it), so a set this records as
 * small is one the incremental sync accepts.
 */
// Repeated rather than imported so a test mocking the incremental sync need
// not supply it; `tests/unit/lifecycle/post-delete-limit.test.ts` pins the two.
export const POST_DELETE_INCREMENTAL_LIMIT = 100;

export interface DeletedActionItem extends DeletedItem {
  id: string;
  library?: { key: string; mediaServerId: string | null } | null;
}

/** server id → library keys */
type LibrariesByServer = Map<string, Set<string>>;

function addLibrary(map: LibrariesByServer, serverId: string, libraryKey: string): void {
  const keys = map.get(serverId) ?? new Set<string>();
  keys.add(libraryKey);
  map.set(serverId, keys);
}

/**
 * Brings the library rows up to date after a run's destructive actions, by
 * asking the media server about the items those actions deleted rather than
 * listing every library they touched.
 *
 * Each item is fetched through the incremental sync, where a 404 confirms the
 * deletion and removes the row exactly as the full sync's stale purge does
 * (`confirmGoneFromLibrary` asks the same question); an item the server still
 * has (it may not have scanned yet) is refreshed. A server falls back to the
 * targeted full library sync it always had — same trigger, watch history
 * skipped — when its set names more than `POST_DELETE_INCREMENTAL_LIMIT`
 * items, when a whole show or artist is too large to name, or when the
 * incremental sync falls back or throws.
 */
export class PostDeleteResync {
  /** Every library an action was stored in, for the full-sync fallback. */
  private readonly libraries: LibrariesByServer = new Map();
  /** Libraries whose deleted set is too large to name: listed in full. */
  private readonly fullLibraries: LibrariesByServer = new Map();
  /** Items the deletes may have removed, by `MediaItem` id. */
  private readonly itemIds = new Set<string>();

  /**
   * Note an executed destructive action: the item it was stored against, the
   * members it acted on, and — for a whole show or artist — every row of the
   * group in the item's library.
   */
  async record(
    actionType: string,
    item: DeletedActionItem,
    memberIds: string[],
    outcome?: ActionOutcome | void,
  ): Promise<void> {
    if (!actionType.includes("DELETE")) return;
    const serverId = item.library?.mediaServerId;
    const libraryKey = item.library?.key;
    if (!serverId || !libraryKey) return;

    addLibrary(this.libraries, serverId, libraryKey);
    if (this.fullLibraries.get(serverId)?.has(libraryKey)) return;

    const group = wholeRecordDeleteWhere(actionType, item);
    if (group) {
      let rows: Array<{ id: string }>;
      try {
        rows = await prisma.mediaItem.findMany({
          where: group,
          select: { id: true },
          take: POST_DELETE_INCREMENTAL_LIMIT + 1,
        });
      } catch (error) {
        // Not knowing the group's rows, list the library as before.
        logger.warn("Lifecycle", `Could not read the rows a ${actionType} removed; the library will be synced in full`, {
          error: String(error),
        });
        addLibrary(this.fullLibraries, serverId, libraryKey);
        return;
      }
      if (rows.length > POST_DELETE_INCREMENTAL_LIMIT) {
        addLibrary(this.fullLibraries, serverId, libraryKey);
        return;
      }
      for (const r of rows) this.itemIds.add(r.id);
    }
    // Over-including is safe — an item still on the server is only refreshed —
    // and a member the executor did delete must not be missed.
    this.itemIds.add(item.id);
    for (const id of memberIds) this.itemIds.add(id);
    for (const id of outcome?.deletedMemberIds ?? []) this.itemIds.add(id);
  }

  async run(): Promise<void> {
    if (this.libraries.size === 0) return;

    // Each deleted item's rating key, grouped by ITS server and library — a
    // member can be another server's copy, and a rating key names an item only
    // on its own server.
    const keysByServer = new Map<string, Map<string, Set<string>>>();
    try {
      const rows =
        this.itemIds.size > 0
          ? await prisma.mediaItem.findMany({
              where: { id: { in: [...this.itemIds] } },
              select: { ratingKey: true, library: { select: { key: true, mediaServerId: true } } },
            })
          : [];
      for (const r of rows) {
        const { mediaServerId: serverId, key: libraryKey } = r.library;
        if (!serverId) continue;
        addLibrary(this.libraries, serverId, libraryKey);
        if (this.fullLibraries.get(serverId)?.has(libraryKey)) continue;
        const byLibrary = keysByServer.get(serverId) ?? new Map<string, Set<string>>();
        const keys = byLibrary.get(libraryKey) ?? new Set<string>();
        keys.add(r.ratingKey);
        byLibrary.set(libraryKey, keys);
        keysByServer.set(serverId, byLibrary);
      }
    } catch (error) {
      logger.error("Lifecycle", "Could not read the deleted items to re-check; syncing the affected libraries instead", {
        error: String(error),
      });
      for (const [serverId, keys] of this.libraries) for (const key of keys) addLibrary(this.fullLibraries, serverId, key);
      keysByServer.clear();
    }

    let libraryCount = 0;
    for (const keys of this.libraries.values()) libraryCount += keys.size;
    logger.info(
      "Lifecycle",
      `Re-checking the items deleted in ${libraryCount} affected ${libraryCount === 1 ? "library" : "libraries"}`,
    );

    for (const serverId of this.libraries.keys()) {
      await this.runServer(serverId, keysByServer.get(serverId) ?? new Map());
    }
  }

  private async runServer(serverId: string, byLibrary: Map<string, Set<string>>): Promise<void> {
    const full = new Set(this.fullLibraries.get(serverId) ?? []);
    const ratingKeys = [...new Set([...byLibrary.values()].flatMap((k) => [...k]))];

    if (ratingKeys.length > POST_DELETE_INCREMENTAL_LIMIT) {
      for (const key of byLibrary.keys()) full.add(key);
    } else if (ratingKeys.length > 0) {
      try {
        const result = await syncMediaServerItems(serverId, ratingKeys, []);
        // "skipped" is a fallback too: the incremental sync skips while ANY
        // sync of the server is queued or running, which may be another
        // library's and so re-check none of these items.
        if (result.status !== "done") {
          logger.info(
            "Lifecycle",
            `Re-check of ${ratingKeys.length} deleted item(s) on server ${serverId} ${result.status === "skipped" ? "was skipped" : "fell back"}, so the libraries are synced instead: ${result.reason ?? "no reason given"}`,
          );
          for (const key of byLibrary.keys()) full.add(key);
        }
      } catch (error) {
        logger.error("Lifecycle", `Re-check of deleted items on server ${serverId} failed; syncing the libraries instead`, {
          error: String(error),
        });
        for (const key of byLibrary.keys()) full.add(key);
      }
    }

    for (const libraryKey of full) {
      try {
        await syncMediaServer(serverId, libraryKey, {
          trigger: POST_DELETE_SYNC_TRIGGER,
          // A deletion changes no play, and the native watch-history refresh
          // is a SERVER-WIDE scan — with several libraries touched in one run
          // it ran once per library. The stored history is reconciled instead.
          skipWatchHistory: true,
        });
      } catch (error) {
        logger.error("Lifecycle", `Failed to sync library ${libraryKey} on server ${serverId} after action execution`, { error: String(error) });
      }
    }
  }
}
