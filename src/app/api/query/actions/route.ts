import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeQuery } from "@/lib/query/query-engine";
import { executeActionsForItems } from "@/lib/lifecycle/run-actions";
import { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";
import { validateRequest, queryActionSchema } from "@/lib/validation";
import type { QueryDefinition } from "@/lib/query/types";

type MediaType = "MOVIE" | "SERIES" | "MUSIC";

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

  // SAFETY: re-run the query and only act on items that are still in the live
  // result set AND of the action's media type. This is the ad-hoc analog of the
  // RuleMatch validation used by rule-based execution.
  const liveResult = await executeQuery(query as QueryDefinition, userId, 1, 0);
  const liveOfType = liveResult.items.filter((it) => it.type === targetType);
  const liveIds = new Set(liveOfType.map((it) => String(it.id)));

  const validIds = mediaItemIds.filter((id) => liveIds.has(id));
  let skipped = mediaItemIds.length - validIds.length;

  if (validIds.length === 0) {
    logger.info("Lifecycle", `Ad-hoc query action ${actionType}: no selected items match the live query of type ${targetType}`);
    return NextResponse.json({ executed: 0, failed: 0, skipped, errors: [] });
  }

  // Resolve SERIES episode-level member IDs for file-deletion actions.
  const episodeIdMap = new Map<string, string[]>();
  if (targetType === "SERIES") {
    if (query.includeEpisodes) {
      // Results are already individual episodes — act on each on its own.
      for (const id of validIds) episodeIdMap.set(id, [id]);
    } else {
      // Grouped by show: re-run at episode level and map each selected show's
      // representative episode id to all matched episode ids of that show.
      const episodeResult = await executeQuery(
        { ...(query as QueryDefinition), includeEpisodes: true },
        userId,
        1,
        0,
      );
      // Group by the SAME key the query engine uses for grouped shows
      // (LOWER(TRIM(parentTitle))). Using a looser key (e.g. normalizeTitle)
      // would collapse distinct shows like "The Office (US)" / "The Office (UK)"
      // and act on the wrong episodes.
      const showKey = (s: unknown) => String(s ?? "").trim().toLowerCase();
      const groups = new Map<string, string[]>();
      for (const ep of episodeResult.items) {
        if (ep.type !== "SERIES" || ep.parentTitle == null) continue;
        const key = showKey(ep.parentTitle);
        const arr = groups.get(key) ?? [];
        arr.push(String(ep.id));
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

  // Exclude items with a LifecycleException.
  const exceptions = await prisma.lifecycleException.findMany({
    where: { userId, mediaItemId: { in: validIds } },
    select: { mediaItemId: true },
  });
  let actionableIds = validIds;
  if (exceptions.length > 0) {
    const excluded = new Set(exceptions.map((e) => e.mediaItemId));
    actionableIds = validIds.filter((id) => !excluded.has(id));
    skipped += validIds.length - actionableIds.length;
    if (actionableIds.length === 0) {
      return NextResponse.json({ executed: 0, failed: 0, skipped, errors: ["All selected items are excluded from lifecycle actions"] });
    }
  }

  // Fetch ownership-verified media items with external IDs.
  const items = await prisma.mediaItem.findMany({
    where: {
      id: { in: actionableIds },
      library: { mediaServer: { userId } },
    },
    include: { externalIds: true },
  });
  skipped += actionableIds.length - items.length;

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
      ruleSetType: targetType,
      cleanupMatches: false,
    },
  );

  return NextResponse.json({ executed, failed, skipped, errors });
}
