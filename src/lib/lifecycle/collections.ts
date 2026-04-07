import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { logger } from "@/lib/logger";

interface CollectionRuleSet {
  id: string;
  userId: string;
  type: string;
  seriesScope: boolean;
  collectionName: string | null;
  collectionSortName: string | null;
  collectionHomeScreen: boolean;
  collectionRecommended: boolean;
  collectionSort: string;
}

interface MatchedItem {
  libraryId: string;
  ratingKey: string;
  title: string;
  parentTitle: string | null;
}

/**
 * Find all other rule sets that share the same collection name, type, and user.
 * Used to merge matches from multiple rule sets into the same Plex collection.
 */
async function getSiblingCollectionItems(
  ruleSet: CollectionRuleSet,
): Promise<MatchedItem[]> {
  const siblingRuleSets = await prisma.ruleSet.findMany({
    where: {
      userId: ruleSet.userId,
      type: ruleSet.type,
      collectionEnabled: true,
      collectionName: ruleSet.collectionName,
      id: { not: ruleSet.id },
    },
    select: { id: true, seriesScope: true },
  });

  if (siblingRuleSets.length === 0) return [];

  const siblingIds = siblingRuleSets.map((s) => s.id);
  const siblingMatches = await prisma.ruleMatch.findMany({
    where: { ruleSetId: { in: siblingIds } },
    select: {
      mediaItem: {
        select: { libraryId: true, ratingKey: true, title: true, parentTitle: true },
      },
    },
  });

  return siblingMatches
    .filter((m) => m.mediaItem !== null)
    .map((m) => ({
      libraryId: m.mediaItem!.libraryId,
      ratingKey: m.mediaItem!.ratingKey,
      title: m.mediaItem!.title,
      parentTitle: m.mediaItem!.parentTitle,
    }));
}

/**
 * Sync matched lifecycle rule items to a Plex collection.
 * Groups items by library, creates or updates the collection on each
 * Plex server, and manages visibility settings.
 *
 * When multiple rule sets share the same collection name, their matches
 * are merged into a single collection automatically.
 */
