import { prisma } from "@/lib/db";
import { hasArrRules, hasSeerrRules, hasAnyActiveRules } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import { logger } from "@/lib/logger";
import { normalizeTitle, executeAction, extractActionError } from "@/lib/lifecycle/actions";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { syncAllCollections } from "@/lib/lifecycle/collections";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { sendDiscordNotification, buildSuccessSummaryEmbed, buildMatchChangeEmbed, buildFailureSummaryEmbed } from "@/lib/discord/client";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { eventBus } from "@/lib/events/event-bus";

function formatTitleWithYear(title: string, year: number | null): string {
  if (!year) return title;
  const suffix = `(${year})`;
  if (title.endsWith(suffix)) return title;
  return `${title} ${suffix}`;
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
  // - A PENDING action (prevents duplicates)
  // - A COMPLETED or FAILED non-delete action (prevents infinite loop —
  //   unmonitor/do-nothing items always still exist after execution)
  // Allow re-scheduling past completed DELETE actions: if the item still
  // matches after a "completed" deletion, the deletion likely failed
  // silently (e.g. Arr removed its record but the file remained on disk
  // due to permissions).
  const existingActions = await prisma.lifecycleAction.findMany({
    where: {
      ruleSetId: ruleSet.id,
      mediaItemId: { in: matchedItemIds },
      OR: [
        { status: "PENDING" },
        {
          status: { in: ["COMPLETED", "FAILED"] },
          actionType: { not: { contains: "DELETE" } },
        },
      ],
    },
    select: { mediaItemId: true },
  });
  const existingItemIds = new Set(existingActions.map((a) => a.mediaItemId));

  const newItems = matchedItems.filter((item) => !existingItemIds.has(item.id as string));

  if (newItems.length > 0) {
    const scheduledFor = new Date();
    scheduledFor.setDate(scheduledFor.getDate() + ruleSet.actionDelayDays);

    await prisma.lifecycleAction.createMany({
      data: newItems.map((item) => ({
        userId: ruleSet.userId,
        mediaItemId: item.id as string,
        mediaItemTitle: (item.title as string) ?? null,
        mediaItemParentTitle: (item.parentTitle as string | null) ?? null,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        ruleSetType: ruleSet.type,
        actionType: ruleSet.actionType!,
        addImportExclusion: ruleSet.addImportExclusion,
        searchAfterAction: ruleSet.searchAfterAction,
        matchedMediaItemIds: episodeIdMap.get(item.id as string) ?? [],
        addArrTags: ruleSet.addArrTags,
        removeArrTags: ruleSet.removeArrTags,
        scheduledFor,
        arrInstanceId: ruleSet.arrInstanceId,
        targetQualityProfileId: ruleSet.targetQualityProfileId,
      })),
      skipDuplicates: true,
    });

    for (const item of newItems) {
      logger.info("Lifecycle", `Scheduled ${ruleSet.actionType} for "${item.title}" on ${scheduledFor.toISOString()}`);
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

      let arrData: ArrDataMap | undefined;
      if (hasArrRules(rules)) {
        arrData = await fetchArrMetadata(ruleSet.userId, ruleSet.type);
      }

      let seerrData: SeerrDataMap | undefined;
      if (hasSeerrRules(rules) && ruleSet.type !== "MUSIC") {
        seerrData = await fetchSeerrMetadata(ruleSet.userId, ruleSet.type);
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
                  removedTitles = removedItems.map((item) =>
                    ruleSet.seriesScope && item.parentTitle ? item.parentTitle : item.title
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

export async function executeLifecycleActions(userId?: string) {
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

  logger.info("Lifecycle", `Processing ${pendingActions.length} pending actions (${currentMatches.length} current matches across ${ruleSetIds.length} rule sets)`);

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

  for (const action of pendingActions) {
    // Delete actions whose media item no longer exists
    if (!action.mediaItem || !action.mediaItemId) {
      await prisma.lifecycleAction.delete({ where: { id: action.id } });
      logger.info("Lifecycle", `Deleted action ${action.id} — media item no longer exists`);
      continue;
    }

    const mediaItem = action.mediaItem;

    // Delete actions for items excluded via LifecycleException
    if (exceptionSet.has(`${action.userId}:${action.mediaItemId}`)) {
      await prisma.lifecycleAction.delete({ where: { id: action.id } });
      logger.info("Lifecycle", `Deleted action ${action.id} — "${mediaItem.title}" is excluded via lifecycle exception`);
      continue;
    }

    // Delete actions for items that are no longer a current match
    if (!matchSet.has(`${action.ruleSetId}:${action.mediaItemId}`)) {
      await prisma.lifecycleAction.delete({ where: { id: action.id } });
      logger.info("Lifecycle", `Deleted stale action ${action.id} — "${mediaItem.title}" is no longer a match for rule set "${action.ruleSet?.name ?? action.ruleSetId}"`);
      continue;
    }

    // Identity-swap guard: the action's title was snapshotted at creation;
    // the joined mediaItem is the CURRENT row. If they no longer denote the
    // same work (e.g. a Plex "Fix Match" / Jellyfin "Identify" rewrote this
    // ratingKey's row to different content with different external ids before
    // detection removed the now-stale match), the Arr resolution would target
    // the NEW item — which never matched. Refuse rather than act on it.
    if (
      action.mediaItemTitle &&
      mediaItem.title &&
      normalizeTitle(action.mediaItemTitle) !== normalizeTitle(mediaItem.title)
    ) {
      await prisma.lifecycleAction.delete({ where: { id: action.id } });
      logger.warn("Lifecycle", `Cancelled action ${action.id} — item identity changed since scheduling ("${action.mediaItemTitle}" → "${mediaItem.title}"); will re-evaluate on next detection`);
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
          await prisma.lifecycleAction.delete({ where: { id: action.id } });
          logger.info("Lifecycle", `Deleted action ${action.id} — none of the originally targeted members for "${mediaItem.title}" still match`);
          continue;
        }
        if (stillMatching.length < filteredMatchedIds.length) {
          logger.info("Lifecycle", `Dropped ${filteredMatchedIds.length - stillMatching.length} member(s) from action on "${mediaItem.title}" that no longer match`);
        }
        filteredMatchedIds = stillMatching;
      }

      const original = filteredMatchedIds;
      filteredMatchedIds = original.filter(
        (mid) => !exceptionSet.has(`${action.userId}:${mid}`)
      );
      if (filteredMatchedIds.length === 0) {
        // All targeted episodes/tracks are now excepted — cancel the action
        await prisma.lifecycleAction.delete({ where: { id: action.id } });
        logger.info("Lifecycle", `Deleted action ${action.id} — all targeted episodes/tracks for "${mediaItem.title}" are excluded via lifecycle exceptions`);
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
          await prisma.lifecycleAction.delete({ where: { id: action.id } });
          logger.warn("Lifecycle", `Cancelled whole-record action ${action.id} on "${mediaItem.title}" — ${original.length - filteredMatchedIds.length} member(s) are excepted and a ${action.actionType} cannot exclude them`);
          continue;
        }
        logger.info("Lifecycle", `Filtered ${original.length - filteredMatchedIds.length} excepted episodes/tracks from action on "${mediaItem.title}"`);
      }
    }

    try {
      await executeAction({ ...action, matchedMediaItemIds: filteredMatchedIds, mediaItem });

      // Compute deleted bytes for stats tracking (only for delete actions)
      let deletedBytes: bigint | null = null;
      if (action.actionType.includes("DELETE")) {
        if (action.actionType === "DELETE_SONARR" && mediaItem.parentTitle) {
          // Whole-series delete removes EVERY episode of the series, so count the
          // whole series' file size — not just the matched members, which
          // under-counts when only a subset of episodes matched the rule.
          const agg = await prisma.mediaItem.aggregate({
            where: { type: "SERIES", parentTitle: mediaItem.parentTitle, libraryId: mediaItem.libraryId },
            _sum: { fileSize: true },
          });
          deletedBytes = agg._sum.fileSize ?? null;
        } else if (filteredMatchedIds.length > 0) {
          // Series/music with episode-level tracking — sum member items' file sizes
          const memberSizes = await prisma.mediaItem.findMany({
            where: { id: { in: filteredMatchedIds } },
            select: { fileSize: true },
          });
          const total = memberSizes.reduce((sum, m) => sum + (m.fileSize ?? BigInt(0)), BigInt(0));
          if (total > BigInt(0)) deletedBytes = total;
        } else if (mediaItem.fileSize) {
          deletedBytes = mediaItem.fileSize;
        }
      }

      // Mark the action complete and remove the match atomically so we never
      // leave a "completed but still matched" ghost on the Matches page if
      // one write succeeds and the other fails.
      await prisma.$transaction([
        prisma.lifecycleAction.update({
          where: { id: action.id },
          data: {
            status: "COMPLETED",
            executedAt: new Date(),
            deletedBytes,
            mediaItemTitle: mediaItem.title,
            mediaItemParentTitle: mediaItem.parentTitle,
          },
        }),
        prisma.ruleMatch.deleteMany({
          where: { ruleSetId: action.ruleSetId!, mediaItemId: action.mediaItemId },
        }),
      ]);

      logger.info("Lifecycle", `Executed ${action.actionType} for "${mediaItem.parentTitle ?? mediaItem.title}" in rule set "${action.ruleSet?.name ?? action.ruleSetId}"`);

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
        const displayTitle = mediaItem.parentTitle ?? mediaItem.title;
        const titleWithYear = formatTitleWithYear(displayTitle, mediaItem.year);
        successesByRuleSet.get(key)!.titles.push(titleWithYear);
      }

    } catch (error) {
      const msg = extractActionError(error);
      logger.error("Lifecycle", `Failed to execute action ${action.id}`, { error: msg });
      await prisma.lifecycleAction.update({
        where: { id: action.id },
        data: {
          status: "FAILED",
          error: msg,
          executedAt: new Date(),
          mediaItemTitle: mediaItem.title,
          mediaItemParentTitle: mediaItem.parentTitle,
        },
      });

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
        const displayTitle = mediaItem.parentTitle ?? mediaItem.title;
        failuresByRuleSet.get(key)!.failures.push({
          title: formatTitleWithYear(displayTitle, mediaItem.year),
          error: msg,
        });
      }

    }
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
        await syncMediaServer(serverId, libraryKey);
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
