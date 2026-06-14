import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { logger } from "@/lib/logger";

/** A saved, reusable Plex collection definition. */
export interface CollectionSettings {
  id: string;
  userId: string;
  name: string;
  type: string;
  sortName: string | null;
  homeScreen: boolean;
  recommended: boolean;
  sort: string;
}

interface MatchedItem {
  libraryId: string;
  ratingKey: string;
  title: string;
  parentTitle: string | null;
}

/**
 * One rule set's contribution to a collection: the matched items it wants
 * present in the collection, plus the rule set's `seriesScope` (which decides
 * whether `items` are series-level or episode-level rating keys).
 */
export interface CollectionContribution {
  ruleSetId: string;
  seriesScope: boolean;
  items: MatchedItem[];
}

const normTitle = (s: string) => s.trim().toLowerCase();

/**
 * Build a collection's contributions from the persisted RuleMatch rows of every
 * enabled rule set assigned to it. Driving the sync from RuleMatch (rather than
 * an in-memory match set) is what makes "merge" correct: re-evaluating one rule
 * set still syncs the collection against the CURRENT matches of all the rule
 * sets feeding it, and orphaned collections resolve to an empty union.
 */
async function buildContributionsFromMatches(
  collectionId: string
): Promise<CollectionContribution[]> {
  const ruleSets = await prisma.ruleSet.findMany({
    where: { collectionId, enabled: true },
    select: {
      id: true,
      seriesScope: true,
      ruleMatches: { select: { itemData: true } },
    },
  });

  return ruleSets.map((rs) => ({
    ruleSetId: rs.id,
    seriesScope: rs.seriesScope,
    items: rs.ruleMatches
      .map((m) => {
        const d = m.itemData as Record<string, unknown>;
        return {
          libraryId: d.libraryId as string,
          ratingKey: d.ratingKey as string,
          title: (d.title as string) ?? "",
          parentTitle: (d.parentTitle as string | null) ?? null,
        };
      })
      // Defensive: legacy match rows could lack a ratingKey/libraryId.
      .filter((i) => i.libraryId && i.ratingKey),
  }));
}

/**
 * Sync a single collection (by id) to Plex from its current persisted matches.
 */
export async function syncCollectionById(
  collectionId: string,
  plexItemsCache?: Map<string, Array<{ title: string; ratingKey: string }>>
): Promise<void> {
  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection) return;
  const contributions = await buildContributionsFromMatches(collection.id);
  await syncCollection(collection, contributions, plexItemsCache);
}

/**
 * Sync every collection owned by a user (or all users when `userId` is omitted)
 * from current matches. Collections whose rule sets are all disabled/unassigned
 * resolve to an empty union and are removed from Plex — this replaces the old
 * per-rule "disabled collection cleanup" pass.
 */
export async function syncAllCollections(
  userId: string | undefined,
  plexItemsCache?: Map<string, Array<{ title: string; ratingKey: string }>>
): Promise<void> {
  const collections = await prisma.collection.findMany({
    where: userId ? { userId } : {},
    select: { id: true },
  });
  for (const c of collections) {
    try {
      await syncCollectionById(c.id, plexItemsCache);
    } catch (error) {
      logger.error("Lifecycle", `Collection sync failed for collection ${c.id}`, {
        error: String(error),
      });
    }
  }
}

/**
 * Sync a single Plex collection from the UNION of every contributing rule set's
 * matched items. Multiple rule sets can "merge" into one collection: the
 * collection's membership is the union of their matches, sorting/visibility come
 * from the shared collection settings, and DELETION_DATE ordering spans the
 * pending actions of ALL contributing rule sets so items are correctly
 * interleaved by deletion date regardless of which rule produced them.
 *
 * Passing an empty `contributions` array (no rule set currently feeds the
 * collection) removes the collection from Plex — this is how an orphaned or
 * just-unassigned collection is cleaned up.
 */
