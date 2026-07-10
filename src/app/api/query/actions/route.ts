import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeQuery } from "@/lib/query/query-engine";
import { appCache } from "@/lib/cache/memory-cache";
import { executeActionsForItems } from "@/lib/lifecycle/run-actions";
import { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES, actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { findExceptionProtectedParents } from "@/lib/lifecycle/exception-guard";
import { validateRequest, queryActionSchema } from "@/lib/validation";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { ProgressPhase, ProgressEmit } from "@/lib/progress/types";
import type { QueryDefinition } from "@/lib/query/types";

type MediaType = "MOVIE" | "SERIES" | "MUSIC";

// Streaming, potentially long-running (safety re-query + per-item Arr calls).
// Force dynamic and cap the duration so a request can't pin a function forever.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VALID_ACTION_TYPES = new Set(
  [...MOVIE_ACTION_TYPES, ...SERIES_ACTION_TYPES, ...MUSIC_ACTION_TYPES].map((a) => a.value),
);

/** Derive the target media type from an action type's Arr-family suffix. */
function familyFromActionType(actionType: string): MediaType | null {
  if (actionType.endsWith("RADARR")) return "MOVIE";
  if (actionType.endsWith("SONARR")) return "SERIES";
  if (actionType.endsWith("LIDARR")) return "MUSIC";
  return null; // DO_NOTHING
}

/** Confirm an Arr instance belongs to the user and matches the expected media type. */
async function arrInstanceMatchesType(
  arrInstanceId: string,
  userId: string,
  type: MediaType,
): Promise<boolean> {
  if (type === "MOVIE") {
    return !!(await prisma.radarrInstance.findFirst({ where: { id: arrInstanceId, userId }, select: { id: true } }));
  }
  if (type === "SERIES") {
    return !!(await prisma.sonarrInstance.findFirst({ where: { id: arrInstanceId, userId }, select: { id: true } }));
  }
  return !!(await prisma.lidarrInstance.findFirst({ where: { id: arrInstanceId, userId }, select: { id: true } }));
}

