import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { describePlexError } from "@/lib/plex/errors";
import { logger } from "@/lib/logger";
import { markSelfWrites } from "@/lib/media-server/realtime/self-writes";
import { mapWithConcurrency } from "@/lib/concurrency";
import { CollectionSyncCache, type PlexCollectionRow } from "@/lib/lifecycle/collection-sync-cache";

/** A saved, reusable Plex collection definition. */
interface CollectionSettings {
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
  /**
   * Set on another server's copy of a match (`itemData.copies`): the matched
   * item it was collapsed onto, whose pending action orders it too.
   */
  copyOf?: string;
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

// Plex answers each removal with its own write against its database; a few at
// once is quicker than one after another without queueing a burst behind it.
const COLLECTION_REMOVE_CONCURRENCY = 4;

const normTitle = (s: string) => s.trim().toLowerCase();

/**
 * A Plex library's shows by normalized title — how a series-scope match finds
 * its show. Shared by the sync that adds a show to a collection and the
 * exclusion that removes it, so a show found for the one is found for the other.
 */
function seriesKeysByTitle(plexSeries: Array<{ title: string; ratingKey: string }>): Map<string, string> {
  const byTitle = new Map<string, string>();
  for (const s of plexSeries) byTitle.set(normTitle(s.title), s.ratingKey);
  return byTitle;
}

interface PendingActionForOrder {
  scheduledFor: Date;
  ruleSetId: string | null;
  mediaItemId: string | null;
  mediaItem: { ratingKey: string; parentTitle: string | null; title: string } | null;
}

/**
 * Build a collection's contributions from the persisted RuleMatch rows of every
 * enabled rule set assigned to it. Driving the sync from RuleMatch (rather than
 * an in-memory match set) is what makes "merge" correct: re-evaluating one rule
 * set still syncs the collection against the CURRENT matches of all the rule
 * sets feeding it, and orphaned collections resolve to an empty union.
 *
 * Only the snapshot fields the sync reads are taken out of `itemData` (in
 * SQL), not each match's whole stored row.
 */
async function buildContributionsFromMatches(
  collectionId: string
): Promise<CollectionContribution[]> {
  const ruleSets = await prisma.ruleSet.findMany({
    where: { collectionId, enabled: true },
    select: { id: true, seriesScope: true },
  });
  if (ruleSets.length === 0) return [];

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      ruleSetId: string;
      mediaItemId: string;
      libraryId: string | null;
      ratingKey: string | null;
      title: string | null;
      parentTitle: string | null;
      copies: unknown;
    }>
  >(
    `SELECT "ruleSetId", "mediaItemId",
            "itemData"->>'libraryId' AS "libraryId",
            "itemData"->>'ratingKey' AS "ratingKey",
            "itemData"->>'title' AS "title",
            "itemData"->>'parentTitle' AS "parentTitle",
            "itemData"->'copies' AS "copies"
       FROM "RuleMatch"
      WHERE "ruleSetId" = ANY($1)`,
    ruleSets.map((rs) => rs.id),
  );

  const toItem = (d: Record<string, unknown>, copyOf?: string): MatchedItem => ({
    libraryId: d.libraryId as string,
    ratingKey: d.ratingKey as string,
    title: (d.title as string) ?? "",
    parentTitle: (d.parentTitle as string | null) ?? null,
    ...(copyOf ? { copyOf } : {}),
  });