export async function syncCollection(
  collection: CollectionSettings,
  contributions: CollectionContribution[],
  plexItemsCache?: Map<string, Array<{ title: string; ratingKey: string }>>
) {
  const collectionName = collection.name;
  const libraryType = collection.type as "MOVIE" | "SERIES" | "MUSIC";

  // All of this user's Plex libraries of the collection's type. We iterate every
  // one (not just libraries with matches) so a collection that no longer has any
  // members gets removed.
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId: collection.userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  const contributingRuleSetIds = contributions.map((c) => c.ruleSetId);
  const seriesScopeByRuleSet = new Map(
    contributions.map((c) => [c.ruleSetId, c.seriesScope])
  );

  // Preload pending actions across ALL contributing rule sets once, for
  // deletion-date ordering. Querying here (rather than per library) keeps the
  // cross-rule ordering consistent.
  let pendingActions: Array<{
    scheduledFor: Date;
    ruleSetId: string | null;
    mediaItem: { ratingKey: string; parentTitle: string | null; title: string } | null;
  }> = [];
  if (collection.sort === "DELETION_DATE" && contributingRuleSetIds.length > 0) {
    pendingActions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: { in: contributingRuleSetIds }, status: "PENDING" },
      select: {
        scheduledFor: true,
        ruleSetId: true,
        mediaItem: { select: { ratingKey: true, parentTitle: true, title: true } },
      },
    });
  }

  for (const library of userLibraries) {
    try {
      if (!library.mediaServer?.machineId) continue;
      const server = library.mediaServer;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      // For series-scope SERIES contributions the matched items are episodes, but
      // a Plex collection in a TV library holds shows. Resolve series-level rating
      // keys by (normalized) title. Built once per library and shared by both the
      // membership union and the deletion-date ordering.
      let seriesKeyByTitle: Map<string, string> | null = null;
      const needSeries =
        collection.type === "SERIES" && contributions.some((c) => c.seriesScope);
      if (needSeries) {
        let plexSeries: Array<{ title: string; ratingKey: string }>;
        if (plexItemsCache?.has(library.key)) {
          plexSeries = plexItemsCache.get(library.key)!;
        } else {
          plexSeries = await client.getLibraryItems(library.key);
          plexItemsCache?.set(library.key, plexSeries);
        }
        seriesKeyByTitle = new Map();
        for (const s of plexSeries) seriesKeyByTitle.set(normTitle(s.title), s.ratingKey);
      }

      // Union of desired rating keys for THIS library across all contributions.
      const desiredSet = new Set<string>();
      for (const contrib of contributions) {
        const libItems = contrib.items.filter((i) => i.libraryId === library.id);
        if (libItems.length === 0) continue;
        if (collection.type === "SERIES" && contrib.seriesScope && seriesKeyByTitle) {
          for (const it of libItems) {
            const key = seriesKeyByTitle.get(normTitle(it.parentTitle ?? it.title));
            if (key) desiredSet.add(key);
          }
        } else {
          for (const it of libItems) desiredSet.add(it.ratingKey);
        }
      }
      const desiredKeys = [...desiredSet];

      const plexType = collection.type === "MOVIE" ? 1 : 2;

      const collections = await client.getCollections(library.key);
      let plexCollection = collections.find((c) => c.title === collectionName);

      if (!plexCollection && desiredKeys.length === 0) {
        // No collection exists and nothing to add — skip
        continue;
      }

      if (!plexCollection) {
        plexCollection = await client.createCollection(
          library.key,
          collectionName,
          server.machineId!,
          desiredKeys,
          plexType
        );
        logger.info(
          "Lifecycle",
          `Created Plex collection "${collectionName}" with ${desiredKeys.length} items`
        );
      } else {
        const currentItems = await client.getCollectionItems(plexCollection.ratingKey);
        const currentKeys = new Set(currentItems.map((i) => i.ratingKey));

        const toAdd = desiredKeys.filter((k) => !currentKeys.has(k));
        const toRemove = [...currentKeys].filter((k) => !desiredSet.has(k));

        if (toAdd.length > 0) {
          await client.addCollectionItems(plexCollection.ratingKey, server.machineId!, toAdd);
        }
        for (const key of toRemove) {
          await client.removeCollectionItem(plexCollection.ratingKey, key);
        }
        if (toAdd.length > 0 || toRemove.length > 0) {
          logger.info(
            "Lifecycle",
            `Synced Plex collection "${collectionName}": +${toAdd.length} -${toRemove.length}`
          );
        }

        // If the collection ends up empty, delete it entirely.
        if (desiredKeys.length === 0) {
          await client.deleteCollection(plexCollection.ratingKey);
          logger.info("Lifecycle", `Removed empty Plex collection "${collectionName}"`);
          continue; // Skip sort/visibility since collection is gone
        }
      }

      // Always sync sort title (set or clear)
      await client.editCollectionSortTitle(
        library.key,
        plexCollection.ratingKey,
        collection.sortName || ""
      );

      // Always sync collection item sort order
      if (collection.sort === "DELETION_DATE") {
        // Custom sort mode (value 2) so manual ordering is preserved
        await client.editCollectionSort(plexCollection.ratingKey, 2);
        await applyDeletionDateOrder(
          client,
          plexCollection.ratingKey,
          desiredKeys,
          pendingActions,
          seriesScopeByRuleSet,
          seriesKeyByTitle
        );
      } else {
        const sortMap: Record<string, number> = { RELEASE_DATE: 0, ALPHABETICAL: 1 };
        await client.editCollectionSort(
          plexCollection.ratingKey,
          sortMap[collection.sort] ?? 1
        );
      }

      // Always sync visibility (propagate both enabled and disabled states)
      await client.updateCollectionVisibility(
        library.key,
        plexCollection.ratingKey,
        collection.homeScreen,
        collection.homeScreen, // shared = same as home
        collection.recommended
      );
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to sync collection "${collectionName}" for library ${library.id}`,
        { error: String(error) }
      );
    }
  }
}

/**
 * Reorder collection items by their scheduled deletion date (soonest first),
 * pooling the pending actions of every contributing rule set so items are
 * interleaved by deletion date across rules. Items without a pending action are
 * placed at the end.
 */
async function applyDeletionDateOrder(
  client: PlexClient,
  collectionRatingKey: string,
  desiredKeys: string[],
  pendingActions: Array<{
    scheduledFor: Date;
    ruleSetId: string | null;
    mediaItem: { ratingKey: string; parentTitle: string | null; title: string } | null;
  }>,
  seriesScopeByRuleSet: Map<string, boolean>,
  seriesKeyByTitle: Map<string, string> | null
): Promise<void> {
  if (desiredKeys.length <= 1) return;

  // Map each collection rating key -> earliest scheduled deletion across rules.
  const scheduledByKey = new Map<string, Date>();
  for (const action of pendingActions) {
    if (!action.mediaItem || !action.ruleSetId) continue;
    const seriesScope = seriesScopeByRuleSet.get(action.ruleSetId) ?? false;

    let key: string | undefined;
    if (seriesScope && seriesKeyByTitle) {
      // Series-scope: action's episode maps to a series-level key via parentTitle.
      const title = action.mediaItem.parentTitle ?? action.mediaItem.title;
      key = seriesKeyByTitle.get(normTitle(title));
    } else {
      key = action.mediaItem.ratingKey;
    }
    if (!key) continue;

    const existing = scheduledByKey.get(key);
    if (!existing || action.scheduledFor < existing) {
      scheduledByKey.set(key, action.scheduledFor);
    }
  }

  // Soonest deletion first; items without a pending action go last
  const sorted = [...desiredKeys].sort((a, b) => {
    const dateA = scheduledByKey.get(a);
    const dateB = scheduledByKey.get(b);
    if (dateA && dateB) return dateA.getTime() - dateB.getTime();
    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;
    return 0;
  });

  // Move first item to the beginning (no after), then each subsequent item after the previous
  for (let i = 0; i < sorted.length; i++) {
    await client.moveCollectionItem(
      collectionRatingKey,
      sorted[i],
      i === 0 ? undefined : sorted[i - 1]
    );
  }

  logger.debug(
    "Lifecycle",
    `Reordered ${sorted.length} items in collection by deletion date`
  );
}

/**
 * Remove a single item from a Plex collection across all matching libraries.
 * Used when a media item is excluded from lifecycle actions.
 *
 * @param seriesTitle - If provided (for series-scope rules), finds the series
 *   ratingKey by title instead of using the item ratingKey directly.
 */
export async function removeItemFromCollections(
  userId: string,
  type: string,
  collectionName: string,
  itemRatingKey: string,
  seriesTitle: string | null
) {
  const libraryType = type as "MOVIE" | "SERIES" | "MUSIC";
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  for (const library of userLibraries) {
    try {
      if (!library.mediaServer?.machineId) continue;

      const server = library.mediaServer;
      if (!server) continue;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      const collections = await client.getCollections(library.key);
      const collection = collections.find((c) => c.title === collectionName);
      if (!collection) continue;

      let ratingKeyToRemove = itemRatingKey;

      // For series-scope rules, resolve the series-level ratingKey by title
      if (seriesTitle) {
        const plexSeries = await client.getLibraryItems(library.key);
        const match = plexSeries.find((s) => s.title === seriesTitle);
        if (!match) continue;
        ratingKeyToRemove = match.ratingKey;
      }

      // Check if item is actually in the collection before removing
      const currentItems = await client.getCollectionItems(collection.ratingKey);
      const inCollection = currentItems.some((i) => i.ratingKey === ratingKeyToRemove);
      if (!inCollection) continue;

      await client.removeCollectionItem(collection.ratingKey, ratingKeyToRemove);

      // Re-check emptiness AFTER removal — a stale pre-removal count of 1 could
      // wrongly delete a collection that still holds other items (e.g. the
      // collection grew between the fetch and the remove). Re-fetch the items
      // so the delete only fires when the collection is genuinely empty.
      const remainingItems = await client.getCollectionItems(collection.ratingKey);
      if (remainingItems.length === 0) {
        await client.deleteCollection(collection.ratingKey);
        logger.info(
          "Lifecycle",
          `Removed empty Plex collection "${collectionName}" after excluding item`
        );
      } else {
        logger.info(
          "Lifecycle",
          `Removed excluded item from Plex collection "${collectionName}"`
        );
      }
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to remove item from collection "${collectionName}" in library ${library.id}`,
        { error: String(error) }
      );
    }
  }
}

