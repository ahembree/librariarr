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
 * Sync matched lifecycle rule items to a Plex collection.
 * Groups items by library, creates or updates the collection on each
 * Plex server, and manages visibility settings.
 */
export async function syncPlexCollection(
  ruleSet: CollectionRuleSet,
  matchedItems: MatchedItem[],
  plexItemsCache?: Map<string, Array<{ title: string; ratingKey: string }>>
) {
  if (!ruleSet.collectionName) return;
  const collectionName = ruleSet.collectionName;

  // Group matched items by libraryId
  const byLibrary = new Map<string, MatchedItem[]>();
  for (const item of matchedItems) {
    const existing = byLibrary.get(item.libraryId) || [];
    existing.push(item);
    byLibrary.set(item.libraryId, existing);
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

  const actions = await prisma.lifecycleAction.findMany({
    where: { ruleSetId: ruleSet.id, status: "PENDING" },
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
 * Remove a Plex collection by name across all libraries for a user.
 * Used when collection sync is disabled on a rule set.
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