  const byRuleSet = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byRuleSet.get(row.ruleSetId) ?? [];
    list.push(row);
    byRuleSet.set(row.ruleSetId, list);
  }

  return ruleSets.map((rs) => ({
    ruleSetId: rs.id,
    seriesScope: rs.seriesScope,
    items: (byRuleSet.get(rs.id) ?? [])
      .flatMap((m) => {
        // Detection stores a multi-server title once, on one copy; the other
        // servers' copies ride along in `copies` and belong in THEIR servers'
        // collections just the same.
        const copies = Array.isArray(m.copies) ? (m.copies as Record<string, unknown>[]) : [];
        return [toItem(m), ...copies.map((c) => toItem(c, m.mediaItemId))];
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
  cache: CollectionSyncCache = new CollectionSyncCache(),
): Promise<void> {
  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection) return;
  const contributions = await buildContributionsFromMatches(collection.id);
  await syncCollection(collection, contributions, cache);
}

/**
 * Sync every collection owned by a user (or all users when `userId` is omitted)
 * from current matches. Collections whose rule sets are all disabled/unassigned
 * resolve to an empty union and are removed from Plex — this replaces the old
 * per-rule "disabled collection cleanup" pass.
 */
export async function syncAllCollections(
  userId: string | undefined,
  cache: CollectionSyncCache = new CollectionSyncCache(),
): Promise<void> {
  const collections = await prisma.collection.findMany({
    where: userId ? { userId } : {},
    select: { id: true },
  });
  for (const c of collections) {
    try {
      await syncCollectionById(c.id, cache);
    } catch (error) {
      logger.error("Lifecycle", `Collection sync failed for collection ${c.id}`, {
        error: describePlexError(error),
      });
    }
  }
}

/**
 * Sync a single Plex collection from the UNION of every contributing rule set's
 * matched items. Multiple rule sets can "merge" into one collection: the
 * collection's membership is the union of their matches, sorting/visibility come
 * from the shared collection settings, and ACTION_DATE ordering spans the
 * pending actions of ALL contributing rule sets so items are correctly
 * interleaved by scheduled action date regardless of which rule produced them.
 *
 * Passing an empty `contributions` array (no rule set currently feeds the
 * collection) removes the collection from Plex — this is how an orphaned or
 * just-unassigned collection is cleaned up.
 *
 * A setting Plex already holds (sort title, sort mode, visibility, order) is
 * not written again: a run that changes nothing sends no writes.
 */
export async function syncCollection(
  collection: CollectionSettings,
  contributions: CollectionContribution[],
  cache: CollectionSyncCache = new CollectionSyncCache(),
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
  const totalMatchedItems = contributions.reduce((n, c) => n + c.items.length, 0);
  const seriesScopeByRuleSet = new Map(
    contributions.map((c) => [c.ruleSetId, c.seriesScope])
  );

  // Preload pending actions across ALL contributing rule sets once, for
  // action-date ordering. Querying here (rather than per library) keeps the
  // cross-rule ordering consistent.
  let pendingActions: PendingActionForOrder[] = [];
  if (collection.sort === "ACTION_DATE" && contributingRuleSetIds.length > 0) {
    pendingActions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: { in: contributingRuleSetIds }, status: "PENDING" },
      select: {
        scheduledFor: true,
        ruleSetId: true,
        mediaItemId: true,
        mediaItem: { select: { ratingKey: true, parentTitle: true, title: true } },
      },
    });
  }

  for (const library of userLibraries) {
    // Every ratingKey this pass writes on this server. Marked BEFORE the first
    // write, so the echo Plex sends back over its notification socket — a
    // timeline entry for the collection plus one per member it tags — is
    // recognised by the realtime manager as librariarr's own doing rather than
    // fetched again or, past 100 members, escalated to a whole-server sync.
    const serverId = library.mediaServer?.id;
    const touched = new Set<string>();
    const remember = (keys: Iterable<string>) => {
      for (const k of keys) touched.add(k);
      if (serverId) markSelfWrites(serverId, keys);
    };
    try {
      if (!library.mediaServer?.machineId) {
        // A Plex collection is written via a server://<machineId>/… URI, so a
        // server with no stored machineId cannot be synced at all.
        logger.warn(
          "Lifecycle",
          `Skipping library "${library.title}" for collection "${collectionName}": Plex server "${library.mediaServer?.name ?? "?"}" has no machineId — re-add the server so its identifier is stored`,
        );
        continue;
      }
      const server = library.mediaServer;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      // For series-scope SERIES contributions the matched items are episodes, but
      // a Plex collection in a TV library holds shows. Resolve series-level rating
      // keys by (normalized) title. Built once per library and shared by both the
      // membership union and the action-date ordering.
      let seriesKeyByTitle: Map<string, string> | null = null;
      const needSeries =
        collection.type === "SERIES" && contributions.some((c) => c.seriesScope);
      if (needSeries) {
        seriesKeyByTitle = seriesKeysByTitle(
          await cache.libraryShows(library.id, () => client.getLibraryItems(library.key)),
        );
      }

      // Union of desired rating keys for THIS library across all contributions.
      const desiredSet = new Set<string>();
      // A collapsed copy's rating key in this library, by the matched item
      // whose pending action it shares (for action-date ordering).
      const copyKeysByItemId = new Map<string, string[]>();
      let libItemCount = 0;
      for (const contrib of contributions) {
        const libItems = contrib.items.filter((i) => i.libraryId === library.id);
        if (libItems.length === 0) continue;
        libItemCount += libItems.length;
        for (const it of libItems) {
          if (!it.copyOf) continue;
          const keys = copyKeysByItemId.get(it.copyOf) ?? [];
          keys.push(it.ratingKey);
          copyKeysByItemId.set(it.copyOf, keys);
        }
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

      // Resolution-failure guard: if rule sets matched items but NONE resolved
      // to a rating key in THIS library, leave the Plex collection alone —
      // emptying it here would strip every current member (and then delete it)
      // purely because resolution failed, silently destroying a collection the
      // user still wants. Only genuine "nothing matches anywhere" (all
      // contributions empty) falls through to the normal empty-handling below.
      if (desiredKeys.length === 0 && totalMatchedItems > 0) {
        if (libItemCount > 0) {
          // Items belong to this library but no rating key resolved (the
          // series-title lookup against live Plex data came up empty).
          logger.warn(
            "Lifecycle",
            `Leaving Plex collection "${collectionName}" untouched in library "${library.title}": ${libItemCount} matched item(s) belong to this library but none resolved to a Plex rating key — series titles may be stale; sync the library and re-run detection`,
          );
        } else {
          // Matches simply live in other libraries or servers — the normal
          // steady state in multi-library setups, so don't warn every cycle.
          logger.debug(
            "Lifecycle",
            `Leaving Plex collection "${collectionName}" untouched in library "${library.title}": all ${totalMatchedItems} matched item(s) live in other libraries or servers`,
          );
        }
        continue;
      }

      const plexType = collection.type === "MOVIE" ? 1 : 2;

      const collections = await cache.collections(library.id, () => client.getCollections(library.key));
      let plexCollection: PlexCollectionRow | undefined = collections.find((c) => c.title === collectionName);

      if (!plexCollection && desiredKeys.length === 0) {
        // No collection exists and nothing to add — skip
        continue;
      }

      // The members in Plex's current order, when that order can be reused for
      // the action-date ordering below: an existing custom-sorted collection
      // whose membership this pass leaves as it is. Otherwise null, and the
      // ordering reads the order back after the writes.
      let orderAsListed: string[] | null = null;
      if (!plexCollection) {
        remember(desiredKeys);
        const created: PlexCollectionRow = await client.createCollection(
          library.key,
          collectionName,
          server.machineId!,
          desiredKeys,
          plexType
        );
        plexCollection = created;
        await cache.created(library.id, created);
        remember([created.ratingKey]);
        logger.info(
          "Lifecycle",
          `Created Plex collection "${collectionName}" with ${desiredKeys.length} items`
        );
      } else {
        const current = plexCollection;
        const currentItems = (await client.getCollectionItems(current.ratingKey)) ?? [];
        const currentKeys = new Set(currentItems.map((i) => i.ratingKey));

        const toAdd = desiredKeys.filter((k) => !currentKeys.has(k));
        const toRemove = [...currentKeys].filter((k) => !desiredSet.has(k));

        // Every current member is marked, not only the ones being added or
        // removed: the collection itself can be written below (sort title,
        // order, visibility) and the action-date ordering pass can issue a
        // `move` per member, and whether Plex echoes those as member updates is
        // not something to rely on either way. Over-marking costs a real change
        // to a member inside the window a wait for the scheduled sync;
        // under-marking costs an off-schedule whole-server sync per detection.
        remember([current.ratingKey, ...desiredKeys, ...toRemove]);

        if (toAdd.length > 0) {
          await client.addCollectionItems(current.ratingKey, server.machineId!, toAdd);
        }
        await mapWithConcurrency(toRemove, COLLECTION_REMOVE_CONCURRENCY, (key) =>
          client.removeCollectionItem(current.ratingKey, key),
        );
        if (toAdd.length > 0 || toRemove.length > 0) {
          logger.info(
            "Lifecycle",
            `Synced Plex collection "${collectionName}": +${toAdd.length} -${toRemove.length}`
          );
        } else if (String(current.collectionSort) === "2") {
          orderAsListed = currentItems.map((i) => i.ratingKey);
        }

        // If the collection ends up empty, delete it entirely.
        if (desiredKeys.length === 0) {
          await client.deleteCollection(current.ratingKey);
          await cache.deleted(library.id, current.ratingKey);
          logger.info("Lifecycle", `Removed empty Plex collection "${collectionName}"`);
          continue; // Skip sort/visibility since collection is gone
        }
      }

      // Sort title (set or clear), when Plex holds another one.
      const sortTitle = collection.sortName || "";
      if ((plexCollection.titleSort ?? "") !== sortTitle) {
        await client.editCollectionSortTitle(library.key, plexCollection.ratingKey, sortTitle);
      }

      // Collection item sort order
      const sortMap: Record<string, number> = { RELEASE_DATE: 0, ALPHABETICAL: 1, ACTION_DATE: 2 };
      // Custom sort mode (2) for ACTION_DATE, so the manual ordering is kept.
      const sortMode = sortMap[collection.sort] ?? 1;
      if (plexCollection.collectionSort == null || String(plexCollection.collectionSort) !== String(sortMode)) {
        await client.editCollectionSort(plexCollection.ratingKey, sortMode);
      }
      if (collection.sort === "ACTION_DATE") {
        await applyActionDateOrder(
          client,
          plexCollection.ratingKey,
          desiredKeys,
          pendingActions,
          seriesScopeByRuleSet,
          seriesKeyByTitle,
          copyKeysByItemId,
          orderAsListed,
        );
      }

      // Visibility (propagate both enabled and disabled states), when it differs.
      const home = collection.homeScreen;
      const recommended = collection.recommended;
      const visible = await client.getCollectionVisibility(library.key, plexCollection.ratingKey);
      const wantAny = home || recommended;
      const alreadySet = visible?.identifier
        ? wantAny && visible.home === home && visible.shared === home && visible.recommended === recommended
        : !wantAny;
      if (!alreadySet) {
        await client.updateCollectionVisibility(
          library.key,
          plexCollection.ratingKey,
          home,
          home, // shared = same as home
          recommended,
          visible, // just read: not read again
        );
      }
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to sync collection "${collectionName}" for library ${library.id}`,
        { error: describePlexError(error) }
      );
    } finally {
      // Refresh the window from the LAST write: action-date ordering is one
      // `move` per item, and a big collection can outlast a mark placed before
      // the first write.
      if (serverId && touched.size > 0) markSelfWrites(serverId, touched);
    }
  }
}

/**
 * The fewest `move` calls that turn `current` into `target`, as
 * `[item, after]` pairs (`after` undefined = to the front). Plex's
 * `…/items/<item>/move?after=<other>` puts the item directly behind `other`.
 *
 * The longest run of items `current` already holds in `target`'s order stays
 * put; every other item, taken in `target` order, is moved behind its
 * predecessor in `target`. Each moved item ends up glued behind the item
 * before it, and the items left in place keep their relative order — which is
 * `target`'s — so the result is exactly `target`. An item `target` holds that
 * `current` does not is simply moved into place.
 */
export function planCollectionMoves(current: string[], target: string[]): Array<[string, string | undefined]> {
  const targetIndex = new Map(target.map((k, i) => [k, i]));
  const seq = current.map((k) => targetIndex.get(k)).filter((i): i is number => i !== undefined);

  // Longest strictly increasing subsequence of `seq` (patience sorting).
  const tails: number[] = []; // index into seq of the smallest tail per length
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<string>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prev[i]) keep.add(target[seq[i]]);

  const moves: Array<[string, string | undefined]> = [];
  for (let i = 0; i < target.length; i++) {
    if (!keep.has(target[i])) moves.push([target[i], i === 0 ? undefined : target[i - 1]]);
  }
  return moves;
}

/**
 * Reorder collection items by their scheduled action date (soonest first),
 * pooling the pending actions of every contributing rule set so items are
 * interleaved by action date across rules. Items without a pending action are
 * placed at the end; items that tie keep the order Plex already has them in.
 *
 * Only the items out of place are moved (`planCollectionMoves`), so a run
 * that changes no date sends no write — where every member used to be moved
 * one after another on every run.
 */
async function applyActionDateOrder(
  client: PlexClient,
  collectionRatingKey: string,
  desiredKeys: string[],
  pendingActions: PendingActionForOrder[],
  seriesScopeByRuleSet: Map<string, boolean>,
  seriesKeyByTitle: Map<string, string> | null,
  copyKeysByItemId: Map<string, string[]> = new Map(),
  /** The members in Plex's current order, if the caller already has it. */
  orderAsListed: string[] | null = null,
): Promise<void> {
  if (desiredKeys.length <= 1) return;

  // Map each collection rating key -> earliest scheduled deletion across rules.
  const scheduledByKey = new Map<string, Date>();
  for (const action of pendingActions) {
    if (!action.mediaItem || !action.ruleSetId) continue;
    const seriesScope = seriesScopeByRuleSet.get(action.ruleSetId) ?? false;

    const keys: string[] = [];
    if (seriesScope && seriesKeyByTitle) {
      // Series-scope: action's episode maps to a series-level key via parentTitle.
      const title = action.mediaItem.parentTitle ?? action.mediaItem.title;
      const key = seriesKeyByTitle.get(normTitle(title));
      if (key) keys.push(key);
    } else {
      keys.push(action.mediaItem.ratingKey);
      // Another server's copy of the title shares this action's date.
      if (action.mediaItemId) keys.push(...(copyKeysByItemId.get(action.mediaItemId) ?? []));
    }

    for (const key of keys) {
      const existing = scheduledByKey.get(key);
      if (!existing || action.scheduledFor < existing) {
        scheduledByKey.set(key, action.scheduledFor);
      }
    }
  }

  // Plex's order as it stands — read back after this pass's membership writes
  // unless the caller had it — is what the moves are planned from.
  const current =
    orderAsListed ?? ((await client.getCollectionItems(collectionRatingKey)) ?? []).map((i) => i.ratingKey);
  const currentIndex = new Map(current.map((k, i) => [k, i]));

  // Soonest deletion first; items without a pending action go last; a tie
  // keeps Plex's current order (then the desired order), so it needs no move.
  const desiredIndex = new Map(desiredKeys.map((k, i) => [k, i]));
  const sorted = [...desiredKeys].sort((a, b) => {
    const dateA = scheduledByKey.get(a);
    const dateB = scheduledByKey.get(b);
    if (dateA && dateB && dateA.getTime() !== dateB.getTime()) return dateA.getTime() - dateB.getTime();
    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;
    const posA = currentIndex.get(a) ?? Number.POSITIVE_INFINITY;
    const posB = currentIndex.get(b) ?? Number.POSITIVE_INFINITY;
    if (posA !== posB) return posA < posB ? -1 : 1;
    return desiredIndex.get(a)! - desiredIndex.get(b)!;
  });

  const moves = planCollectionMoves(current, sorted);
  for (const [item, after] of moves) {
    await client.moveCollectionItem(collectionRatingKey, item, after);
  }

  logger.debug(
    "Lifecycle",
    `Ordered ${sorted.length} items in collection by action date (${moves.length} moved)`
  );
}

/** One entry to take out of a Plex collection (see `removeItemsFromCollections`). */
export interface CollectionRemoval {
  /** The collection's library type. */
  type: string;
  collectionName: string;
  itemRatingKey: string;
  /**
   * For series-scope rules: the show's title — the series rating key is
   * resolved by title instead of using the item's own rating key.
   */
  seriesTitle: string | null;
  /**
   * The item's own library. A rating key identifies an item only within one
   * server — applied to every library, the same key on another server named a
   * different title, which this then removed from its collection.
   */
  libraryId?: string;
}

/**
 * Take items out of their Plex collections — what excluding them from
 * lifecycle actions asks for. Grouped by library and collection, so each
 * library's collection listing (and, for shows, its show listing) is read
 * once and each collection's members once, however many entries name it; a
 * collection left with no member is deleted.
 */
export async function removeItemsFromCollections(userId: string, removals: CollectionRemoval[]): Promise<void> {
  // One library lookup per distinct (type, library) scope.
  const scopes = new Map<string, { type: string; libraryId?: string; removals: CollectionRemoval[] }>();
  for (const r of removals) {
    const key = `${r.type}\u0000${r.libraryId ?? "*"}`;
    const scope = scopes.get(key) ?? { type: r.type, libraryId: r.libraryId, removals: [] };
    scope.removals.push(r);
    scopes.set(key, scope);
  }

  const byLibrary = new Map<
    string,
    { library: Awaited<ReturnType<typeof libraryRows>>[number]; removals: CollectionRemoval[] }
  >();
  for (const scope of scopes.values()) {
    for (const library of await libraryRows(userId, scope.type, scope.libraryId)) {
      const entry = byLibrary.get(library.id) ?? { library, removals: [] };
      entry.removals.push(...scope.removals);
      byLibrary.set(library.id, entry);
    }
  }

  for (const { library, removals: forLibrary } of byLibrary.values()) {
    const names = [...new Set(forLibrary.map((r) => r.collectionName))];
    try {
      if (!library.mediaServer?.machineId) continue;

      const server = library.mediaServer;
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      const collections = await client.getCollections(library.key);
      let showKeys: Map<string, string> | null = null;

      for (const name of names) {
        const collection = collections.find((c) => c.title === name);
        if (!collection) continue;
        try {
          // For series-scope rules, resolve the series-level ratingKey by title —
          // matched as the sync matched it when adding the show; an exact compare
          // missed a show stored "the office" that Plex calls "The Office".
          const wanted = new Set<string>();
          for (const r of forLibrary.filter((x) => x.collectionName === name)) {
            if (r.seriesTitle) {
              showKeys ??= seriesKeysByTitle(await client.getLibraryItems(library.key));
              const showKey = showKeys.get(normTitle(r.seriesTitle));
              if (showKey) wanted.add(showKey);
            } else {
              wanted.add(r.itemRatingKey);
            }
          }
          if (wanted.size === 0) continue;

          // Only what is actually in the collection is removed.
          const currentItems = await client.getCollectionItems(collection.ratingKey);
          const toRemove = currentItems.map((i) => i.ratingKey).filter((k) => wanted.has(k));
          if (toRemove.length === 0) continue;

          markSelfWrites(server.id, [collection.ratingKey, ...toRemove]);
          await mapWithConcurrency(toRemove, COLLECTION_REMOVE_CONCURRENCY, (key) =>
            client.removeCollectionItem(collection.ratingKey, key),
          );

          // Re-check emptiness AFTER removal — a stale pre-removal count could
          // wrongly delete a collection that still holds other items (e.g. the
          // collection grew between the fetch and the remove). Re-fetch the
          // items so the delete only fires when the collection is genuinely empty.
          const remainingItems = await client.getCollectionItems(collection.ratingKey);
          if (remainingItems.length === 0) {
            await client.deleteCollection(collection.ratingKey);
            logger.info(
              "Lifecycle",
              `Removed empty Plex collection "${name}" after excluding item`
            );
          } else {
            logger.info(
              "Lifecycle",
              `Removed ${toRemove.length} excluded item(s) from Plex collection "${name}"`
            );
          }
        } catch (error) {
          logger.error(
            "Lifecycle",
            `Failed to remove item from collection "${name}" in library ${library.id}`,
            { error: describePlexError(error) }
          );
        }
      }
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to remove item from collection "${names.join(", ")}" in library ${library.id}`,
        { error: describePlexError(error) }
      );
    }
  }
}