export async function syncPlexCollection(
  ruleSet: CollectionRuleSet,
  matchedItems: MatchedItem[],
  plexItemsCache?: Map<string, Array<{ title: string; ratingKey: string }>>
) {
  if (!ruleSet.collectionName) return;
  const collectionName = ruleSet.collectionName;

  // Merge items from sibling rule sets sharing the same collection name
  const siblingItems = await getSiblingCollectionItems(ruleSet);
  const allItems = [...matchedItems, ...siblingItems];

  // Group matched items by libraryId, deduplicating by ratingKey
  const byLibrary = new Map<string, MatchedItem[]>();
  for (const item of allItems) {
    const existing = byLibrary.get(item.libraryId) || [];
    existing.push(item);
    byLibrary.set(item.libraryId, existing);
  }

  // Deduplicate items within each library by ratingKey
  for (const [libraryId, items] of byLibrary) {
    const seen = new Set<string>();
    const deduped = items.filter((item) => {
      if (seen.has(item.ratingKey)) return false;
      seen.add(item.ratingKey);
      return true;
    });
    byLibrary.set(libraryId, deduped);
  }

  // Also find libraries that might have the collection but no longer have matches.
  // Query all libraries for this user's servers that match the rule set type.
  const libraryType = ruleSet.type as "MOVIE" | "SERIES" | "MUSIC";
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId: ruleSet.userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  // Build a lookup map for O(1) access instead of O(n) find per iteration
  const libraryMap = new Map(userLibraries.map((l) => [l.id, l]));

  // Ensure all user libraries are in the map (empty if no matches)
  for (const lib of userLibraries) {
    if (!byLibrary.has(lib.id)) {
      byLibrary.set(lib.id, []);
    }
  }

  // For each library, resolve the server and sync the collection
  for (const [libraryId, items] of byLibrary) {
    try {
      const library = libraryMap.get(libraryId);
      if (!library) {
        logger.warn("Lifecycle", `Library ${libraryId} not found in user libraries, skipping collection sync`);
        continue;
      }
      if (!library.mediaServer?.machineId) continue;

      const server = library.mediaServer;
      if (!server) continue;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      // Resolve the ratingKeys to use in the collection
      let desiredKeys: string[];
      if (items.length === 0) {
        desiredKeys = [];
      } else if (ruleSet.type === "SERIES" && ruleSet.seriesScope) {
        // For series-scope rules, items are episodes grouped by parentTitle.
        // We need series-level ratingKeys from Plex.
        const seriesTitles = new Set(
          items.map((i) => i.parentTitle ?? i.title)
        );
        let plexSeries: Array<{ title: string; ratingKey: string }>;
        if (plexItemsCache?.has(library.key)) {
          plexSeries = plexItemsCache.get(library.key)!;
        } else {
          plexSeries = await client.getLibraryItems(library.key);
          plexItemsCache?.set(library.key, plexSeries);
        }
        desiredKeys = plexSeries
          .filter((s) => seriesTitles.has(s.title))
          .map((s) => s.ratingKey);
      } else {
        desiredKeys = items.map((i) => i.ratingKey);
      }

      const plexType = ruleSet.type === "MOVIE" ? 1 : 2;

      // Find existing collection
      const collections = await client.getCollections(library.key);
      let collection = collections.find(
        (c) => c.title === collectionName
      );

      if (!collection && desiredKeys.length === 0) {
        // No collection exists and nothing to add — skip
        continue;
      }

      if (!collection) {
        // Create new collection with all items
        collection = await client.createCollection(
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
        // Sync items: add missing, remove extras
        const currentItems = await client.getCollectionItems(collection.ratingKey);
        const currentKeys = new Set(currentItems.map((i) => i.ratingKey));
        const desiredSet = new Set(desiredKeys);

        const toAdd = desiredKeys.filter((k) => !currentKeys.has(k));
        const toRemove = [...currentKeys].filter((k) => !desiredSet.has(k));

        if (toAdd.length > 0) {
          await client.addCollectionItems(
            collection.ratingKey,
            server.machineId!,
            toAdd
          );
        }

        for (const key of toRemove) {
          await client.removeCollectionItem(collection.ratingKey, key);
        }

        if (toAdd.length > 0 || toRemove.length > 0) {
          logger.info(
            "Lifecycle",
            `Synced Plex collection "${collectionName}": +${toAdd.length} -${toRemove.length}`
          );
        }

        // If collection ends up with 0 items, delete it entirely
        if (desiredKeys.length === 0) {
          await client.deleteCollection(collection.ratingKey);
          logger.info(
            "Lifecycle",
            `Removed empty Plex collection "${collectionName}"`
          );
          continue; // Skip sort/visibility since collection is gone
        }
      }

      // Always sync sort title (set or clear)
      await client.editCollectionSortTitle(
        library.key,
        collection.ratingKey,
        ruleSet.collectionSortName || ""
      );

      // Always sync collection item sort order
      if (ruleSet.collectionSort === "DELETION_DATE") {
        // Custom sort mode (value 2) so manual ordering is preserved
        await client.editCollectionSort(collection.ratingKey, 2);
        await applyDeletionDateOrder(
          client,
          collection.ratingKey,
          ruleSet,
          desiredKeys,
          items
        );
      } else {
        const sortMap: Record<string, number> = { RELEASE_DATE: 0, ALPHABETICAL: 1 };
        await client.editCollectionSort(
          collection.ratingKey,
          sortMap[ruleSet.collectionSort] ?? 1
        );
      }

      // Always sync visibility (propagate both enabled and disabled states)
      await client.updateCollectionVisibility(
        library.key,
        collection.ratingKey,
        ruleSet.collectionHomeScreen,
        ruleSet.collectionHomeScreen, // shared = same as home
        ruleSet.collectionRecommended
      );
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to sync collection for library ${libraryId}`,
        { error: String(error) }
      );
    }
  }
}

/**
 * Reorder collection items by their scheduled deletion date (soonest first).
 * Items without a pending lifecycle action are placed at the end.
 */
async function applyDeletionDateOrder(
  client: PlexClient,
  collectionRatingKey: string,
  ruleSet: CollectionRuleSet,
  desiredKeys: string[],
  items: MatchedItem[]
): Promise<void> {
  if (desiredKeys.length <= 1) return;

  // Query actions from all rule sets sharing this collection name
  const siblingRuleSetIds = await prisma.ruleSet.findMany({
    where: {
      userId: ruleSet.userId,
      type: ruleSet.type,
      collectionEnabled: true,
      collectionName: ruleSet.collectionName,
    },
    select: { id: true },
  });
  const allRuleSetIds = siblingRuleSetIds.map((s) => s.id);

  const actions = await prisma.lifecycleAction.findMany({
    where: { ruleSetId: { in: allRuleSetIds }, status: "PENDING" },
    select: {
      scheduledFor: true,
      mediaItem: { select: { ratingKey: true, parentTitle: true, title: true } },
    },
  });

  const scheduledByKey = new Map<string, Date>();

  if (ruleSet.type === "SERIES" && ruleSet.seriesScope) {
    // Series-scope: episode ratingKeys in DB differ from Plex series ratingKeys.
    // Map via parentTitle: action.mediaItem.parentTitle -> earliest scheduledFor,
    // then matched items map parentTitle -> collection ratingKey.
    const scheduledByTitle = new Map<string, Date>();
    for (const action of actions) {
      if (!action.mediaItem) continue;
      const title = action.mediaItem.parentTitle ?? action.mediaItem.title;
      const existing = scheduledByTitle.get(title);
      if (!existing || action.scheduledFor < existing) {
        scheduledByTitle.set(title, action.scheduledFor);
      }
    }
    for (const item of items) {
      const title = item.parentTitle ?? item.title;
      const date = scheduledByTitle.get(title);
      if (date) {
        const existing = scheduledByKey.get(item.ratingKey);
        if (!existing || date < existing) {
          scheduledByKey.set(item.ratingKey, date);
        }
      }
    }
  } else {
    for (const action of actions) {
      if (!action.mediaItem) continue;
      const rk = action.mediaItem.ratingKey;
      const existing = scheduledByKey.get(rk);
      if (!existing || action.scheduledFor < existing) {
        scheduledByKey.set(rk, action.scheduledFor);
      }
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
 * If the item is still matched by another rule set sharing the same collection
 * name, it will NOT be removed from the collection.
 *
 * @param seriesTitle - If provided (for series-scope rules), finds the series
 *   ratingKey by title instead of using the item ratingKey directly.
 * @param excludeRuleSetId - The rule set triggering the removal. Sibling rule
 *   sets are checked to see if the item is still matched elsewhere.
 */
export async function removeItemFromCollections(
  userId: string,
  type: string,
  collectionName: string,
  itemRatingKey: string,
  seriesTitle: string | null,
  excludeRuleSetId?: string
) {
  // Check if the item is still matched by a sibling rule set sharing this collection
  if (excludeRuleSetId) {
    const siblingMatch = await prisma.ruleMatch.findFirst({
      where: {
        mediaItem: { ratingKey: itemRatingKey },
        ruleSet: {
          userId,
          type,
          collectionEnabled: true,
          collectionName,
          id: { not: excludeRuleSetId },
        },
      },
    });
    if (siblingMatch) {
      logger.debug(
        "Lifecycle",
        `Skipping removal of item from collection "${collectionName}" — still matched by another rule set`
      );
      return;
    }
  }

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

      // If collection is now empty, remove it
      if (currentItems.length === 1) {
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
 * Used when collection sync is disabled on a rule set.
 *
 * If other rule sets still share this collection name, the collection
 * is NOT removed — it will be re-synced by those rule sets instead.
 *
 * @param excludeRuleSetId - The rule set being disabled. Other rule sets
 *   sharing the same collection name are checked to decide if removal is safe.
 */
export async function removePlexCollection(
  userId: string,
  type: string,
  collectionName: string,
  excludeRuleSetId?: string
) {
  // Check if other rule sets still use this collection name
  const siblingCount = await prisma.ruleSet.count({
    where: {
      userId,
      type,
      collectionEnabled: true,
      collectionName,
      ...(excludeRuleSetId ? { id: { not: excludeRuleSetId } } : {}),
    },
  });

  if (siblingCount > 0) {
    logger.info(
      "Lifecycle",
      `Skipping removal of collection "${collectionName}" — ${siblingCount} other rule set(s) still use it`
    );
    return;
  }

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
