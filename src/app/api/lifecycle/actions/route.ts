import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

interface ActionItemMediaItem {
  id: string | null;
  title: string;
  parentTitle: string | null;
  type: string;
  thumbUrl: string | null;
  year: number | null;
  summary: string | null;
  contentRating: string | null;
  rating: number | null;
  ratingImage: string | null;
  audienceRating: number | null;
  audienceRatingImage: string | null;
  duration: number | null;
  resolution: string | null;
  dynamicRange: string | null;
  audioProfile: string | null;
  fileSize: string | null;
  genres: string[] | null;
  studio: string | null;
  playCount: number;
  lastPlayedAt: string | null;
  addedAt: string | null;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
}

interface ActionItem {
  id: string;
  actionType: string;
  addImportExclusion: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  status: string;
  scheduledFor: string;
  executedAt: string | null;
  error: string | null;
  createdAt: string;
  estimated: boolean;
  mediaItem: ActionItemMediaItem;
}

interface RuleSetGroup {
  ruleSet: {
    id: string;
    name: string;
    type: string;
    actionType: string | null;
    actionDelayDays: number;
    addImportExclusion: boolean;
    searchAfterDelete: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    arrInstanceId: string | null;
  };
  items: ActionItem[];
  count: number;
}

/**
 * Build the mediaItem object for an action response.
 * Falls back to denormalized fields when the MediaItem has been deleted (e.g. after a
 * destructive lifecycle action followed by a library sync).
 */
const MEDIA_ITEM_SELECT = {
  id: true, title: true, parentTitle: true, type: true, thumbUrl: true,
  year: true, summary: true, contentRating: true, rating: true, ratingImage: true, audienceRating: true, audienceRatingImage: true,
  duration: true, resolution: true, dynamicRange: true, audioProfile: true, fileSize: true,
  genres: true, studio: true, playCount: true, lastPlayedAt: true, addedAt: true,
  library: { select: { mediaServer: { select: { id: true, name: true, type: true } } } },
} as const;

type SelectedMediaItem = {
  id: string; title: string; parentTitle: string | null; type: string; thumbUrl: string | null;
  year: number | null; summary: string | null; contentRating: string | null;
  rating: number | null; ratingImage: string | null;
  audienceRating: number | null; audienceRatingImage: string | null;
  duration: number | null; resolution: string | null; dynamicRange: string | null;
  audioProfile: string | null; fileSize: bigint | null;
  genres: unknown; studio: string | null;
  playCount: number; lastPlayedAt: Date | null; addedAt: Date | null;
  library: { mediaServer: { id: string; name: string; type: string } | null };
};

function serializeMediaItem(mi: SelectedMediaItem): ActionItemMediaItem {
  const ms = mi.library.mediaServer;
  return {
    id: mi.id, title: mi.title, parentTitle: mi.parentTitle, type: mi.type, thumbUrl: mi.thumbUrl,
    year: mi.year, summary: mi.summary, contentRating: mi.contentRating,
    rating: mi.rating, ratingImage: mi.ratingImage,
    audienceRating: mi.audienceRating, audienceRatingImage: mi.audienceRatingImage,
    duration: mi.duration, resolution: mi.resolution, dynamicRange: mi.dynamicRange,
    audioProfile: mi.audioProfile, fileSize: mi.fileSize?.toString() ?? null,
    genres: (Array.isArray(mi.genres) ? mi.genres : null) as string[] | null,
    studio: mi.studio, playCount: mi.playCount,
    lastPlayedAt: mi.lastPlayedAt?.toISOString() ?? null,
    addedAt: mi.addedAt?.toISOString() ?? null,
    servers: ms ? [{ serverId: ms.id, serverName: ms.name, serverType: ms.type }] : undefined,
  };
}

function buildActionMediaItem(
  action: {
    mediaItemId: string | null;
    mediaItemTitle: string | null;
    mediaItemParentTitle: string | null;
    ruleSetType: string | null;
    mediaItem: SelectedMediaItem | null;
  },
  ruleSetType: string
): ActionItemMediaItem {
  if (action.mediaItem) {
    const mi = serializeMediaItem(action.mediaItem);
    if (ruleSetType === "SERIES" && mi.parentTitle) {
      return { ...mi, title: mi.parentTitle, parentTitle: null };
    }
    return mi;
  }
  // MediaItem deleted — use denormalized fields
  const title = action.mediaItemTitle ?? "Unknown";
  const parentTitle = action.mediaItemParentTitle ?? null;
  const nullFields = {
    thumbUrl: null, year: null, summary: null, contentRating: null, rating: null, ratingImage: null,
    audienceRating: null, audienceRatingImage: null, duration: null, resolution: null, dynamicRange: null,
    audioProfile: null, fileSize: null, genres: null, studio: null,
    playCount: 0, lastPlayedAt: null, addedAt: null,
  };
  if (ruleSetType === "SERIES" && parentTitle) {
    return { id: null, title: parentTitle, parentTitle: null, type: ruleSetType, ...nullFields };
  }
  return { id: null, title, parentTitle, type: action.ruleSetType ?? ruleSetType, ...nullFields };
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || "PENDING";

  if (status === "PENDING") {
    return handlePendingGrouped(session.userId!);
  }

  return handleStatusGrouped(session.userId!, status);
}

