import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ArrExecutionContext, executeAction, extractActionError, describeActionError } from "@/lib/lifecycle/actions";
import { UnreachableInstances } from "@/lib/lifecycle/unreachable-instances";
import { actionTargetTitle, actionTitleSnapshot } from "@/lib/lifecycle/action-target";
import { loadMemberEpisodes } from "@/lib/lifecycle/member-episodes";
import { computeDeletedBytes } from "@/lib/lifecycle/deleted-bytes";
import { invalidateArrMetadataCache } from "@/lib/lifecycle/fetch-arr-metadata";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Action configuration shared by rule-based and ad-hoc (query page) execution.
 * Mirrors the relevant fields of a RuleSet / LifecycleAction.
 */
interface ActionConfig {
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
interface HistoryContext {
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
interface ActionItem {
  id: string;
  title: string;
  parentTitle: string | null;
  year: number | null;
  fileSize: bigint | null;
  libraryId: string;
  seriesKey?: string | null;
  // What names the item in progress, errors and logs (see `actionTargetTitle`):
  // a SERIES row is an episode, named by its show and SxxExx, never its own title.
  type: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  externalIds: { source: string; externalId: string }[];
}

interface RunActionsResult {
  executed: number;
  failed: number;
  errors: string[];
  failures: { title: string; error: string }[];
  /**
   * Of `failed`, the items failed without contacting the Arr app at all — its
   * instance had already failed at the host level this run — so nothing was
   * sent for them. The public API gives these back to its destructive budget.
   */
  notAttempted: number;
}

/** Live progress for a bounded action run, suitable for a streaming UI. */
interface ActionRunProgress {
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
 * Write a history row, keeping it when one of its links no longer resolves.
 * A sync can purge the item's row (or the rule set can be deleted) while its
 * Arr call runs; both links are SET NULL on delete, so a create naming a gone
 * one fails its foreign key — and that used to throw out of the loop, leaving
 * the action that DID run without history and the remaining items unprocessed.
 * Mirrors the scheduled executor's `recordVanishedAction`.
 */
async function recordHistory(data: Prisma.LifecycleActionUncheckedCreateInput): Promise<void> {
  try {
    await prisma.lifecycleAction.create({ data });
  } catch {
    try {
      await prisma.lifecycleAction.create({ data: { ...data, mediaItemId: null, ruleSetId: null } });
    } catch (error) {
      logger.error("Lifecycle", `Could not record the result of ${data.actionType} on item ${data.mediaItemId}`, { error: String(error) });
    }
  }
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
  let notAttempted = 0;
  const errors: string[] = [];
  const failures: { title: string; error: string }[] = [];

  const total = items.length;
  let processed = 0;
  onProgress?.({ done: 0, total });
  // Once the Arr instance fails at the host level, the remaining items fail
  // with that same error instead of each paying the retry budget again.
  const unreachable = new UnreachableInstances();
  // The instance's tag list, read once for the run rather than per item.
  const arrContext = new ArrExecutionContext();
  // An item acted on through exactly one OTHER episode is named after it.
  const memberEpisodes = await loadMemberEpisodes(
    items.map((item) => ({ actionType, matchedMediaItemIds: episodeIdMap.get(item.id), mediaItem: item })),
  );

  for (const item of items) {
    const matchedMediaItemIds = episodeIdMap.get(item.id) ?? [];
    const target = { actionType, matchedMediaItemIds, mediaItem: item, memberEpisodes };
    const title = actionTargetTitle(target);
    // Surface the live sub-step for this item (tags → main action) to the bar.
    const reportStep = onProgress
      ? (step: string) => onProgress({ done: processed, total, current: { title, step } })
      : undefined;
    reportStep?.("Starting");
    try {
      const hostDown = unreachable.get(config.arrInstanceId);
      if (hostDown) {
        notAttempted++;
        throw hostDown;
      }
      const outcome = await executeAction({
        id: "immediate",
        actionType,
        arrInstanceId: config.arrInstanceId,
        targetQualityProfileId: config.targetQualityProfileId,
        addImportExclusion: config.addImportExclusion,
        searchAfterAction: config.searchAfterAction,
        matchedMediaItemIds,
        addArrTags: config.addArrTags,
        removeArrTags: config.removeArrTags,
        targetTitle: title,
        mediaItem: item,
      }, reportStep, arrContext);

      // Compute deleted bytes for stats tracking (only for delete actions)
      const deletedBytes = await computeDeletedBytes(actionType, item, matchedMediaItemIds, outcome);

      // Atomically swap the PENDING/match records for the COMPLETED record so an
      // interrupted process can't lose the audit trail. Match/pending cleanup
      // only applies to rule-based execution.
      const completed: Prisma.LifecycleActionUncheckedCreateInput = {
        userId,
        mediaItemId: item.id,
        ...actionTitleSnapshot(target),
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
      };
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
      ops.push(prisma.lifecycleAction.create({ data: completed }));
      try {
        await prisma.$transaction(ops);
      } catch {
        // The item's row went while the Arr call ran (its matches cascaded with
        // it) — the action still ran, so it is recorded, never reported FAILED.
        await recordHistory(completed);
      }

      executed++;
    } catch (error) {
      unreachable.record(config.arrInstanceId, error);
      const msg = extractActionError(error);
      errors.push(`${title}: ${msg}`);
      failures.push({ title, error: msg });
      logger.error("Lifecycle", `Failed immediate ${actionType} for "${title}"`, { error: describeActionError(error) });

      await recordHistory({
        userId,
        mediaItemId: item.id,
        ...actionTitleSnapshot(target),
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
      });
      failed++;
    } finally {
      processed++;
      onProgress?.({ done: processed, total });
    }
  }

  // The run changed records in the Arr app (tags, monitoring, profiles, the
  // records themselves); a preview must not explain matches from before it.
  if (executed > 0 || failed > notAttempted) invalidateArrMetadataCache();

  return { executed, failed, errors, failures, notAttempted };
}