function libraryRows(userId: string, type: string, libraryId?: string) {
  return prisma.library.findMany({
    where: {
      mediaServer: { userId, type: "PLEX" },
      type: type as "MOVIE" | "SERIES" | "MUSIC",
      ...(libraryId ? { id: libraryId } : {}),
    },
    include: { mediaServer: true },
  });
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
  seriesTitle: string | null,
  /** The item's own library (see `CollectionRemoval.libraryId`). */
  libraryId?: string
) {
  await removeItemsFromCollections(userId, [{ type, collectionName, itemRatingKey, seriesTitle, libraryId }]);
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

      markSelfWrites(server.id, [collection.ratingKey]);
      await client.deleteCollection(collection.ratingKey);
      logger.info(
        "Lifecycle",
        `Removed Plex collection "${collectionName}" from library "${library.title}"`
      );
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to remove collection "${collectionName}" from library ${library.id}`,
        { error: describePlexError(error) }
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

      markSelfWrites(server.id, [collection.ratingKey]);
      await client.renameCollection(library.key, collection.ratingKey, newName);
      logger.info(
        "Lifecycle",
        `Renamed Plex collection "${oldName}" → "${newName}" in library "${library.title}"`
      );
    } catch (error) {
      logger.error(
        "Lifecycle",
        `Failed to rename collection "${oldName}" → "${newName}" in library ${library.id}`,
        { error: describePlexError(error) }
      );
    }
  }
}