/**
 * PENDING: merge actual LifecycleAction PENDING records with RuleMatch-based
 * upcoming items, grouped by rule set.
 */
async function handlePendingGrouped(userId: string) {
  // 1. Fetch actual PENDING LifecycleAction records
  const pendingActions = await prisma.lifecycleAction.findMany({
    where: { userId, status: "PENDING", ruleSetId: { not: null } },
    include: {
      mediaItem: {
        select: MEDIA_ITEM_SELECT,
      },
      ruleSet: {
        select: {
          id: true, name: true, type: true, actionType: true, actionDelayDays: true,
          addImportExclusion: true, searchAfterDelete: true, addArrTags: true,
          removeArrTags: true, arrInstanceId: true,
        },
      },
    },
    orderBy: { scheduledFor: "asc" },
  });

  // Lazy backfill denormalized titles for pre-migration PENDING actions
  const pendingBackfill = pendingActions.filter((a) => a.mediaItem && !a.mediaItemTitle);
  if (pendingBackfill.length > 0) {
    await Promise.all(
      pendingBackfill.map((a) =>
        prisma.lifecycleAction.update({
          where: { id: a.id },
          data: { mediaItemTitle: a.mediaItem!.title, mediaItemParentTitle: a.mediaItem!.parentTitle },
        })
      )
    );
  }

  // Build set of (ruleSetId, mediaItemId) pairs that should NOT appear as estimated.
  const existingActions = await prisma.lifecycleAction.findMany({
    where: { userId, status: { in: ["PENDING", "COMPLETED", "FAILED"] } },
    select: { ruleSetId: true, mediaItemId: true },
  });
  const actionedPairs = new Set(
    existingActions.map((a) => `${a.ruleSetId}:${a.mediaItemId}`)
  );

  // 2. Fetch RuleMatch records for action-enabled rule sets without any lifecycle action
  const upcomingMatches = await prisma.ruleMatch.findMany({
    where: {
      ruleSet: {
        userId,
        enabled: true,
        actionEnabled: true,
        actionType: { not: null },
      },
    },
    include: {
      mediaItem: {
        select: MEDIA_ITEM_SELECT,
      },
      ruleSet: {
        select: {
          id: true, name: true, type: true, actionType: true, actionDelayDays: true,
          addImportExclusion: true, searchAfterDelete: true, addArrTags: true,
          removeArrTags: true, arrInstanceId: true,
        },
      },
    },
    orderBy: { detectedAt: "asc" },
  });

  // Filter out matches that already have a pending action
  const filteredUpcoming = upcomingMatches.filter(
    (m) => !actionedPairs.has(`${m.ruleSetId}:${m.mediaItemId}`)
  );

  // 3. Group by rule set
  const groupMap = new Map<string, RuleSetGroup>();

  // Add pending LifecycleAction items
  for (const a of pendingActions) {
    if (!groupMap.has(a.ruleSetId!)) {
      groupMap.set(a.ruleSetId!, { ruleSet: a.ruleSet!, items: [], count: 0 });
    }
    const group = groupMap.get(a.ruleSetId!)!;
    group.items.push({
      id: a.id,
      actionType: a.actionType,
      addImportExclusion: a.addImportExclusion,
      addArrTags: a.addArrTags,
      removeArrTags: a.removeArrTags,
      status: a.status,
      scheduledFor: a.scheduledFor.toISOString(),
      executedAt: a.executedAt?.toISOString() ?? null,
      error: a.error,
      createdAt: a.createdAt.toISOString(),
      estimated: false,
      mediaItem: buildActionMediaItem(a, a.ruleSet!.type),
    });
    group.count++;
  }

  // Add upcoming RuleMatch items (estimated)
  for (const m of filteredUpcoming) {
    if (!groupMap.has(m.ruleSetId)) {
      groupMap.set(m.ruleSetId, { ruleSet: m.ruleSet, items: [], count: 0 });
    }
    const group = groupMap.get(m.ruleSetId)!;
    const estimatedDate = new Date(m.detectedAt);
    estimatedDate.setDate(estimatedDate.getDate() + m.ruleSet.actionDelayDays);

    group.items.push({
      id: `rm_${m.id}`,
      actionType: m.ruleSet.actionType!,
      addImportExclusion: m.ruleSet.addImportExclusion,
      addArrTags: m.ruleSet.addArrTags,
      removeArrTags: m.ruleSet.removeArrTags,
      status: "PENDING",
      scheduledFor: estimatedDate.toISOString(),
      executedAt: null,
      error: null,
      createdAt: m.detectedAt.toISOString(),
      estimated: true,
      mediaItem: buildActionMediaItem({
        mediaItemId: m.mediaItemId,
        mediaItemTitle: m.mediaItem.title,
        mediaItemParentTitle: m.mediaItem.parentTitle,
        ruleSetType: m.ruleSet.type,
        mediaItem: m.mediaItem,
      }, m.ruleSet.type),
    });
    group.count++;
  }

  // Sort items within each group by scheduledFor
  for (const group of groupMap.values()) {
    group.items.sort(
      (a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime()
    );
  }

  // Sort groups by earliest scheduledFor
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    const aFirst = a.items[0]?.scheduledFor ?? "";
    const bFirst = b.items[0]?.scheduledFor ?? "";
    return aFirst.localeCompare(bFirst);
  });

  return NextResponse.json({ groups });
}

