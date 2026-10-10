import { prisma } from "@/lib/db";
import type { LibraryType, Prisma } from "@/generated/prisma/client";
import { hasArrRules, hasSeerrRules, hasAnyActiveRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import { logger } from "@/lib/logger";
import { executeAction, extractActionError, describeActionError } from "@/lib/lifecycle/actions";
import { actionTargetTitle, actionTitleSnapshot, type ActionTargetParts } from "@/lib/lifecycle/action-target";
import { loadMemberEpisodes } from "@/lib/lifecycle/member-episodes";
import { formatMediaItemTitle, seriesTitleOf } from "@/lib/media/display-title";
import { matchIdentityChange } from "@/lib/lifecycle/match-identity";
import { arrExternalIdsOf, arrIdSourceFor } from "@/lib/lifecycle/cross-server-copies";
import { heldScheduledFor, loadGroupedActionHold } from "@/lib/lifecycle/grouped-action-hold";
import { UnreachableInstances } from "@/lib/lifecycle/unreachable-instances";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { checkDeleteCeiling } from "@/lib/lifecycle/delete-ceiling";
import { reserveApiDestructive, type ApiDestructiveReservation } from "@/lib/api-keys/destructive-budget";
import { tryBeginExecute, endExecute } from "@/lib/lifecycle/execute-in-flight";
import {
  findExceptedItemIds,
  findExceptionProtectedGroups,
  protectionKey,
  isWholeRecordDestructiveAction,
  type ProtectionTarget,
} from "@/lib/lifecycle/exception-guard";
import { actionConfigSignature } from "@/lib/lifecycle/action-signature";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { syncAllCollections } from "@/lib/lifecycle/collections";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { sendDiscordNotification, buildSuccessSummaryEmbed, buildMatchChangeEmbed, buildFailureSummaryEmbed } from "@/lib/discord/client";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { eventBus } from "@/lib/events/event-bus";
import { computeDeletedBytes } from "@/lib/lifecycle/deleted-bytes";

function formatTitleWithYear(title: string, year: number | null): string {
  if (!year) return title;
  const suffix = `(${year})`;
  if (title.endsWith(suffix)) return title;
  return `${title} ${suffix}`;
}

/**
 * How this executor's log lines and notifications name the item an action ran
 * on. A series action is stored against one representative episode but acts on
 * the show, so it is named by the show — "<Show> SxxExx" when it acts on one
 * episode (`actionTargetTitle`) — never by that episode's own title. A track is
 * named by its artist, anything else by its own title.
 */
function executedTitle(action: ActionTargetParts): string {
  const item = action.mediaItem;
  if (item.type === "SERIES") return actionTargetTitle(action);
  return item.parentTitle ?? item.title;
}

/**
 * `executedTitle`, plus the year for an item named by its own title. A show or
 * artist gets none: the year is the episode's or track's own, not the show's
 * (a series action on "Breaking Bad" stored against a 2013 episode is not
 * "Breaking Bad (2013)").
 */
function notificationTitle(action: ActionTargetParts & { mediaItem: { year: number | null } }): string {
  const item = action.mediaItem;
  if (item.type === "SERIES" || item.parentTitle) return executedTitle(action);
  return formatTitleWithYear(item.title, item.year);
}

interface ActionSchedulingRuleSet {
  id: string;
  userId: string;
  name: string;
  type: string;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  arrInstanceId: string | null;
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  addArrTags: string[];
  removeArrTags: string[];
}

/**
 * Schedule lifecycle actions for a rule set based on current matches.
 * - Deletes PENDING actions for items that no longer match
 * - Deduplicates PENDING actions
 * - Creates new PENDING actions for newly matched items (preserving existing ones)
 */
export async function scheduleActionsForRuleSet(
  ruleSet: ActionSchedulingRuleSet,
  matchedItems: Record<string, unknown>[],
  episodeIdMap: Map<string, string[]>,
): Promise<void> {
  // If actions are disabled or no action type is configured, delete all pending actions and return early
  if (!ruleSet.actionEnabled || !ruleSet.actionType) {
    const deleted = await prisma.lifecycleAction.deleteMany({
      where: { ruleSetId: ruleSet.id, status: "PENDING" },
    });
    if (deleted.count > 0) {
      const reason = !ruleSet.actionEnabled ? "actions disabled" : "no action type configured";
      logger.info("Lifecycle", `Deleted ${deleted.count} pending actions for rule set "${ruleSet.name}" (${reason})`);
    }
    return;
  }

  const currentIds = new Set(matchedItems.map((item) => item.id as string));

  // Delete pending actions for items no longer in the match set
  const previousPending = await prisma.lifecycleAction.findMany({
    where: { ruleSetId: ruleSet.id, status: "PENDING" },
    select: { mediaItemId: true },
  });
  const pendingIds = new Set(previousPending.map((a) => a.mediaItemId).filter((id): id is string => id !== null));
  const stalePendingIds = [...pendingIds].filter((id) => !currentIds.has(id));

  if (stalePendingIds.length > 0) {
    await prisma.lifecycleAction.deleteMany({
      where: { ruleSetId: ruleSet.id, status: "PENDING", mediaItemId: { in: stalePendingIds } },
    });
    logger.info("Lifecycle", `Deleted ${stalePendingIds.length} pending actions for items no longer matching rule set "${ruleSet.name}"`);
  }

  // Delete orphaned pending actions whose media item was purged from the DB (FK is
  // SetNull, so mediaItemId goes null). These can never execute; the stale check above
  // only covers non-null ids, so sweep them here for immediate self-healing.
  const orphaned = await prisma.lifecycleAction.deleteMany({
    where: { ruleSetId: ruleSet.id, status: "PENDING", mediaItemId: null },
  });
  if (orphaned.count > 0) {
    logger.info("Lifecycle", `Deleted ${orphaned.count} orphaned pending actions (media item no longer exists) for rule set "${ruleSet.name}"`);
  }

  // Deduplicate: clean up any duplicate PENDING actions (from concurrent runs)
  const allPending = await prisma.lifecycleAction.findMany({
    where: { ruleSetId: ruleSet.id, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: { id: true, mediaItemId: true },
  });
  const seenItems = new Set<string>();
  const duplicateIds: string[] = [];
  for (const action of allPending) {
    if (!action.mediaItemId) continue;
    if (seenItems.has(action.mediaItemId)) {
      duplicateIds.push(action.id);
    }
    seenItems.add(action.mediaItemId);
  }
  if (duplicateIds.length > 0) {
    await prisma.lifecycleAction.deleteMany({ where: { id: { in: duplicateIds } } });
    logger.info("Lifecycle", `Removed ${duplicateIds.length} duplicate pending actions for rule set "${ruleSet.name}"`);
  }

  const matchedItemIds = matchedItems.map((item) => item.id as string);

  // Skip items that already have:
  // - A PENDING action of any type (prevents duplicates), or
  // - A COMPLETED/FAILED action that is the SAME EFFECTIVE ACTION we'd schedule
  //   now (same type AND same config — tags, target quality profile, Arr
  //   instance, search-after). Non-destructive actions leave the item in place,
  //   so it keeps matching and the same action would re-run as a no-op every
  //   cycle; suppressing it prevents that loop. But the block is keyed on the
  //   full action SIGNATURE, not just the type, so changing the action (e.g.
  //   "Search for New Copy" → "Delete from Radarr") OR re-configuring it
  //   (editing tags, picking a new quality profile) schedules the new action —
  //   it has never run on the item — without forcing the user to recreate the
  //   rule.
  // Destructive (DELETE*) actions are always re-schedulable: a still-matching
  // item after a "completed" delete means the delete likely failed silently
  // (e.g. Arr removed its record but the file remained on disk due to
  // permissions), so we never suppress them.
  const currentSignature = actionConfigSignature(ruleSet);
  const existingActionConditions: Prisma.LifecycleActionWhereInput[] = [{ status: "PENDING" }];
  if (!isDestructiveActionType(ruleSet.actionType!)) {
    existingActionConditions.push({
      status: { in: ["COMPLETED", "FAILED"] },
      actionType: ruleSet.actionType!,
    });
  }
  const existingActions = await prisma.lifecycleAction.findMany({
    where: {
      ruleSetId: ruleSet.id,
      mediaItemId: { in: matchedItemIds },
      OR: existingActionConditions,
    },
    select: {
      mediaItemId: true,
      status: true,
      actionType: true,
      arrInstanceId: true,
      targetQualityProfileId: true,
      addImportExclusion: true,
      searchAfterAction: true,
      addArrTags: true,
      removeArrTags: true,
    },
  });
  const existingItemIds = new Set<string | null>();
  for (const action of existingActions) {
    // A PENDING action always blocks (dedup). A completed/failed action only
    // blocks when its config matches what we'd schedule now — a re-configured
    // action has a different signature and is allowed through.
    if (action.status === "PENDING" || actionConfigSignature(action) === currentSignature) {
      existingItemIds.add(action.mediaItemId);
    }
  }

  const newItems = matchedItems.filter((item) => !existingItemIds.has(item.id as string));

  if (newItems.length > 0) {
    const scheduledFor = new Date();
    scheduledFor.setDate(scheduledFor.getDate() + ruleSet.actionDelayDays);
    const externalIds = await arrExternalIdsOf(ruleSet.type as LibraryType, newItems);
    // A show's or an artist's action waits out the one-time upgrade hold.
    const hold = await loadGroupedActionHold(ruleSet.userId);
    const dueAt = (item: Record<string, unknown>) =>
      heldScheduledFor(scheduledFor, hold, { type: ruleSet.type, title: item.title, parentTitle: item.parentTitle });

    await prisma.lifecycleAction.createMany({
      data: newItems.map((item) => ({
        userId: ruleSet.userId,
        mediaItemId: item.id as string,
        // The identity the executor re-checks before it acts. A series or
        // artist match is its group: the show or artist as the title, no
        // parent — see matchIdentityChange.
        mediaItemTitle: (item.title as string) ?? null,
        mediaItemParentTitle: (item.parentTitle as string | null) ?? null,
        mediaItemYear: typeof item.year === "number" ? item.year : null,
        mediaItemExternalId: externalIds.get(item.id as string) ?? null,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        ruleSetType: ruleSet.type,
        actionType: ruleSet.actionType!,
        addImportExclusion: ruleSet.addImportExclusion,
        searchAfterAction: ruleSet.searchAfterAction,
        matchedMediaItemIds: episodeIdMap.get(item.id as string) ?? [],
        addArrTags: ruleSet.addArrTags,
        removeArrTags: ruleSet.removeArrTags,
        scheduledFor: dueAt(item),
        arrInstanceId: ruleSet.arrInstanceId,
        targetQualityProfileId: ruleSet.targetQualityProfileId,
      })),
      skipDuplicates: true,
    });

    for (const item of newItems) {
      logger.info("Lifecycle", `Scheduled ${ruleSet.actionType} for "${item.title}" on ${dueAt(item).toISOString()}`);
    }
  }
}

export async function processLifecycleRules(userId?: string) {
  const ruleSets = await prisma.ruleSet.findMany({
    where: {
      enabled: true,
      ...(userId ? { userId } : {}),
    },
    include: {
      user: {
        include: { mediaServers: { where: { enabled: true }, select: { id: true } } },
      },
    },
  });

  // Cache Plex library items across rule sets to avoid redundant API calls
  const plexItemsCache = new Map<string, Array<{ title: string; ratingKey: string }>>();
  // Arr/Seerr metadata shared across rule sets of the same owner + type
  // (mirrors runDetection). Each Seerr request page makes Seerr query every
  // Arr instance it knows, so re-walking the whole request list once per rule
  // set multiplied the cost — and let rule sets in one run read different
  // snapshots. A failed fetch is cached too, so the remaining rule sets of that
  // type skip immediately (each through its own catch below).
  const metadataCache = new Map<string, Promise<ArrDataMap | SeerrDataMap>>();
  const loadMetadata = <T extends ArrDataMap | SeerrDataMap>(key: string, load: () => Promise<T>): Promise<T> => {
    let pending = metadataCache.get(key);
    if (!pending) {
      pending = load();
      metadataCache.set(key, pending);
    }
    return pending as Promise<T>;
  };

  for (const ruleSet of ruleSets) {
    try {
      const allServerIds = ruleSet.user.mediaServers.map((s) => s.id);
      const serverIds = ruleSet.serverIds.filter((id) => allServerIds.includes(id));
      if (serverIds.length === 0) {
        logger.debug("Lifecycle", `Skipping rule set "${ruleSet.name}" — no valid servers`);
        continue;
      }

      const rules = ruleSet.rules as unknown as LifecycleRule[] | LifecycleRuleGroup[];

      // At least 1 enabled rule is required — skip entirely to avoid matching everything
      if (!hasAnyActiveRules(rules)) {
        logger.debug("Lifecycle", `Skipping rule set "${ruleSet.name}" — no active rules`);
        continue;
      }

      // MATCH-ALL SAFETY: Arr/Seerr rules whose instances are unavailable must
      // skip the rule set — evaluating with an empty metadata map makes
      // "foundInArr = false" / "seerrRequested = false" match the whole
      // library and schedule destructive actions for everything. Transient
      // failures (instance disabled) leave matches/actions untouched, exactly
      // like a metadata fetch failure; a PERMANENT failure (Seerr on MUSIC)
      // also disarms the rule set, because a vacuous flood armed before this
      // guard existed would otherwise stay frozen forever and still execute.
      const evaluability = await checkLifecycleRuleEvaluability(
        ruleSet.userId,
        ruleSet.type,
        rules,
        ruleSet.serverIds,
        ruleSet.arrInstanceId,
      );
      if (!evaluability.evaluable) {
        logger.warn("Lifecycle", `Skipping rule set "${ruleSet.name}" — ${evaluability.reason}`);
        if (evaluability.permanent) {
          const cancelled = await prisma.lifecycleAction.deleteMany({
            where: { ruleSetId: ruleSet.id, status: "PENDING" },
          });
          const cleared = await prisma.ruleMatch.deleteMany({ where: { ruleSetId: ruleSet.id } });
          if (cancelled.count > 0 || cleared.count > 0) {
            logger.warn("Lifecycle", `Disarmed permanently unevaluable rule set "${ruleSet.name}" — cancelled ${cancelled.count} pending action(s) and cleared ${cleared.count} stale match(es)`);
          }
        }
        continue;
      }

      let arrData: ArrDataMap | undefined;
      if (hasArrRules(rules)) {
        const type = ruleSet.type;
        // Keyed by the rule set's instance too: its Arr criteria are read from
        // that instance alone (see `resolveArrInstanceScope`).
        arrData = await loadMetadata(`arr:${ruleSet.userId}:${type}:${ruleSet.arrInstanceId ?? "*"}`, () =>
          fetchArrMetadata(ruleSet.userId, type, undefined, ruleSet.arrInstanceId),
        );
      }

      let seerrData: SeerrDataMap | undefined;
      if (hasSeerrRules(rules) && ruleSet.type !== "MUSIC") {
        const type = ruleSet.type;
        seerrData = await loadMetadata(`seerr:${ruleSet.userId}:${type}`, () =>
          fetchSeerrMetadata(ruleSet.userId, type),
        );
      }

      // Snapshot previous match IDs before detection writes new ones (for notifications)
      const previousMatchIds = ruleSet.discordNotifyOnMatch
        ? new Set(
            (await prisma.ruleMatch.findMany({
              where: { ruleSetId: ruleSet.id },
              select: { mediaItemId: true },
            })).map((m) => m.mediaItemId)
          )
        : undefined;

      // Evaluate rules and save match results to DB (incremental: add new, remove stale)
      const { items: matchedItems, episodeIdMap } = await detectAndSaveMatches(
        {
          id: ruleSet.id,
          name: ruleSet.name,
          userId: ruleSet.userId,
          type: ruleSet.type,
          rules: ruleSet.rules,
          seriesScope: ruleSet.seriesScope,
          serverIds,
          actionEnabled: ruleSet.actionEnabled,
          actionType: ruleSet.actionType,
          actionDelayDays: ruleSet.actionDelayDays,
          arrInstanceId: ruleSet.arrInstanceId,
          addImportExclusion: ruleSet.addImportExclusion,
          addArrTags: ruleSet.addArrTags,
          removeArrTags: ruleSet.removeArrTags,
          stickyMatches: ruleSet.stickyMatches,
        },
        serverIds,
        arrData,
        seerrData,
        false, // incremental: add new matches, remove stale ones
      );

      // Send Discord notification for match changes if configured.
      {
        const currentIds = new Set(matchedItems.map((item) => item.id as string));

        if (ruleSet.discordNotifyOnMatch && previousMatchIds) {
          try {
            const addedIds = [...currentIds].filter((id) => !previousMatchIds.has(id));
            const removedIds = [...previousMatchIds].filter((id) => !currentIds.has(id));

            if (addedIds.length > 0 || removedIds.length > 0) {
              const settings = await prisma.appSettings.findUnique({
                where: { userId: ruleSet.userId },
                select: { discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
              });
              if (settings?.discordWebhookUrl) {
                const addedTitles = matchedItems
                  .filter((item) => addedIds.includes(item.id as string))
                  .sort((a, b) => ((a.titleSort as string) ?? "").localeCompare((b.titleSort as string) ?? ""))
                  .map((item) => item.title as string);

                let removedTitles: string[] = [];
                if (removedIds.length > 0) {
                  const removedItems = await prisma.mediaItem.findMany({
                    where: { id: { in: removedIds } },
                    select: { title: true, parentTitle: true, titleSort: true },
                    orderBy: { titleSort: "asc" },
                  });
                  // A series match is its show in either scope, stored against
                  // one representative episode — never name it by that episode.
                  removedTitles = removedItems.map((item) =>
                    ruleSet.type === "SERIES" || ruleSet.seriesScope ? seriesTitleOf(item) : item.title
                  );
                }

                await sendDiscordNotification(settings.discordWebhookUrl, {
                  username: settings.discordWebhookUsername || "Librariarr",
                  avatar_url: settings.discordWebhookAvatarUrl || undefined,
                  embeds: [buildMatchChangeEmbed(ruleSet.name, addedIds.length, removedIds.length, ruleSet.type, addedTitles, removedTitles)],
                });
              }
            }
          } catch {
            // Don't let notification failures break lifecycle processing
          }
        }
      }

      // Cancel stale actions and create new ones via shared scheduling function
      await scheduleActionsForRuleSet(ruleSet, matchedItems, episodeIdMap);
    } catch (error) {
      logger.error("Lifecycle", `Error processing rule set "${ruleSet.name}"`, { error: String(error) });
    }
  }

  // Sync every Plex collection from the now-persisted matches. Membership is the
  // UNION of every rule set feeding a collection, so this runs once after all
  // rule sets (and their actions) are processed — never per rule set. Collections
  // with no remaining enabled rule sets resolve to an empty union and are removed
  // from Plex (replacing the old "disabled collection cleanup" pass).
  await syncAllCollections(userId, plexItemsCache);

  // Notify connected clients that detection is done
  const affectedUserIds = userId ? [userId] : [...new Set(ruleSets.map((rs) => rs.userId))];
  for (const uid of affectedUserIds) {
    eventBus.emit({ type: "lifecycle:detection-completed", userId: uid });
  }
}

/**
 * Tell the operator their run was held, over Discord if it is configured.
 *
 * A ceiling that silently does nothing is worse than no ceiling: the actions
 * stay PENDING and the user has no reason to go looking. Best-effort — the
 * caller swallows failures, exactly like every other notification path here,
 * because a webhook outage must not fail a lifecycle run.
 */
async function notifyDeleteCeilingReached(
  userId: string,
  verdict: { count: number; limit: number | null },
): Promise<void> {
  await notifyDeletionHeld(
    userId,
    `This run would have deleted **${verdict.count}** item(s), above the ` +
      `configured limit of **${verdict.limit}**.\n\nNothing was deleted. The ` +
      `actions are still pending — review them on the Pending page and execute ` +
      `them there if they are correct, or raise the limit in Settings.`,
  );
}

async function notifyDeletionHeld(userId: string, description: string): Promise<void> {
  const settings = await prisma.appSettings.findFirst({
    where: { userId },
    select: { discordWebhookUrl: true },
  });
  if (!settings?.discordWebhookUrl) return;

  await sendDiscordNotification(settings.discordWebhookUrl, {
    embeds: [
      {
        title: "Lifecycle deletion held for review",
        description,
        color: 0xf59e0b,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// A held API-queued run tells Discord at most once per 15 minutes: the run is
// cheap to queue again, and a client doing so in a loop while the limits hold
// it would otherwise post a message per call. Every hold is still logged.
const API_HOLD_NOTICE_INTERVAL_MS = 15 * 60 * 1000;
let lastApiHoldNoticeAt = Number.NEGATIVE_INFINITY;

/** Forget when the last API hold was announced. Tests only. */
export function resetApiHoldNotices(): void {
  lastApiHoldNoticeAt = Number.NEGATIVE_INFINITY;
}

/**
 * Record an action that ran after its PENDING row was removed (cancelled while
 * the Arr call was in flight), so the deletion is not missing from History and
 * the deletion stats. Best effort: the run carries on whatever happens here.
 */
async function recordVanishedAction(
  action: Prisma.LifecycleActionGetPayload<object> & { mediaItem?: unknown; ruleSet?: unknown },
  result: Omit<Prisma.LifecycleActionUncheckedCreateInput, "userId" | "actionType" | "scheduledFor">,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, createdAt, updatedAt, mediaItem, ruleSet, ...scalars } = action;
  const data: Prisma.LifecycleActionUncheckedCreateInput = { ...scalars, ...result };
  try {
    await prisma.lifecycleAction.create({ data });
  } catch {
    // The rule set may have been deleted along with the row; keep the history
    // under its recorded name.
    try {
      await prisma.lifecycleAction.create({ data: { ...data, ruleSetId: null } });
    } catch (error) {
      logger.error("Lifecycle", `Could not record the result of action ${id}`, { error: String(error) });
    }
  }
}

interface ExecuteLifecycleOptions {
  /**
   * The name of the API key that queued this run (`POST /api/v1/jobs/execution`).
   * Such a run is also held by the public API's destructive limits — see
   * `src/lib/api-keys/limits.ts` — because a key must not be able to delete
   * more through a queued run than it could by executing items directly.
   */
  viaApiKey?: string;
}

export async function executeLifecycleActions(userId?: string, options: ExecuteLifecycleOptions = {}) {
  const pendingActions = await prisma.lifecycleAction.findMany({
    where: {
      status: "PENDING",
      scheduledFor: { lte: new Date() },
      ruleSetId: { not: null },
      // A disabled rule set must never fire actions — detection skips disabled
      // sets so their matches are never cleaned up, leaving their PENDING
      // actions armed. This relation filter is the execution-side backstop.
      ruleSet: { is: { enabled: true } },
      ...(userId ? { userId } : {}),
    },
    include: {
      mediaItem: {
        include: {
          externalIds: true,
          library: {
            select: {
              key: true,
              mediaServerId: true,
            },
          },
        },
      },
      ruleSet: {
        select: {
          name: true,
          discordNotifyOnAction: true,
          userId: true,
          type: true,
          rules: true,
        },
      },
    },
  });

  // SAFETY: Batch-validate that each pending action's item still exists in
  // the RuleMatch table for its rule set. Cancel stale actions whose items
  // no longer match, preventing execution on items that shouldn't be actioned.
  const ruleSetIds = [...new Set(pendingActions.map((a) => a.ruleSetId).filter((id): id is string => id !== null))];
  const currentMatches = await prisma.ruleMatch.findMany({
    where: { ruleSetId: { in: ruleSetIds } },
    select: { ruleSetId: true, mediaItemId: true, itemData: true },
  });
  const matchSet = new Set(currentMatches.map((m) => `${m.ruleSetId}:${m.mediaItemId}`));
  // Current member (episode/track) ids per match, so execution can drop members
  // that have since stopped matching. Incremental detection refreshes
  // RuleMatch.itemData.memberIds, but an already-PENDING action keeps the member
  // list it was scheduled with — without this intersection a member that no
  // longer matches would still be acted on (e.g. an episode whose file grew past
  // a size threshold). Only populated when the match actually tracks members.
  const currentMemberIds = new Map<string, Set<string>>();
  for (const m of currentMatches) {
    const members = (m.itemData as { memberIds?: string[] } | null)?.memberIds;
    if (members && members.length > 0) {
      currentMemberIds.set(`${m.ruleSetId}:${m.mediaItemId}`, new Set(members));
    }
  }

  // Check for lifecycle exceptions — cancel any pending action on an excluded item
  const userIds = [...new Set(pendingActions.map((a) => a.userId))];
  const allExceptions = await prisma.lifecycleException.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, mediaItemId: true },
  });
  const exceptionSet = new Set(allExceptions.map((e) => `${e.userId}:${e.mediaItemId}`));
  // An exception on ANOTHER copy of an action's item or member — the same
  // dedupKey on another server — protects it too: the action acts on the Arr
  // record every copy is backed by. Excluding a title from the library page of
  // the copy detection did not keep left the kept copy's action armed.
  for (const uid of new Set(allExceptions.map((e) => e.userId))) {
    const candidates = pendingActions
      .filter((a) => a.userId === uid)
      .flatMap((a) => [a.mediaItemId, ...(a.matchedMediaItemIds ?? [])])
      .filter((id): id is string => !!id);
    for (const id of await findExceptedItemIds(uid, candidates)) exceptionSet.add(`${uid}:${id}`);
  }

  // Batch the whole-record sibling-exception lookup (exception inviolability,
  // part 2 — see the per-action check below) once per run instead of once per
  // action: findExceptionProtectedGroups is batch-shaped, and when the user
  // has no exceptions at all there is nothing to look up. Targets are the
  // mediaItem rows themselves so the guard can key on `seriesKey`.
  const wholeRecordTargetsByUser = new Map<string, ProtectionTarget[]>();
  for (const a of pendingActions) {
    if (!a.mediaItem || !isWholeRecordDestructiveAction(a.actionType)) continue;
    if (!protectionKey(a.mediaItem)) continue;
    const targets = wholeRecordTargetsByUser.get(a.userId) ?? [];
    targets.push(a.mediaItem);
    wholeRecordTargetsByUser.set(a.userId, targets);
  }
  const protectedGroupsByUser = new Map<string, Set<string>>();
  if (allExceptions.length > 0) {
    for (const [uid, targets] of wholeRecordTargetsByUser) {
      protectedGroupsByUser.set(uid, await findExceptionProtectedGroups(uid, targets));
    }
  }

  // Track server/library pairs that need a sync after destructive actions
  const librariesToSync = new Map<string, { serverId: string; libraryKey: string }>();

  // Collect successes per rule set for batched Discord notifications
  const successesByRuleSet = new Map<string, {
    userId: string;
    ruleSetName: string;
    actionType: string;
    titles: string[];
  }>();

  // Collect failures per rule set for batched Discord notifications
  const failuresByRuleSet = new Map<string, {
    userId: string;
    ruleSetName: string;
    actionType: string;
    discordNotify: boolean;
    failures: { title: string; error: string }[];
  }>();

  // A series action on exactly one episode other than the one it is stored
  // against is named after that episode ("<Show> SxxExx"), so look those up —
  // once for the run as scheduled, and again below for what pass 1 leaves.
  const memberEpisodes = await loadMemberEpisodes(pendingActions);

  // PASS 1 — cancel or narrow. Every check here runs BEFORE the ceiling is
  // counted, so the count is what the run would actually destroy: counting the
  // raw pending list included actions about to be cancelled as stale, excepted
  // or identity-swapped, and a held run (which `continue`d ahead of these
  // checks) cleaned none of them up, so the next run counted them again.
  // Cancelling is `deleteMany`: the row may already be gone (cancelled, or run
  // by a manual Execute, since the load above), and a P2025 here would abort
  // the whole run.
  type Pending = (typeof pendingActions)[number];
  const executable: Array<{
    action: Pending;
    mediaItem: NonNullable<Pending["mediaItem"]>;
    filteredMatchedIds: string[];
  }> = [];

  for (const action of pendingActions) {
    // Delete actions whose media item no longer exists
    if (!action.mediaItem || !action.mediaItemId) {
      await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
      logger.info("Lifecycle", `Deleted action ${action.id} — media item no longer exists`);
      continue;
    }

    const mediaItem = action.mediaItem;
    const target = actionTargetTitle({ ...action, mediaItem, memberEpisodes });

    // Permanent-invalidity backstop: a MUSIC rule set with Seerr criteria can
    // never evaluate (Seerr has no music requests), so its matches are the
    // vacuous whole-library flood this PR's detection guard now refuses to
    // produce. Detection disarms such rule sets, but this executor can run
    // BEFORE the first post-upgrade detection cycle — cancel here too rather
    // than fire a pre-existing armed flood.
    if (
      action.ruleSet?.type === "MUSIC" &&
      hasSeerrRules(action.ruleSet.rules as unknown as LifecycleRuleGroup[])
    ) {
      await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
      logger.warn("Lifecycle", `Cancelled action ${action.id} — rule set "${action.ruleSet.name}" uses Seerr criteria on a music library, which can never evaluate (its matches are vacuous)`);
      continue;
    }

    // Delete actions for items excluded via LifecycleException
    if (exceptionSet.has(`${action.userId}:${action.mediaItemId}`)) {
      await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
      logger.info("Lifecycle", `Deleted action ${action.id} — "${formatMediaItemTitle(mediaItem)}" is excluded via lifecycle exception`);
      continue;
    }

    // Delete actions for items that are no longer a current match
    if (!matchSet.has(`${action.ruleSetId}:${action.mediaItemId}`)) {
      await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
      logger.info("Lifecycle", `Deleted stale action ${action.id} — "${target}" is no longer a match for rule set "${action.ruleSet?.name ?? action.ruleSetId}"`);
      continue;
    }

    // Identity-swap guard: the action recorded its item's identity (titles,
    // year, Arr external id) when it was scheduled; the joined mediaItem is
    // the CURRENT row. If they no longer denote the same work (e.g. a Plex
    // "Fix Match" / Jellyfin "Identify" rewrote this ratingKey's row to
    // different content with different external ids before detection removed
    // the now-stale match), the Arr resolution would target the NEW item —
    // which never matched. Refuse rather than act on it.
    //
    // Compared through matchIdentityChange, never title to title: a series or
    // artist action records its GROUP (title = the show or artist, parent
    // cleared) against a representative episode or track, whose own title is
    // the episode's or track's. A direct comparison read every one of them as
    // a Fix Match ("Breaking Bad" → "Pilot") and cancelled it when due, so no
    // scheduled series or artist action ever ran.
    const ruleSetType = (action.ruleSet?.type ?? action.ruleSetType) as LibraryType;
    const identityChange = matchIdentityChange(
      {
        title: action.mediaItemTitle,
        parentTitle: action.mediaItemParentTitle,
        year: action.mediaItemYear,
        externalIds: action.mediaItemExternalId
          ? [{ source: arrIdSourceFor(ruleSetType), externalId: action.mediaItemExternalId }]
          : [],
      },
      mediaItem,
      ruleSetType,
    );
    if (identityChange) {
      // The stored match describes the work that was there too, so it goes
      // with the action and the next detection evaluates the item as it is
      // now. Left in place, a sticky rule set would re-schedule from that old
      // snapshot every run and this check would cancel it every time it came
      // due — and a kept match's snapshot is otherwise never rewritten.
      await prisma.$transaction([
        prisma.lifecycleAction.deleteMany({ where: { id: action.id } }),
        prisma.ruleMatch.deleteMany({ where: { ruleSetId: action.ruleSetId!, mediaItemId: mediaItem.id } }),
      ]);
      logger.warn("Lifecycle", `Cancelled action ${action.id} — item identity changed since scheduling (${identityChange}); will re-evaluate on next detection`);
      continue;
    }

    // For grouped actions (series/music with episode-level tracking), filter out
    // any member IDs that were individually excepted since the action was scheduled
    let filteredMatchedIds = action.matchedMediaItemIds ?? [];
    if (filteredMatchedIds.length > 0) {
      // First, drop members the rule no longer matches (the current RuleMatch
      // member set is authoritative; a stale PENDING action may still carry
      // members that stopped matching). Only for member-scoped actions, where
      // the member list actually determines what is acted on — a whole-record
      // action (e.g. DELETE_SONARR) ignores the member list and deletes the
      // whole series regardless, so intersecting (and possibly cancelling on an
      // episode-id churn) would wrongly skip a series that still matches. Also
      // skip when the match doesn't track members — absence means "not
      // member-scoped", not "zero members".
      const currentMembers = actionHonorsMemberIds(action.actionType)
        ? currentMemberIds.get(`${action.ruleSetId}:${action.mediaItemId}`)
        : undefined;
      if (currentMembers) {
        const stillMatching = filteredMatchedIds.filter((mid) => currentMembers.has(mid));
        if (stillMatching.length === 0) {
          await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
          logger.info("Lifecycle", `Deleted action ${action.id} — none of the originally targeted members for "${target}" still match`);
          continue;
        }
        if (stillMatching.length < filteredMatchedIds.length) {
          logger.info("Lifecycle", `Dropped ${filteredMatchedIds.length - stillMatching.length} member(s) from action on "${target}" that no longer match`);
        }
        filteredMatchedIds = stillMatching;
      }

      const original = filteredMatchedIds;
      filteredMatchedIds = original.filter(
        (mid) => !exceptionSet.has(`${action.userId}:${mid}`)
      );
      if (filteredMatchedIds.length === 0) {
        // All targeted episodes/tracks are now excepted — cancel the action
        await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
        logger.info("Lifecycle", `Deleted action ${action.id} — all targeted episodes/tracks for "${target}" are excluded via lifecycle exceptions`);
        continue;
      }
      if (filteredMatchedIds.length < original.length) {
        // Exception inviolability: a whole-record destructive action (e.g.
        // DELETE_SONARR) ignores the member list and would destroy the
        // excepted member along with the rest. We cannot partially exclude
        // from a whole-record op, so refuse it entirely rather than delete a
        // protected item. Member-scoped file deletes honor the filtered set
        // below and are safe to proceed.
        if (isDestructiveActionType(action.actionType) && !actionHonorsMemberIds(action.actionType)) {
          await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
          logger.warn("Lifecycle", `Cancelled whole-record action ${action.id} on "${target}" — ${original.length - filteredMatchedIds.length} member(s) are excepted and a ${action.actionType} cannot exclude them`);
          continue;
        }
        logger.info("Lifecycle", `Filtered ${original.length - filteredMatchedIds.length} excepted episodes/tracks from action on "${target}"`);
      }
    }

    // Exception inviolability, part 2: the member check above only sees the
    // MATCHED episodes/tracks. A whole-record destructive action destroys the
    // entire series/artist — including siblings the rule never matched — so an
    // exception on ANY item of the same group must also refuse the action.
    // The group is `protectionKey` — `seriesKey` for a series, so an exception
    // filed under another server's title for the same show still counts.
    // (Protected groups are batch-resolved before the loop.)
    const groupKey = protectionKey(mediaItem);
    if (
      isWholeRecordDestructiveAction(action.actionType) &&
      groupKey &&
      protectedGroupsByUser.get(action.userId)?.has(groupKey)
    ) {
      await prisma.lifecycleAction.deleteMany({ where: { id: action.id } });
      logger.warn("Lifecycle", `Cancelled whole-record action ${action.id} on "${target}" — an episode/track of it is excluded via lifecycle exception and a ${action.actionType} cannot exclude it`);
      continue;
    }

    executable.push({ action, mediaItem, filteredMatchedIds });
  }

  // BLAST-RADIUS CEILING, counted over the pass-1 survivors.
  //
  // Grouped per user because the ceiling is a per-user setting and this executor
  // can run for all of them; one user's runaway rule set must not hold another's
  // legitimate run. Blocked actions stay PENDING and untouched, so the Pending
  // page's existing Execute button IS the manual approval — there is no separate
  // approval queue to build or to get out of sync.
  const blockedUserIds = new Set<string>();
  {
    const destructiveByUser = new Map<string, string[]>();
    for (const { action } of executable) {
      const list = destructiveByUser.get(action.userId) ?? [];
      list.push(action.actionType);
      destructiveByUser.set(action.userId, list);
    }
    for (const [uid, actionTypes] of destructiveByUser) {
      const verdict = await checkDeleteCeiling(uid, actionTypes);
      if (verdict.allowed) continue;
      blockedUserIds.add(uid);
      logger.warn(
        "Lifecycle",
        `Holding this run's destructive actions — ${verdict.reason} ` +
          `They remain pending and can be executed from the Pending page.`,
      );
      await notifyDeleteCeilingReached(uid, verdict).catch(() => {});
    }
  }

  // PUBLIC API LIMITS, for a run queued through an API key: the same budget
  // the execute endpoint charges (at most 25 items per request, 100 per hour
  // across every key), counted over what the ceiling left runnable. Refused
  // whole, like the ceiling — the actions stay pending for the schedule or the
  // Pending page — and nothing is charged. Without this, queueing a run would
  // be the way round the limits the execute endpoint enforces.
  // What this run charged, so pass 2 can give back what it never sends.
  let apiReservation: ApiDestructiveReservation | null = null;
  if (options.viaApiKey) {
    const destructive = executable.filter(
      ({ action }) => !blockedUserIds.has(action.userId) && isDestructiveActionType(action.actionType),
    );
    if (destructive.length > 0) {
      const reservation = reserveApiDestructive(destructive.length);
      if (reservation.ok) apiReservation = reservation;
      if (!reservation.ok) {
        const heldUsers = new Set(destructive.map(({ action }) => action.userId));
        for (const uid of heldUsers) blockedUserIds.add(uid);
        logger.warn(
          "Lifecycle",
          `Holding this run's destructive actions — it was queued through API key "${options.viaApiKey}": ` +
            `${reservation.error} They remain pending for the scheduled run or the Pending page.`,
        );
        if (Date.now() - lastApiHoldNoticeAt >= API_HOLD_NOTICE_INTERVAL_MS) {
          lastApiHoldNoticeAt = Date.now();
          for (const uid of heldUsers) {
            await notifyDeletionHeld(
              uid,
              `A lifecycle run queued through API key **${options.viaApiKey}** would have deleted ` +
                `**${destructive.length}** item(s), more than the API may.\n\n${reservation.error}\n\n` +
                `The actions are still pending: they run on the next scheduled execution, or from the Pending page.`,
            ).catch(() => {});
          }
        }
      }
    }
  }

  logger.info(
    "Lifecycle",
    `Executing ${executable.length} of ${pendingActions.length} pending action(s) ` +
      `(${currentMatches.length} current matches across ${ruleSetIds.length} rule sets)`,
  );

  // Pass 1 can narrow a member-scoped action down to one episode it was not
  // stored against, which then names it.
  const runningEpisodes = await loadMemberEpisodes(
    executable.map(({ action, mediaItem, filteredMatchedIds }) => ({ ...action, mediaItem, matchedMediaItemIds: filteredMatchedIds })),
  );

  // PASS 2 — execute what survived.
  // Arr instances that failed at the host level this run: their remaining
  // actions stay PENDING for the next run rather than each paying the client's
  // retry budget against a dead instance on the serial MAIN_QUEUE.
  const unreachable = new UnreachableInstances();
  const deferredByInstance = new Map<string, number>();
  for (const { action, mediaItem, filteredMatchedIds } of executable) {
    // Held by the ceiling: leave it PENDING and untouched so the Pending page
    // can execute it after review. Only destructive actions are held — an
    // unmonitor or a tag scheduled in the same run still applies.
    if (blockedUserIds.has(action.userId) && isDestructiveActionType(action.actionType)) {
      continue;
    }
    if (action.arrInstanceId && unreachable.get(action.arrInstanceId)) {
      deferredByInstance.set(action.arrInstanceId, (deferredByInstance.get(action.arrInstanceId) ?? 0) + 1);
      if (apiReservation && isDestructiveActionType(action.actionType)) apiReservation.release(1);
      continue;
    }

    // The run loaded its actions before pass 1, and pass 2 can run for many
    // minutes on a slow Arr app. Meanwhile the Pending page or the public API
    // can run the same match inline (`POST /api/lifecycle/actions/execute`,
    // which deletes this PENDING row when it finishes), the user can cancel
    // the action, file an exception (which disarms it) or edit the rule set
    // (which cancels it). Acting on the loaded copy anyway sent the delete a
    // second time — or sent one the user had just cancelled — and the write
    // below then threw P2025 on the vanished row from inside the catch,
    // aborting the run: every later action, the Discord summaries and the
    // post-delete re-sync were skipped. So the item is claimed in the same
    // registry the inline routes use (a manual Execute of it now answers 409,
    // and one already running makes this run leave it pending), and the row
    // is re-read under that claim.
    const lockScope = action.ruleSetId!;
    const lockItems = [mediaItem.id];
    if (!tryBeginExecute(lockScope, lockItems)) {
      logger.info("Lifecycle", `Left action ${action.id} pending — a manual execution of "${formatMediaItemTitle(mediaItem)}" is running for rule set "${action.ruleSet?.name ?? action.ruleSetId}"`);
      if (apiReservation && isDestructiveActionType(action.actionType)) apiReservation.release(1);
      continue;
    }
    try {
      const stillPending = await prisma.lifecycleAction.count({ where: { id: action.id, status: "PENDING" } });
      if (stillPending === 0) {
        logger.info("Lifecycle", `Skipped action ${action.id} — it was cancelled or executed elsewhere after this run started`);
        if (apiReservation && isDestructiveActionType(action.actionType)) apiReservation.release(1);
        continue;
      }
      await runAction(action, mediaItem, filteredMatchedIds);
    } finally {
      endExecute(lockScope, lockItems);
    }
  }

  async function runAction(
    action: (typeof executable)[number]["action"],
    mediaItem: (typeof executable)[number]["mediaItem"],
    filteredMatchedIds: string[],
  ): Promise<void> {
    // The action as it runs — with the members pass 1 left it — which is also
    // what its log line, notifications and history name (see `executedTitle`).
    const running = { ...action, matchedMediaItemIds: filteredMatchedIds, mediaItem, memberEpisodes: runningEpisodes };
    try {
      const outcome = await executeAction({ ...running, targetTitle: actionTargetTitle(running) });

      // Compute deleted bytes for stats tracking (only for delete actions)
      const deletedBytes = await computeDeletedBytes(action.actionType, mediaItem, filteredMatchedIds, outcome);

      // Mark the action complete and remove the match atomically so we never
      // leave a "completed but still matched" ghost on the Matches page if
      // one write succeeds and the other fails.
      const completed = {
        status: "COMPLETED" as const,
        executedAt: new Date(),
        deletedBytes,
        // What it acted on, not what was scheduled: pass 1 may have dropped
        // members that stopped matching or were excepted since.
        matchedMediaItemIds: filteredMatchedIds,
        ...actionTitleSnapshot(running),
      };
      // `updateMany`: the row can still vanish while the Arr call runs (the
      // user cancels it mid-flight). The action ran all the same, so its
      // history is recorded as a new row rather than lost — and never as a
      // P2025 that would abort the rest of the run.
      const [updated] = await prisma.$transaction([
        prisma.lifecycleAction.updateMany({ where: { id: action.id }, data: completed }),
        prisma.ruleMatch.deleteMany({
          where: { ruleSetId: action.ruleSetId!, mediaItemId: mediaItem.id },
        }),
      ]);
      if (updated.count === 0) {
        logger.warn("Lifecycle", `Action ${action.id} on "${executedTitle(running)}" ran, but was removed while it ran — recording its result as a new history entry`);
        await recordVanishedAction(action, completed);
      }

      logger.info("Lifecycle", `Executed ${action.actionType} for "${executedTitle(running)}" in rule set "${action.ruleSet?.name ?? action.ruleSetId}"`);

      // Queue a targeted library sync for destructive actions
      if (action.actionType.includes("DELETE") && mediaItem.library?.mediaServerId) {
        const { mediaServerId, key } = mediaItem.library;
        const syncKey = `${mediaServerId}:${key}`;
        if (!librariesToSync.has(syncKey)) {
          librariesToSync.set(syncKey, { serverId: mediaServerId, libraryKey: key });
        }
      }

      if (action.ruleSet?.discordNotifyOnAction) {
        const key = action.ruleSetId!;
        if (!successesByRuleSet.has(key)) {
          successesByRuleSet.set(key, {
            userId: action.ruleSet.userId,
            ruleSetName: action.ruleSet.name,
            actionType: action.actionType,
            titles: [],
          });
        }
        successesByRuleSet.get(key)!.titles.push(notificationTitle(running));
      }

    } catch (error) {
      unreachable.record(action.arrInstanceId, error);
      const msg = extractActionError(error);
      logger.error("Lifecycle", `Failed to execute action ${action.id}`, { error: describeActionError(error) });
      const failedWrite = await prisma.lifecycleAction.updateMany({
        where: { id: action.id },
        data: {
          status: "FAILED",
          error: msg,
          executedAt: new Date(),
          matchedMediaItemIds: filteredMatchedIds,
          ...actionTitleSnapshot(running),
        },
      });
      if (failedWrite.count === 0) {
        // Removed while it ran: cancelled, or acted on by a manual Execute —
        // whose own history row already says what happened, and whose delete
        // is the likely cause of this failure. Nothing to record or report.
        logger.warn("Lifecycle", `Action ${action.id} on "${executedTitle(running)}" failed after it was removed while running — not recording the failure`);
        return;
      }

      // Collect failure for batched Discord notification
      if (action.ruleSet?.discordNotifyOnAction) {
        const key = action.ruleSetId!;
        if (!failuresByRuleSet.has(key)) {
          failuresByRuleSet.set(key, {
            userId: action.ruleSet.userId,
            ruleSetName: action.ruleSet.name,
            actionType: action.actionType,
            discordNotify: true,
            failures: [],
          });
        }
        failuresByRuleSet.get(key)!.failures.push({
          title: notificationTitle(running),
          error: msg,
        });
      }

    }
  }

  for (const [instanceId, count] of deferredByInstance) {
    logger.warn(
      "Lifecycle",
      `Left ${count} action(s) pending for Arr instance ${instanceId} — it is not answering ` +
        `(${describeActionError(unreachable.get(instanceId))}); they run on the next execution`,
    );
  }

  // Batch-load Discord webhook settings for every user with notifications to send
  const notifyUserIds = new Set<string>([
    ...[...successesByRuleSet.values()].map((s) => s.userId),
    ...[...failuresByRuleSet.values()].map((f) => f.userId),
  ]);
  const settingsByUserId = new Map<string, { discordWebhookUrl: string | null; discordWebhookUsername: string | null; discordWebhookAvatarUrl: string | null }>();
  if (notifyUserIds.size > 0) {
    const allSettings = await prisma.appSettings.findMany({
      where: { userId: { in: [...notifyUserIds] } },
      select: { userId: true, discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
    });
    for (const s of allSettings) {
      settingsByUserId.set(s.userId, s);
    }
  }

  // Send batched success notifications to Discord
  for (const [, ruleSuccesses] of successesByRuleSet) {
    try {
      const settings = settingsByUserId.get(ruleSuccesses.userId);
      if (settings?.discordWebhookUrl) {
        await sendDiscordNotification(settings.discordWebhookUrl, {
          username: settings.discordWebhookUsername || "Librariarr",
          avatar_url: settings.discordWebhookAvatarUrl || undefined,
          embeds: [buildSuccessSummaryEmbed(ruleSuccesses.ruleSetName, ruleSuccesses.actionType, ruleSuccesses.titles)],
        });
      }
    } catch {
      // Don't let notification failures break lifecycle processing
    }
  }

  // Send batched failure notifications to Discord
  for (const [, ruleFailures] of failuresByRuleSet) {
    try {
      const settings = settingsByUserId.get(ruleFailures.userId);
      if (settings?.discordWebhookUrl) {
        await sendDiscordNotification(settings.discordWebhookUrl, {
          username: settings.discordWebhookUsername || "Librariarr",
          avatar_url: settings.discordWebhookAvatarUrl || undefined,
          embeds: [buildFailureSummaryEmbed(ruleFailures.ruleSetName, ruleFailures.actionType, ruleFailures.failures)],
        });
      }
    } catch {
      // Don't let notification failures break lifecycle processing
    }
  }

  // Trigger targeted library syncs for servers affected by destructive actions
  if (librariesToSync.size > 0) {
    logger.info("Lifecycle", `Triggering targeted sync for ${librariesToSync.size} affected ${librariesToSync.size === 1 ? "library" : "libraries"}`);
    for (const [, { serverId, libraryKey }] of librariesToSync) {
      try {
        await syncMediaServer(serverId, libraryKey, {
          trigger: "lifecycle execution: re-sync after destructive actions",
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

  // Notify connected clients that actions were executed
  if (pendingActions.length > 0) {
    const affectedUserIds = userId ? [userId] : [...new Set(pendingActions.map((a) => a.userId))];
    for (const uid of affectedUserIds) {
      eventBus.emit({ type: "lifecycle:action-executed", userId: uid });
    }
  }
}
