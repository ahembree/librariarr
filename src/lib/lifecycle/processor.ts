import { prisma } from "@/lib/db";
import { hasArrRules, hasSeerrRules, hasAnyActiveRules } from "@/lib/rules/engine";
import type { ArrDataMap, SeerrDataMap } from "@/lib/rules/engine";
import { logger } from "@/lib/logger";
import { executeAction, extractActionError } from "@/lib/lifecycle/actions";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { syncPlexCollection, removePlexCollection } from "@/lib/lifecycle/collections";
import { syncMediaServer } from "@/lib/sync/sync-server";
import { sendDiscordNotification, buildSuccessSummaryEmbed, buildMatchChangeEmbed, buildFailureSummaryEmbed } from "@/lib/discord/client";
import type { Rule, RuleGroup } from "@/lib/rules/types";
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
  addImportExclusion: boolean;
  searchAfterDelete: boolean;
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
  // If actions are disabled, delete all pending actions and return early
  if (!ruleSet.actionEnabled) {
    const deleted = await prisma.lifecycleAction.deleteMany({
      where: { ruleSetId: ruleSet.id, status: "PENDING" },
    });
    if (deleted.count > 0) {
      logger.info("Lifecycle", `Deleted ${deleted.count} pending actions for rule set "${ruleSet.name}" (actions disabled)`);
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

  // Create lifecycle actions (only when actionEnabled)
  if (ruleSet.actionEnabled) {
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

    // Skip items that already have a PENDING, COMPLETED, or FAILED action.
    const existingActions = await prisma.lifecycleAction.findMany({
      where: {
        ruleSetId: ruleSet.id,
        status: { in: ["PENDING", "COMPLETED", "FAILED"] },
        mediaItemId: { in: matchedItemIds },
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
          searchAfterDelete: ruleSet.searchAfterDelete,
          matchedMediaItemIds: episodeIdMap.get(item.id as string) ?? [],
          addArrTags: ruleSet.addArrTags,
          removeArrTags: ruleSet.removeArrTags,
          scheduledFor,
          arrInstanceId: ruleSet.arrInstanceId,
        })),
        skipDuplicates: true,
      });

      for (const item of newItems) {
        logger.info("Lifecycle", `Scheduled ${ruleSet.actionType} for "${item.title}" on ${scheduledFor.toISOString()}`);
      }
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

      const rules = ruleSet.rules as unknown as Rule[] | RuleGroup[];

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
      const { items: matchedItems, episodeIdMap, currentItems } = await detectAndSaveMatches(
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
          collectionEnabled: ruleSet.collectionEnabled,
          collectionName: ruleSet.collectionName,
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

      // Sync Plex collection (only when collectionEnabled)
      if (ruleSet.collectionEnabled && ruleSet.collectionName) {
        try {
          await syncPlexCollection(ruleSet, currentItems as Array<{ libraryId: string; ratingKey: string; title: string; parentTitle: string | null }>, plexItemsCache);
        } catch (error) {
          logger.error("Lifecycle", `Collection sync failed for "${ruleSet.name}"`, { error: String(error) });
        }
      }
    } catch (error) {
      logger.error("Lifecycle", `Error processing rule set "${ruleSet.name}"`, { error: String(error) });
    }
  }

  // Clean up Plex collections for rule sets where collection sync is disabled
  // but a collection name is still configured (meaning it was previously synced)
  const disabledCollectionRuleSets = await prisma.ruleSet.findMany({
    where: {
      collectionEnabled: false,
      collectionName: { not: null },
      ...(userId ? { userId } : {}),
    },
    select: { id: true, userId: true, type: true, collectionName: true },
  });

  for (const rs of disabledCollectionRuleSets) {
    if (!rs.collectionName) continue;
    try {
      await removePlexCollection(rs.userId, rs.type, rs.collectionName);
      // Clear the collection name so we don't try to remove it again
      await prisma.ruleSet.update({
        where: { id: rs.id },
        data: { collectionName: null },
      });
    } catch (error) {
      logger.error("Lifecycle", `Failed to remove collection for rule set ${rs.id}`, { error: String(error) });
    }
  }

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
    select: { ruleSetId: true, mediaItemId: true },
  });
  const matchSet = new Set(currentMatches.map((m) => `${m.ruleSetId}:${m.mediaItemId}`));

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

    // For grouped actions (series/music with episode-level tracking), filter out
    // any member IDs that were individually excepted since the action was scheduled
    let filteredMatchedIds = action.matchedMediaItemIds ?? [];
    if (filteredMatchedIds.length > 0) {
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
        logger.info("Lifecycle", `Filtered ${original.length - filteredMatchedIds.length} excepted episodes/tracks from action on "${mediaItem.title}"`);
      }
    }

    try {
      await executeAction({ ...action, matchedMediaItemIds: filteredMatchedIds, mediaItem });

      await prisma.lifecycleAction.update({
        where: { id: action.id },
        data: {
          status: "COMPLETED",
          executedAt: new Date(),
          // Snapshot title so the record survives media item deletion
          mediaItemTitle: mediaItem.title,
          mediaItemParentTitle: mediaItem.parentTitle,
        },
      });

      logger.info("Lifecycle", `Executed ${action.actionType} for "${mediaItem.parentTitle ?? mediaItem.title}" in rule set "${action.ruleSet?.name ?? action.ruleSetId}"`);

      // Remove the match so completed items don't linger on the matches page
      await prisma.ruleMatch.deleteMany({
        where: { ruleSetId: action.ruleSetId!, mediaItemId: action.mediaItemId },
      });

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

  // Send batched success notifications to Discord
  for (const [, ruleSuccesses] of successesByRuleSet) {
    try {
      const settings = await prisma.appSettings.findUnique({
        where: { userId: ruleSuccesses.userId },
        select: { discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
      });
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
      const settings = await prisma.appSettings.findUnique({
        where: { userId: ruleFailures.userId },
        select: { discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
      });
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