/** Find which Arr family an instance belongs to (for DO_NOTHING tag-only ops). */
async function typeForArrInstance(arrInstanceId: string, userId: string): Promise<MediaType | null> {
  if (await arrInstanceMatchesType(arrInstanceId, userId, "MOVIE")) return "MOVIE";
  if (await arrInstanceMatchesType(arrInstanceId, userId, "SERIES")) return "SERIES";
  if (await arrInstanceMatchesType(arrInstanceId, userId, "MUSIC")) return "MUSIC";
  return null;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.userId!;

  const { data, error } = await validateRequest(request, queryActionSchema);
  if (error) return error;

  const {
    query,
    mediaItemIds,
    runId,
    actionType,
    arrInstanceId,
    targetQualityProfileId,
    addImportExclusion,
    searchAfterAction,
    addArrTags,
    removeArrTags,
  } = data;

  if (!VALID_ACTION_TYPES.has(actionType)) {
    return NextResponse.json({ error: "Unknown action type" }, { status: 400 });
  }

  const hasTagOps = addArrTags.length > 0 || removeArrTags.length > 0;

  if (actionType === "DO_NOTHING" && !hasTagOps) {
    return NextResponse.json({ error: "No action configured" }, { status: 400 });
  }

  // Arr instance is needed unless this is a pure DO_NOTHING with no tag operations.
  const needsArrInstance = actionType !== "DO_NOTHING" || hasTagOps;
  if (needsArrInstance && !arrInstanceId) {
    return NextResponse.json({ error: "An Arr instance is required for this action" }, { status: 400 });
  }

  if (actionType.startsWith("CHANGE_QUALITY_PROFILE_") && targetQualityProfileId == null) {
    return NextResponse.json({ error: "A target quality profile is required" }, { status: 400 });
  }

  // Determine which media type this action applies to, and validate the Arr
  // instance belongs to the user and the correct family.
  let targetType = familyFromActionType(actionType);
  if (targetType) {
    if (arrInstanceId && !(await arrInstanceMatchesType(arrInstanceId, userId, targetType))) {
      return NextResponse.json({ error: "Arr instance not found for this action type" }, { status: 404 });
    }
  } else if (arrInstanceId) {
    // DO_NOTHING with tag ops: infer the family from the instance.
    targetType = await typeForArrInstance(arrInstanceId, userId);
    if (!targetType) {
      return NextResponse.json({ error: "Arr instance not found" }, { status: 404 });
    }
  } else {
    return NextResponse.json({ error: "No action configured" }, { status: 400 });
  }
  const resolvedType: MediaType = targetType;

  // Stream phase-by-phase progress, then the final result, as NDJSON so the
  // query page can render a live progress bar (re-validating the selection, then
  // running the action item-by-item) instead of a bare spinner. A client
  // disconnect aborts the stream/connection, but the in-flight action run is
  // intentionally allowed to finish so a disconnect can't leave a half-applied
  // destructive batch.
  return progressStreamResponse(
    async (emit) => {
      const phases: ProgressPhase[] = [
        { key: "validate", label: "Validating selection" },
        { key: "execute", label: "Running action" },
        { key: "finalize", label: "Finalizing" },
      ];
      emit({ type: "plan", phases });

      // The "validate" phase re-runs the query (the deletion-safety check that the
      // selection still matches), resolves series episode members, drops excepted
      // items, and loads the rows to act on. Narrate each step as a sub-status —
      // and forward the re-query's own phase labels — so a slow re-check on a large
      // library shows what it's doing instead of a bare "Validating selection".
      const validateStep = (text: string) =>
        emit({ type: "phase", key: "validate", detail: text });
      // Adapts an executeQuery progress stream into the validate sub-status: maps
      // each phase key to its announced label and appends a percentage when the
      // phase reports determinate sub-progress (e.g. "Evaluating rules (47%)").
      const forwardReQuery = (prefix: string): ProgressEmit => {
        const labels = new Map<string, string>();
        return (u) => {
          if (u.type === "plan") {
            for (const p of u.phases) labels.set(p.key, p.label);
            return;
          }
          const label = labels.get(u.key) ?? u.key;
          const pct = u.fraction !== undefined ? ` (${Math.round(u.fraction * 100)}%)` : "";
          validateStep(`${prefix} — ${label}${pct}`);
        };
      };

      // Multi-batch runs (a >1000 selection chunked client-side) call this route
      // once per batch, each otherwise re-running the whole-library safety query
      // AND re-fetching all Arr/Seerr metadata (the slow part). The live match set
      // is constant across a run — the check reads local MediaItem rows, which
      // don't change mid-run (the same reason a later batch still sees an earlier
      // batch's deleted items) — so memoize it per client `runId` and reuse it
      // across batches. Keyed by run id (unique per run) so there's no cross-run
      // staleness; without a run id (a single request) it just computes.
      type LiveItem = { id: string; type: string; parentTitle: string | null; title: string | null };
      const RUN_LIVE_TTL_MS = 10 * 60 * 1000;
      const toLiveItems = (items: Array<Record<string, unknown>>): LiveItem[] =>
        items.map((it) => ({
          id: String(it.id),
          type: String(it.type),
          parentTitle: (it.parentTitle ?? null) as string | null,
          title: (it.title ?? null) as string | null,
        }));
      const liveMatch = (variant: string, compute: () => Promise<LiveItem[]>): Promise<LiveItem[]> =>
        runId
          ? appCache.getOrSet(`query-action-live:${userId}:${runId}:${variant}`, compute, RUN_LIVE_TTL_MS)
          : compute();

      // SAFETY: re-run the query and only act on items that are still in the live
      // result set AND of the action's media type. This is the ad-hoc analog of
      // the RuleMatch validation used by rule-based execution.
      validateStep("Re-checking your selection");
      const liveOfType = await liveMatch("main", async () => {
        const liveResult = await executeQuery(
          query as QueryDefinition, userId, 1, 0, forwardReQuery("Re-checking your selection"),
        );
        return toLiveItems(liveResult.items.filter((it) => it.type === resolvedType));
      });
      const liveIds = new Set(liveOfType.map((it) => it.id));

      const validIds = mediaItemIds.filter((id) => liveIds.has(id));
      let skipped = mediaItemIds.length - validIds.length;

      if (validIds.length === 0) {
        logger.info("Lifecycle", `Ad-hoc query action ${actionType}: no selected items match the live query of type ${resolvedType}`);
        return { executed: 0, failed: 0, skipped, errors: [] };
      }

      // Whole-record series actions (DELETE_SONARR, UNMONITOR_SONARR, …) hit the
      // ENTIRE series and ignore the member list; member-scoped actions
      // (DELETE_FILES_SONARR, …) act only on the named episodes.
      const isMemberScoped = actionHonorsMemberIds(actionType);
      const isWholeRecordDestructive = isDestructiveActionType(actionType) && !isMemberScoped;

      // Group by the SAME key the query engine uses for grouped shows
      // (LOWER(TRIM(parentTitle))). Using a looser key (e.g. normalizeTitle)
      // would collapse distinct shows like "The Office (US)" / "The Office (UK)"
      // and act on the wrong episodes.
      const showKey = (s: unknown) => String(s ?? "").trim().toLowerCase();

      // Resolve SERIES episode-level member IDs and the units the action runs on.
      const episodeIdMap = new Map<string, string[]>();
      // The ids the action actually executes against. Defaults to the validated
      // selection; the episode-view whole-record case below collapses it to one
      // representative per show.
      let actionUnitIds: string[] = validIds;
      if (resolvedType === "SERIES") {
        if (query.includeEpisodes) {
          if (isMemberScoped) {
            // Results are already individual episodes — act on each on its own.
            for (const id of validIds) episodeIdMap.set(id, [id]);
          } else {
            // Whole-record series action on individual episodes: collapse the
            // selected episodes to ONE action per series (otherwise the whole-
            // series op runs once per selected episode → spurious "series not
            // found" failures + per-episode deletedBytes).
            //
            // The member set is ALL matched episodes of the show (from the live
            // set), NOT just the selected ones. A whole-record delete destroys
            // the entire series, so the exception guard below must see an
            // excepted episode of the show even when the user didn't select it —
            // otherwise it would silently destroy protected content. This
            // mirrors the grouped path and the scheduler (processor.ts).
            const matchedByShow = new Map<string, string[]>();
            for (const it of liveOfType) {
              const key = showKey(it.parentTitle ?? it.title);
              const arr = matchedByShow.get(key) ?? [];
              arr.push(it.id);
              matchedByShow.set(key, arr);
            }
            const seenShows = new Set<string>();
            actionUnitIds = [];
            for (const id of validIds) {
              const item = liveOfType.find((it) => String(it.id) === id);
              const key = showKey(item?.parentTitle ?? item?.title);
              if (seenShows.has(key)) continue; // one representative per show
              seenShows.add(key);
              actionUnitIds.push(id);
              episodeIdMap.set(id, matchedByShow.get(key) ?? [id]);
            }
          }
        } else {
          // Grouped by show: re-run at episode level and map each selected show's
          // representative episode id to all matched episode ids of that show.
          validateStep("Resolving matched episodes");
          const episodeItems = await liveMatch("episodes", async () => {
            const episodeResult = await executeQuery(
              { ...(query as QueryDefinition), includeEpisodes: true },
              userId,
              1,
              0,
              forwardReQuery("Resolving matched episodes"),
            );
            return toLiveItems(
              episodeResult.items.filter((it) => it.type === "SERIES" && it.parentTitle != null),
            );
          });
          const groups = new Map<string, string[]>();
          for (const ep of episodeItems) {
            const key = showKey(ep.parentTitle);
            const arr = groups.get(key) ?? [];
            arr.push(ep.id);
            groups.set(key, arr);
          }
          for (const id of validIds) {
            // For grouped shows the representative row carries the show name in
            // `title` (MIN(parentTitle)); episodes carry it in `parentTitle`.
            const item = liveOfType.find((it) => String(it.id) === id);
            const key = showKey(item?.title ?? item?.parentTitle);
            const members = groups.get(key);
            if (members && members.length > 0) episodeIdMap.set(id, members);
          }
        }
      }

      // Exclude items via LifecycleException. Mirror the scheduler's execution-time
      // filtering (processor.ts): drop a representative whose own id is excepted,
      // and for grouped series filter individually-excepted member episodes out of
      // matchedMediaItemIds — cancelling the item only if ALL its members are
      // excepted. This keeps the deletion-safety guarantee for ad-hoc actions.
      validateStep("Checking the exception list");
      const memberIds = new Set<string>();
      for (const members of episodeIdMap.values()) {
        for (const m of members) memberIds.add(m);
      }
      const exceptions = await prisma.lifecycleException.findMany({
        where: { userId, mediaItemId: { in: [...new Set([...actionUnitIds, ...memberIds])] } },
        select: { mediaItemId: true },
      });
      const excluded = new Set(exceptions.map((e) => e.mediaItemId));
      const actionableIds: string[] = [];
      for (const id of actionUnitIds) {
        if (excluded.has(id)) continue; // representative item is excepted
        const members = episodeIdMap.get(id);
        if (members && members.length > 0) {
          const remaining = members.filter((m) => !excluded.has(m));
          if (remaining.length === 0) continue; // every targeted episode is excepted
          // Exception inviolability: a whole-record destructive action ignores
          // the member list and would destroy the excepted episode along with
          // the rest of the series. Refuse the whole show rather than delete a
          // protected item (mirrors processor.ts's scheduler guard). Member-
          // scoped file deletes honor `remaining` and are safe to proceed.
          if (remaining.length < members.length && isWholeRecordDestructive) continue;
          episodeIdMap.set(id, remaining);
        }
        actionableIds.push(id);
      }
      skipped += actionUnitIds.length - actionableIds.length;
      if (actionableIds.length === 0) {
        return {
          executed: 0,
          failed: 0,
          skipped,
          errors: ["All selected items are excluded from lifecycle actions"],
        };
      }

      // Fetch ownership-verified media items with external IDs.
      validateStep("Loading items to act on");
      let items = await prisma.mediaItem.findMany({
        where: {
          id: { in: actionableIds },
          library: { mediaServer: { userId } },
        },
        include: { externalIds: true },
      });
      skipped += actionableIds.length - items.length;

      // Exception inviolability, part 2: the member check above only sees the
      // MATCHED episodes/tracks. A whole-record destructive action destroys
      // the entire series/artist — including siblings the query never matched
      // — so an exception on ANY item of the same parent must refuse it.
      if (isWholeRecordDestructive) {
        const protectedParents = await findExceptionProtectedParents(userId, items);
        if (protectedParents.size > 0) {
          const before = items.length;
          items = items.filter((i) => !i.parentTitle || !protectedParents.has(i.parentTitle));
          if (items.length < before) {
            skipped += before - items.length;
            logger.warn("Lifecycle", `Ad-hoc ${actionType}: skipped ${before - items.length} whole-record target(s) — an episode/track of the series/artist is excluded via lifecycle exception`);
          }
          if (items.length === 0) {
            return {
              executed: 0,
              failed: 0,
              skipped,
              errors: ["All selected items belong to series/artists with excluded episodes or tracks — a whole-record delete cannot exclude them"],
            };
          }
        }
      }

      // Per-item progress drives the determinate "Running action" segment.
      emit({ type: "phase", key: "execute", fraction: 0 });
      const { executed, failed, errors } = await executeActionsForItems(
        userId,
        items,
        {
          actionType,
          arrInstanceId: arrInstanceId ?? null,
          targetQualityProfileId: targetQualityProfileId ?? null,
          addImportExclusion,
          searchAfterAction,
          addArrTags,
          removeArrTags,
        },
        episodeIdMap,
        {
          ruleSetId: null,
          ruleSetName: "Ad-hoc query action",
          ruleSetType: resolvedType,
          cleanupMatches: false,
        },
        ({ done, total, current }) =>
          emit({
            type: "phase",
            key: "execute",
            fraction: total > 0 ? done / total : 1,
            // Per-item count plus the item + sub-step currently in flight.
            // `current` is only reported pre-increment, so done < total here.
            detail: current
              ? `${done + 1} / ${total} · ${current.title} — ${current.step}`
              : `${done} / ${total}`,
          }),
      );

      emit({ type: "phase", key: "finalize" });
      return { executed, failed, skipped, errors };
    },
    { signal: request.signal },
  );
}