/**
 * COMPLETED / FAILED / CANCELLED / ALL: group LifecycleAction records by rule set.
 */
async function handleStatusGrouped(userId: string, status: string) {
  const where: Record<string, unknown> = { userId };
  if (status !== "ALL") {
    where.status = status;
  }

  const actions = await prisma.lifecycleAction.findMany({
    where,
    include: {
      mediaItem: {
        select: MEDIA_ITEM_SELECT,
      },
      ruleSet: {
        select: {
          id: true, name: true, type: true, actionType: true, actionDelayDays: true,
          addImportExclusion: true, searchAfterDelete: true, addArrTags: true,
          removeArrTags: true, arrInstanceId: true,
        },
      },
    },
    orderBy: { scheduledFor: "desc" },
  });

  // Lazy backfill: snapshot title for actions that have a live mediaItem but no
  // denormalized title yet (pre-migration records). Prevents "Unknown" after deletion.
  const backfillIds: { id: string; title: string; parentTitle: string | null }[] = [];
  for (const a of actions) {
    if (a.mediaItem && !a.mediaItemTitle) {
      backfillIds.push({ id: a.id, title: a.mediaItem.title, parentTitle: a.mediaItem.parentTitle });
    }
  }
  if (backfillIds.length > 0) {
    await Promise.all(
      backfillIds.map((b) =>
        prisma.lifecycleAction.update({
          where: { id: b.id },
          data: { mediaItemTitle: b.title, mediaItemParentTitle: b.parentTitle },
        })
      )
    );
  }

  // Dedup: keep only the most recent record per (ruleSetId, mediaItemId).
  // Actions are ordered by scheduledFor desc, so the first seen per pair is the latest.
  const seenPairs = new Set<string>();
  const deduped = actions.filter((a) => {
    const groupKey = a.ruleSetId ?? `deleted:${a.ruleSetName ?? "unknown"}`;
    // Use action id for orphaned records (null mediaItemId) to prevent merging
    const key = `${groupKey}:${a.mediaItemId ?? a.id}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });

  const groupMap = new Map<string, RuleSetGroup>();

  for (const a of deduped) {
    const groupKey = a.ruleSetId ?? `deleted:${a.ruleSetName ?? "unknown"}`;

    // When the rule set has been deleted, build a synthetic object from denormalized fields
    const ruleSetData = a.ruleSet ?? {
      id: groupKey,
      name: a.ruleSetName ?? "Deleted Rule Set",
      type: a.ruleSetType ?? "MOVIE",
      actionType: a.actionType,
      actionDelayDays: 0,
      addImportExclusion: false,
      searchAfterDelete: false,
      addArrTags: [] as string[],
      removeArrTags: [] as string[],
      arrInstanceId: null,
      deleted: true,
    };

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, { ruleSet: ruleSetData, items: [], count: 0 });
    }
    const group = groupMap.get(groupKey)!;
    group.items.push({
      id: a.id,
      actionType: a.actionType,
      addImportExclusion: a.addImportExclusion,
      addArrTags: a.addArrTags,
      removeArrTags: a.removeArrTags,
      status: a.status,
      scheduledFor: a.scheduledFor.toISOString(),
      executedAt: a.executedAt?.toISOString() ?? null,
      error: a.error,
      createdAt: a.createdAt.toISOString(),
      estimated: false,
      mediaItem: buildActionMediaItem(a, ruleSetData.type),
    });
    group.count++;
  }

  const groups = Array.from(groupMap.values());

  return NextResponse.json({ groups });
}