/**
 * Remove a Plex collection by name across all libraries for a user.
 * Used when a collection definition is deleted.
 */
export async function removePlexCollection(
  userId: string,
  type: string,
  collectionName: string
) {
  const libraryType = type as "MOVIE" | "SERIES" | "MUSIC";
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  for (const library of userLibraries) {
    try {
      if (!library.mediaServer?.machineId) continue;

      const server = library.mediaServer;
      if (!server) continue;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      const collections = await client.getCollections(library.key);
      const collection = collections.find((c) => c.title === collectionName);
      if (!collection) continue;

      await client.deleteCollection(collection.ratingKey);
      logger.info(
        "Lifecycle",
        `Removed Plex collection "${collectionName}" from library "${library.title}"`
      );
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to remove collection "${collectionName}" from library ${library.id}`,
        { error: String(error) }
      );
    }
  }
}

/**
 * Rename an existing Plex collection across all of a user's libraries of the
 * given type. Used when a collection definition's name changes.
 */
export async function renameCollectionInPlex(
  userId: string,
  type: string,
  oldName: string,
  newName: string
) {
  const libraryType = type as "MOVIE" | "SERIES" | "MUSIC";
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  for (const library of userLibraries) {
    try {
      if (!library.mediaServer?.machineId) continue;
      const server = library.mediaServer;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      const collections = await client.getCollections(library.key);
      const collection = collections.find((c) => c.title === oldName);
      if (!collection) continue;

      await client.renameCollection(library.key, collection.ratingKey, newName);
      logger.info(
        "Lifecycle",
        `Renamed Plex collection "${oldName}" → "${newName}" in library "${library.title}"`
      );
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to rename collection "${oldName}" → "${newName}" in library ${library.id}`,
        { error: String(error) }
      );
    }
  }
}
