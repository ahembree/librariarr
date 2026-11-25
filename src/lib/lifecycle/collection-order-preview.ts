/**
 * The Collection Order Preview: the order a Plex collection's members would
 * be in after the next sync, against the order Plex holds now — computed with
 * the sync's own membership and ordering (`planLibraryMembership`,
 * `collectionSortValues`, `orderCollectionKeys`, `planCollectionMoves`), and
 * writing nothing.
 *
 * The rule editor previews its unsaved rules: the rule set being edited
 * contributes its evaluated candidates (`buildEditorContribution`) in place of
 * its stored matches, beside every other rule set's stored ones, and an
 * Action date sort estimates a date for a match that has no pending action
 * yet (`editorPendingActions`).
 */
import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { describePlexError } from "@/lib/plex/errors";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { formatMediaItemTitle } from "@/lib/media/display-title";
import { CollectionSyncCache } from "@/lib/lifecycle/collection-sync-cache";
import { isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { ACTION_SIGNATURE_SELECT, actionConfigSignature, type ActionConfig } from "@/lib/lifecycle/action-signature";
import { coverageOf, uncoveredEpisodes } from "@/lib/lifecycle/episode-coverage";
import { heldScheduledFor, loadGroupedActionHold } from "@/lib/lifecycle/grouped-action-hold";
import {
  collectionSortValues,
  orderCollectionKeys,
  planCollectionMoves,
  planLibraryMembership,
  type CollectionContribution,
  type MatchedItem,
  type PendingActionForOrder,
} from "@/lib/lifecycle/collections";
import {
  collectionSortDirectionOf,
  collectionSortFieldOf,
  plexCollectionSortMode,
  type CollectionSortDirection,
  type CollectionSortField,
} from "@/lib/lifecycle/collection-sort";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CollectionOrderPreviewItem {
  ratingKey: string;
  title: string;
  /** The sort value: text for Title, epoch ms for a date, a number otherwise; null when the item has none. */
  value: number | string | null;
  /** The action date is an estimate (a match with no pending action yet). */
  estimated?: true;
  /** 0-based position after the sync. */
  position: number;
  /** 0-based position in Plex now; null when the item is not in the collection yet, or Plex's order is unknown. */
  previousPosition: number | null;
}

export interface CollectionOrderPreviewRemoved {
  ratingKey: string;
  title: string;
  previousPosition: number;
}

/**
 * - `ok`: the target order, diffed against Plex's current one.
 * - `currentUnknown`: the target order alone — Plex's current one could not be read.
 * - `untouched`: the sync leaves this library's collection as it is (matches that resolve to no item here).
 * - `skipped`: the sync cannot write this server (no stored machine id).
 * - `error`: the membership could not be worked out (Plex unreachable for a series-scope show lookup).
 */
export type CollectionOrderPreviewStatus = "ok" | "currentUnknown" | "untouched" | "skipped" | "error";

export interface CollectionOrderPreviewLibrary {
  libraryId: string;
  libraryTitle: string;
  serverName: string;
  status: CollectionOrderPreviewStatus;
  message: string | null;
  /** Whether Plex holds the collection in this library now; null when unknown. */
  collectionExists: boolean | null;
  /** Plex keeps this order itself (Title or Release date ascending); the sync moves nothing. */
  plexSorted: boolean;
  items: CollectionOrderPreviewItem[];
  removed: CollectionOrderPreviewRemoved[];
  /** The `move` calls the sync would send; null when Plex sorts the collection itself or its order is unknown. */
  moves: number | null;
}

export interface CollectionOrderPreview {
  field: CollectionSortField;
  direction: CollectionSortDirection;
  libraries: CollectionOrderPreviewLibrary[];
}

export interface CollectionOrderPreviewInput {
  userId: string;
  collection: {
    name: string;
    /**
     * The name Plex holds the collection by now, when it differs from `name`:
     * an existing collection renamed in the editor is renamed on Plex by the
     * save, so its current order is read under the stored name.
     */
    plexName?: string;
    type: "MOVIE" | "SERIES" | "MUSIC";
    sort: string;
    sortDirection?: string | null;
  };
  contributions: CollectionContribution[];
  /** PENDING actions of the contributing rule sets (estimates marked `estimated`); read for an Action date sort only. */
  pendingActions: PendingActionForOrder[];
  cache?: CollectionSyncCache;
}

/** A candidate the editor's evaluation returned, as the preview reads it. */
export interface EditorCandidate {
  id: string;
  libraryId: string;
  ratingKey: string;
  title: string | null;
  parentTitle: string | null;
  /** A show's or artist's matched episodes or tracks (a group match). */
  memberIds?: string[];
}

/**
 * The edited rule set's contribution from its unsaved candidates. A candidate
 * detection folded onto another server's copy (`itemData.copies` of a stored
 * match) is marked as that copy, so it shares the match's pending action.
 */
export async function buildEditorContribution(
  ruleSetId: string | undefined,
  seriesScope: boolean,
  candidates: EditorCandidate[],
  /**
   * Stored matches the save keeps though the rules no longer select them —
   * sticky matches, while the save leaves what the rule set matches alone.
   */
  keptItems: MatchedItem[] = [],
): Promise<CollectionContribution> {
  const copyOf = new Map<string, string>();
  if (ruleSetId) {
    const stored = await prisma.$queryRawUnsafe<Array<{ mediaItemId: string; copies: unknown }>>(
      `SELECT "mediaItemId", "itemData"->'copies' AS "copies" FROM "RuleMatch" WHERE "ruleSetId" = $1`,
      ruleSetId,
    );
    for (const row of stored ?? []) {
      const copies = Array.isArray(row.copies) ? (row.copies as Array<{ id?: unknown }>) : [];
      for (const c of copies) if (typeof c.id === "string") copyOf.set(c.id, row.mediaItemId);
    }
  }
  const items: MatchedItem[] = candidates
    .filter((c) => c.libraryId && c.ratingKey)
    .map((c) => {
      const of = copyOf.get(c.id);
      return {
        libraryId: c.libraryId,
        ratingKey: c.ratingKey,
        title: c.title ?? "",
        parentTitle: c.parentTitle ?? null,
        ...(of && of !== c.id ? { copyOf: of } : {}),
      };
    });
  const seen = new Set(items.map((i) => `${i.libraryId}\u0000${i.ratingKey}`));
  for (const item of keptItems) {
    const key = `${item.libraryId}\u0000${item.ratingKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return { ruleSetId: ruleSetId ?? "__editor__", seriesScope, items };
}

/** The edited rule set's action as a save would store it. */
export interface EditorActionPlan {
  armed: boolean;
  delayDays: number;
  /** The rule set's library type: a show's or artist's action waits out the grouped-action hold. */
  type: "MOVIE" | "SERIES" | "MUSIC";
  /** Decides which settled actions keep a new one from being scheduled (`actionConfigSignature`). */
  config: ActionConfig;
}

/**
 * The edited rule set's pending actions as the preview orders by them,
 * mirroring `scheduleActionsForRuleSet`: a candidate keeps its PENDING
 * action's date; one without gets an estimate — now + the action delay, a
 * group's held to the grouped-action hold — when the editor's action is on
 * and scheduling would create one: never for a non-destructive action a
 * settled action of the same signature already ran on the item (a show:
 * on every matched episode). An action on an item that no longer matches is
 * left out — scheduling cancels it.
 */
export async function editorPendingActions(
  userId: string,
  ruleSetId: string | undefined,
  candidates: EditorCandidate[],
  action: EditorActionPlan,
  now: Date = new Date(),
): Promise<PendingActionForOrder[]> {
  const candidateIds = new Set(candidates.map((c) => c.id));
  const contributionId = ruleSetId ?? "__editor__";
  const existing: PendingActionForOrder[] = ruleSetId
    ? (await prisma.lifecycleAction.findMany({
        where: { ruleSetId, status: "PENDING" },
        select: {
          scheduledFor: true,
          ruleSetId: true,
          mediaItemId: true,
          mediaItem: { select: { ratingKey: true, parentTitle: true, title: true } },
        },
      })).filter((a) => a.mediaItemId != null && candidateIds.has(a.mediaItemId))
    : [];
  const actionType = action.config.actionType;
  if (!action.armed || !actionType) return existing;

  const scheduled = new Set(existing.map((a) => a.mediaItemId));
  let toSchedule = candidates.filter((c) => !scheduled.has(c.id));

  if (ruleSetId && !isDestructiveActionType(actionType) && toSchedule.length > 0) {
    const signature = actionConfigSignature(action.config);
    const settled = (await prisma.lifecycleAction.findMany({
      where: { ruleSetId, status: { in: ["COMPLETED", "FAILED"] }, actionType, releasedAt: null },
      select: ACTION_SIGNATURE_SELECT,
    })).filter((a) => actionConfigSignature(a) === signature);
    if (action.type === "SERIES") {
      const coverage = coverageOf(settled);
      toSchedule = toSchedule.filter((c) => uncoveredEpisodes(c.id, c.memberIds ?? [], coverage).length > 0);
    } else {
      const ran = new Set(settled.map((a) => a.mediaItemId));
      toSchedule = toSchedule.filter((c) => !ran.has(c.id));
    }
  }
  if (toSchedule.length === 0) return existing;

  const hold = await loadGroupedActionHold(userId, now);
  const estimate = new Date(now.getTime() + action.delayDays * DAY_MS);
  const estimated: PendingActionForOrder[] = toSchedule.map((c) => ({
    scheduledFor: heldScheduledFor(estimate, hold, { type: action.type, title: c.title, parentTitle: c.parentTitle }),
    ruleSetId: contributionId,
    mediaItemId: c.id,
    mediaItem: { ratingKey: c.ratingKey, parentTitle: c.parentTitle, title: c.title ?? "" },
    estimated: true,
  }));
  return [...existing, ...estimated];
}

/** Display titles of a library's stored rows by rating key (an episode as "<Show> SxxExx"). */
async function storedTitles(libraryId: string, keys: string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<Array<{
    ratingKey: string;
    title: string;
    parentTitle: string | null;
    type: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
  }>>(
    `SELECT "ratingKey", "title", "parentTitle", "type"::text AS "type", "seasonNumber", "episodeNumber"
       FROM "MediaItem"
      WHERE "libraryId" = $1 AND "ratingKey" = ANY($2::text[])`,
    libraryId,
    keys,
  );
  return new Map((rows ?? []).map((r) => [
    r.ratingKey,
    // A track names its artist too: an artist match is held as one of its tracks.
    r.type === "MUSIC" && r.parentTitle ? `${r.parentTitle} — ${r.title}` : formatMediaItemTitle(r),
  ]));
}

function plexItemTitle(item: { title?: string; grandparentTitle?: string }): string {
  const title = item.title?.trim() || "Unknown";
  return item.grandparentTitle ? `${item.grandparentTitle} — ${title}` : title;
}

export async function previewCollectionOrder(input: CollectionOrderPreviewInput): Promise<CollectionOrderPreview> {
  const { collection, contributions, pendingActions } = input;
  const cache = input.cache ?? new CollectionSyncCache();
  const field = collectionSortFieldOf(collection.sort);
  const direction = collectionSortDirectionOf(collection.sortDirection);
  const plexSorted = plexCollectionSortMode(field, direction) !== 2;
  const seriesScopeByRuleSet = new Map(contributions.map((c) => [c.ruleSetId, c.seriesScope]));
  const totalMatchedItems = contributions.reduce((n, c) => n + c.items.length, 0);

  const libraries = await prisma.library.findMany({
    where: { mediaServer: { userId: input.userId, type: "PLEX" }, type: collection.type },
    include: { mediaServer: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });

  const out: CollectionOrderPreviewLibrary[] = [];
  for (const library of libraries) {
    const server = library.mediaServer;
    const base = {
      libraryId: library.id,
      libraryTitle: library.title,
      serverName: server?.name ?? "",
      plexSorted,
      items: [] as CollectionOrderPreviewItem[],
      removed: [] as CollectionOrderPreviewRemoved[],
      moves: null as number | null,
      collectionExists: null as boolean | null,
    };
    const hasItemsHere = contributions.some((c) => c.items.some((i) => i.libraryId === library.id));
    if (!server?.machineId) {
      if (hasItemsHere) {
        out.push({ ...base, status: "skipped", message: `Plex server "${server?.name ?? "?"}" has no stored machine identifier, so the sync skips it. Re-add the server to store it.` });
      }
      continue;
    }
    const client = new PlexClient(server.url, server.accessToken, { skipTlsVerify: server.tlsSkipVerify });

    let plan;
    try {
      plan = await planLibraryMembership(collection, contributions, library, client, cache);
    } catch (error) {
      out.push({
        ...base,
        status: "error",
        message: `Couldn't read the library's shows from Plex: ${sanitizeErrorDetail(describePlexError(error)) ?? "unknown error"}`,
      });
      continue;
    }
    const { desiredKeys, desiredSet } = plan;

    // The sync's resolution guard: matches that resolve to nothing here leave
    // the collection as it is.
    if (desiredKeys.length === 0 && totalMatchedItems > 0) {
      if (plan.libItemCount > 0) {
        out.push({
          ...base,
          status: "untouched",
          message: `${plan.libItemCount} matched item(s) belong to this library but none resolved to a Plex item — the sync leaves the collection here as it is. Sync the library and preview again.`,
        });
      }
      continue;
    }

    // Plex's current order.
    let current: Array<{ ratingKey: string; title?: string; grandparentTitle?: string }> | null = null;
    let collectionExists: boolean | null = null;
    let currentError: string | null = null;
    try {
      const listing = await cache.collections(library.id, () => client.getCollections(library.key));
      const plexName = collection.plexName ?? collection.name;
      const plexCollection = listing.find((c) => c.title === plexName);
      collectionExists = !!plexCollection;
      current = plexCollection ? ((await client.getCollectionItems(plexCollection.ratingKey)) ?? []) : [];
    } catch (error) {
      currentError = `Couldn't read the collection from Plex, so its current order is unknown: ${sanitizeErrorDetail(describePlexError(error)) ?? "unknown error"}`;
    }

    // Nothing to hold and nothing held: the sync does nothing here.
    if (desiredKeys.length === 0 && (current === null || current.length === 0)) continue;

    const currentKeys = (current ?? []).map((i) => i.ratingKey);
    const estimatedKeys = new Set<string>();
    const values = await collectionSortValues(field, library.id, plan, pendingActions, seriesScopeByRuleSet, estimatedKeys);
    const target = orderCollectionKeys(desiredKeys, values, direction, currentKeys);

    // What Plex holds once the membership writes are done: the members kept,
    // in their order, then the added ones (Plex appends them; a new
    // collection is created in the desired order).
    const kept = currentKeys.filter((k) => desiredSet.has(k));
    const keptSet = new Set(kept);
    const afterMembership = collectionExists ? [...kept, ...desiredKeys.filter((k) => !keptSet.has(k))] : desiredKeys;
    const moves = plexSorted || current === null ? null : planCollectionMoves(afterMembership, target).length;

    const titles = await storedTitles(library.id, [...new Set([...target, ...currentKeys])]);
    const plexTitles = new Map((current ?? []).map((i) => [i.ratingKey, plexItemTitle(i)]));
    const titleOf = (key: string) =>
      titles.get(key) ?? plan.showTitleByKey?.get(key) ?? plexTitles.get(key) ?? key;
    const currentIndex = new Map(currentKeys.map((k, i) => [k, i]));

    out.push({
      ...base,
      status: currentError ? "currentUnknown" : "ok",
      message: currentError,
      collectionExists,
      moves,
      items: target.map((key, position) => {
        const value = values.get(key);
        return {
          ratingKey: key,
          title: titleOf(key),
          value: value === undefined || (typeof value === "number" && Number.isNaN(value)) ? null : value,
          ...(estimatedKeys.has(key) ? { estimated: true as const } : {}),
          position,
          previousPosition: current === null ? null : (currentIndex.get(key) ?? null),
        };
      }),
      removed: currentKeys
        .filter((k) => !desiredSet.has(k))
        .map((key) => ({ ratingKey: key, title: titleOf(key), previousPosition: currentIndex.get(key)! })),
    });
  }

  return { field, direction, libraries: out };
}
