import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeAction, extractActionError } from "@/lib/lifecycle/actions";

/**
 * Action configuration shared by rule-based and ad-hoc (query page) execution.
 * Mirrors the relevant fields of a RuleSet / LifecycleAction.
 */
export interface ActionConfig {
  actionType: string;
  arrInstanceId: string | null;
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  addArrTags: string[];
  removeArrTags: string[];
}

/**
 * Where the resulting LifecycleAction history rows are attributed.
 * For rule-based execution this points at the originating rule set; for ad-hoc
 * query-page actions ruleSetId is null and ruleSetName is a synthetic label.
 */
export interface HistoryContext {
  ruleSetId: string | null;
  ruleSetName: string | null;
  ruleSetType: string | null;
  /**
   * When true (rule-based path) the COMPLETED transaction also removes the
   * RuleMatch and any PENDING LifecycleAction rows for the item, keeping the
   * matches/pending views in sync. Ad-hoc execution leaves those untouched.
   */
  cleanupMatches?: boolean;
}

/** The subset of a MediaItem the executor and history writer need. */
export interface ActionItem {
  id: string;
  title: string;
  parentTitle: string | null;
  year: number | null;
  fileSize: bigint | null;
  externalIds: { source: string; externalId: string }[];
}

export interface RunActionsResult {
  executed: number;
  failed: number;
  errors: string[];
  failures: { title: string; error: string }[];
}

/** Live progress for a bounded action run, suitable for a streaming UI. */
export interface ActionRunProgress {
  /** Items fully processed so far (success or failure). */
  done: number;
  /** Total items in this run. */
  total: number;
  /**
   * The item currently being processed (1-based position = `done + 1`) and the
   * sub-step within it, present only while an item is mid-flight. Absent on the
   * boundary updates fired before the first item and after each completes.
   */
  current?: { title: string; step: string };
}

/**
 * Execute a lifecycle action on a bounded set of already-validated media items.
 *
 * Shared by:
 *  - POST /api/lifecycle/actions/execute (rule-based, cleanupMatches=true)
 *  - POST /api/query/actions             (ad-hoc query page, cleanupMatches=false)
 *
 * Callers are responsible for ownership verification, match/exception filtering,
 * and resolving `episodeIdMap` (series episode-level member IDs) BEFORE calling.
 *
 * `onProgress` (optional) drives a determinate progress bar: it fires once
 * before the first item, then for each item with the live sub-step (`current`),
 * and again after each item completes — so a streaming route can show both an
 * overall fraction and a per-item count plus the step in flight.
 */
export async function executeActionsForItems(
  userId: string,
  items: ActionItem[],
  config: ActionConfig,
  episodeIdMap: Map<string, string[]>,
  history: HistoryContext,
  onProgress?: (progress: ActionRunProgress) => void,
): Promise<RunActionsResult> {
  const actionType = config.actionType;

  // SAFETY: log the bounded execution count before any destructive operation.
  logger.info(
    "Lifecycle",
    `Executing ${actionType} on ${items.length} items (${history.ruleSetId ? `rule set "${history.ruleSetId}"` : "ad-hoc query action"})`,
  );

  let executed = 0;
  let failed = 0;
  const errors: string[] = [];
  const failures: { title: string; error: string }[] = [];

  const total = items.length;
  let processed = 0;
  onProgress?.({ done: 0, total });

  for (const item of items) {
    const matchedMediaItemIds = episodeIdMap.get(item.id) ?? [];
    // Surface the live sub-step for this item (tags → main action) to the bar.
    const reportStep = onProgress
      ? (step: string) => onProgress({ done: processed, total, current: { title: item.title, step } })
      : undefined;
    reportStep?.("Starting");
    try {
      await executeAction({
        id: "immediate",
        actionType,
        arrInstanceId: config.arrInstanceId,
        targetQualityProfileId: config.targetQualityProfileId,
        addImportExclusion: config.addImportExclusion,
        searchAfterAction: config.searchAfterAction,
        matchedMediaItemIds,
        addArrTags: config.addArrTags,
        removeArrTags: config.removeArrTags,
        mediaItem: item,
      }, reportStep);

      // Compute deleted bytes for stats tracking (only for delete actions)
      let deletedBytes: bigint | null = null;
      if (actionType.includes("DELETE")) {
        if (matchedMediaItemIds.length > 0) {
          const memberSizes = await prisma.mediaItem.findMany({
            where: { id: { in: matchedMediaItemIds } },
            select: { fileSize: true },
          });
          const total = memberSizes.reduce((sum, m) => sum + (m.fileSize ?? BigInt(0)), BigInt(0));
          if (total > BigInt(0)) deletedBytes = total;
        } else if (item.fileSize) {
          deletedBytes = item.fileSize;
        }
      }

      // Atomically swap the PENDING/match records for the COMPLETED record so an
      // interrupted process can't lose the audit trail. Match/pending cleanup
      // only applies to rule-based execution.
      const ops = [];
      if (history.cleanupMatches && history.ruleSetId) {
        ops.push(
          prisma.lifecycleAction.deleteMany({
            where: { ruleSetId: history.ruleSetId, mediaItemId: item.id, status: "PENDING" },
          }),
          prisma.ruleMatch.deleteMany({
            where: { ruleSetId: history.ruleSetId, mediaItemId: item.id },
          }),
        );
      }
      ops.push(
        prisma.lifecycleAction.create({
          data: {
            userId,
            mediaItemId: item.id,
            mediaItemTitle: item.title,
            mediaItemParentTitle: item.parentTitle,
            ruleSetId: history.ruleSetId,
            ruleSetName: history.ruleSetName,
            ruleSetType: history.ruleSetType,
            actionType,
            addImportExclusion: config.addImportExclusion,
            searchAfterAction: config.searchAfterAction,
            matchedMediaItemIds,
            addArrTags: config.addArrTags,
            removeArrTags: config.removeArrTags,
            scheduledFor: new Date(),
            executedAt: new Date(),
            status: "COMPLETED",
            deletedBytes,
            arrInstanceId: config.arrInstanceId,
            targetQualityProfileId: config.targetQualityProfileId,
          },
        }),
      );
      await prisma.$transaction(ops);

      executed++;
    } catch (error) {
      const msg = extractActionError(error);
      errors.push(`${item.title}: ${msg}`);
      failures.push({ title: item.title, error: msg });
      logger.error("Lifecycle", `Failed immediate ${actionType} for "${item.title}"`, { error: msg });

      await prisma.lifecycleAction.create({
        data: {
          userId,
          mediaItemId: item.id,
          mediaItemTitle: item.title,
          mediaItemParentTitle: item.parentTitle,
          ruleSetId: history.ruleSetId,
          ruleSetName: history.ruleSetName,
          ruleSetType: history.ruleSetType,
          actionType,
          addImportExclusion: config.addImportExclusion,
          searchAfterAction: config.searchAfterAction,
          matchedMediaItemIds,
          addArrTags: config.addArrTags,
          removeArrTags: config.removeArrTags,
          scheduledFor: new Date(),
          executedAt: new Date(),
          status: "FAILED",
          error: msg,
          arrInstanceId: config.arrInstanceId,
          targetQualityProfileId: config.targetQualityProfileId,
        },
      });
      failed++;
    } finally {
      processed++;
      onProgress?.({ done: processed, total });
    }
  }

  return { executed, failed, errors, failures };
}
