import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { isDestructiveActionType } from "@/lib/lifecycle/action-types";
import { actionConfigSignature } from "@/lib/lifecycle/action-signature";
import {
  actionTargetTitle,
  actionTitleSnapshot,
  loneMemberId,
  snapshotTargetTitle,
  type MemberEpisode,
} from "@/lib/lifecycle/action-target";
import { loadMemberEpisodes } from "@/lib/lifecycle/member-episodes";
import { loadGroupMemberStats, aggregateGroupMembers, memberIdsFromItemData } from "@/lib/lifecycle/group-aggregate";
import { heldScheduledFor, loadGroupedActionHold } from "@/lib/lifecycle/grouped-action-hold";

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
  matchedEpisodes: number | null;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
}

interface ActionItem {
  id: string;
  actionType: string;
  addImportExclusion: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  targetQualityProfileId: number | null;
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
    searchAfterAction: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    arrInstanceId: string | null;
    targetQualityProfileId?: number | null;
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
  id: true, title: true, parentTitle: true, type: true, thumbUrl: true, seasonNumber: true, episodeNumber: true,
  year: true, summary: true, parentSummary: true, contentRating: true, rating: true, ratingImage: true, audienceRating: true, audienceRatingImage: true,
  duration: true, resolution: true, dynamicRange: true, audioProfile: true, fileSize: true,
  genres: true, studio: true, playCount: true, lastPlayedAt: true, addedAt: true,
  library: { select: { mediaServer: { select: { id: true, name: true, type: true } } } },
} as const;

type SelectedMediaItem = {
  id: string; title: string; parentTitle: string | null; type: string; thumbUrl: string | null;
  seasonNumber: number | null; episodeNumber: number | null;
  year: number | null; summary: string | null; parentSummary: string | null; contentRating: string | null;
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
    year: mi.year, summary: mi.parentTitle ? (mi.parentSummary ?? mi.summary) : mi.summary, contentRating: mi.contentRating,
    rating: mi.rating, ratingImage: mi.ratingImage,
    audienceRating: mi.audienceRating, audienceRatingImage: mi.audienceRatingImage,
    duration: mi.duration, resolution: mi.resolution, dynamicRange: mi.dynamicRange,
    audioProfile: mi.audioProfile, fileSize: mi.fileSize?.toString() ?? null,
    genres: (Array.isArray(mi.genres) ? mi.genres : null) as string[] | null,
    studio: mi.studio, playCount: mi.playCount,
    lastPlayedAt: mi.lastPlayedAt?.toISOString() ?? null,
    addedAt: mi.addedAt?.toISOString() ?? null,
    matchedEpisodes: null,
    servers: ms ? [{ serverId: ms.id, serverName: ms.name, serverType: ms.type }] : undefined,
  };
}

function buildActionMediaItem(
  action: {
    actionType: string;
    matchedMediaItemIds: string[];
    mediaItemId: string | null;
    mediaItemTitle: string | null;
    mediaItemParentTitle: string | null;
    mediaItemSeasonNumber?: number | null;
    mediaItemEpisodeNumber?: number | null;
    ruleSetType: string | null;
    mediaItem: SelectedMediaItem | null;
  },
  ruleSetType: string,
  /** Episodes named by an action on one other episode, keyed by `loneMemberId`. */
  memberEpisodes: Map<string, MemberEpisode>,
): ActionItemMediaItem {
  // A series action is named by what it acts on: the show, or "<Show> SxxExx"
  // when it acts on one episode — never by the representative episode's own
  // title (see actionTargetTitle).
  if (action.mediaItem) {
    const mi = serializeMediaItem(action.mediaItem);
    if (ruleSetType === "SERIES") {
      const title = actionTargetTitle({
        ...action,
        mediaItem: { ...action.mediaItem, type: "SERIES" },
        memberEpisode: memberEpisodes.get(loneMemberId(action) ?? ""),
      });
      return { ...mi, title, parentTitle: null };
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
    playCount: 0, lastPlayedAt: null, addedAt: null, matchedEpisodes: null,
  };
  if (ruleSetType === "SERIES") {
    return { id: null, title: snapshotTargetTitle(action), parentTitle: null, type: ruleSetType, ...nullFields };
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
  if (!["PENDING", "COMPLETED", "FAILED", "ALL"].includes(status)) {
    return NextResponse.json(
      { error: "Invalid status. Must be PENDING, COMPLETED, FAILED, or ALL" },
      { status: 400 }
    );
  }

  if (status === "PENDING") {
    return handlePendingGrouped(request, session.userId!);
  }

  return handleStatusGrouped(request, session.userId!, status);
}

/**
 * PENDING: merge actual LifecycleAction PENDING records with RuleMatch-based
 * upcoming items, grouped by rule set.
 */
async function handlePendingGrouped(request: NextRequest, userId: string) {
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
          addImportExclusion: true, searchAfterAction: true, addArrTags: true,
          removeArrTags: true, arrInstanceId: true, targetQualityProfileId: true,
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
          data: actionTitleSnapshot({ ...a, mediaItem: a.mediaItem! }),
        })
      )
    );
  }

  // Fetch every action that could suppress an estimated row:
  // - PENDING actions (already scheduled), and
  // - COMPLETED/FAILED non-destructive actions, which we may suppress against —
  //   but only when they are the SAME EFFECTIVE ACTION the rule set would
  //   schedule now (matched on the full config signature; see below).
  //   Destructive (DELETE*) actions never suppress: a still-matching item after
  //   a "completed" delete means the delete failed silently on disk.
  const existingActions = await prisma.lifecycleAction.findMany({
    where: {
      userId,
      OR: [
        { status: "PENDING" },
        {
          status: { in: ["COMPLETED", "FAILED"] },
          actionType: { not: { contains: "DELETE" } },
        },
      ],
    },
    select: {
      ruleSetId: true,
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
          addImportExclusion: true, searchAfterAction: true, addArrTags: true,
          removeArrTags: true, arrInstanceId: true, targetQualityProfileId: true,
        },
      },
    },
    orderBy: { detectedAt: "asc" },
  });

  // A pair is suppressed when it already has a PENDING action, or a
  // COMPLETED/FAILED action whose config SIGNATURE equals what the rule set
  // would schedule now. Matching on the full signature is what lets a changed
  // action ("Search for New Copy" → "Delete from Radarr") OR a re-configured
  // one (edited tags / new quality profile) surface again: a prior action with
  // a different signature no longer suppresses it.
  const pendingPairs = new Set<string>();
  const completedSigsByPair = new Map<string, Set<string>>();
  for (const a of existingActions) {
    const pair = `${a.ruleSetId}:${a.mediaItemId}`;
    if (a.status === "PENDING") {
      pendingPairs.add(pair);
    } else {
      let sigs = completedSigsByPair.get(pair);
      if (!sigs) {
        sigs = new Set();
        completedSigsByPair.set(pair, sigs);
      }
      sigs.add(actionConfigSignature(a));
    }
  }

  const filteredUpcoming = upcomingMatches.filter((m) => {
    const pair = `${m.ruleSetId}:${m.mediaItemId}`;
    if (pendingPairs.has(pair)) return false;
    // DELETE* actions are always eligible to re-surface; non-destructive
    // actions are suppressed only by a completed action with the same signature.
    if (m.ruleSet.actionType && !isDestructiveActionType(m.ruleSet.actionType)) {
      if (completedSigsByPair.get(pair)?.has(actionConfigSignature(m.ruleSet))) return false;
    }
    return true;
  });

  // Pre-aggregate series/music member data so the response carries series-level
  // totals instead of the representative episode's own. Shared with the rules
  // diff route — see `group-aggregate.ts` for why the two must agree.
  const memberDataMap = await loadGroupMemberStats([
    ...pendingActions.flatMap((a) => a.matchedMediaItemIds),
    ...filteredUpcoming.flatMap((m) => memberIdsFromItemData(m.itemData)),
  ]);

  /** Overlay aggregated series/music data onto the media item response */
  function applyGroupAggregation(mi: ActionItemMediaItem, memberIds: string[]): ActionItemMediaItem {
    const totals = aggregateGroupMembers(memberIds, memberDataMap);
    if (!totals) return mi;
    return {
      ...mi,
      fileSize: totals.fileSize > BigInt(0) ? totals.fileSize.toString() : mi.fileSize,
      playCount: totals.playCount > 0 ? totals.playCount : mi.playCount,
      lastPlayedAt: totals.lastPlayedAt?.toISOString() ?? mi.lastPlayedAt,
      matchedEpisodes: totals.matchedEpisodes,
    };
  }

  // A series action on exactly one other episode is named after that episode.
  const memberEpisodes = await loadMemberEpisodes([
    ...pendingActions.map(loneMemberId),
    ...filteredUpcoming.map((m) =>
      loneMemberId({
        actionType: m.ruleSet.actionType!,
        matchedMediaItemIds: memberIdsFromItemData(m.itemData),
        mediaItemId: m.mediaItemId,
      }),
    ),
  ]);

  // 3. Group by rule set
  const groupMap = new Map<string, RuleSetGroup>();

  // Add pending LifecycleAction items
  for (const a of pendingActions) {
    if (!groupMap.has(a.ruleSetId!)) {
      groupMap.set(a.ruleSetId!, { ruleSet: a.ruleSet!, items: [], count: 0 });
    }
    const group = groupMap.get(a.ruleSetId!)!;
    const mi = buildActionMediaItem(a, a.ruleSet!.type, memberEpisodes);
    group.items.push({
      id: a.id,
      actionType: a.actionType,
      addImportExclusion: a.addImportExclusion,
      addArrTags: a.addArrTags,
      removeArrTags: a.removeArrTags,
      targetQualityProfileId: a.targetQualityProfileId,
      status: a.status,
      scheduledFor: a.scheduledFor.toISOString(),
      executedAt: a.executedAt?.toISOString() ?? null,
      error: a.error,
      createdAt: a.createdAt.toISOString(),
      estimated: false,
      mediaItem: applyGroupAggregation(mi, a.matchedMediaItemIds),
    });
    group.count++;
  }

  // Add upcoming RuleMatch items (estimated). A show's or an artist's match
  // estimates the one-time upgrade hold its action will be scheduled with.
  const hold = filteredUpcoming.length > 0 ? await loadGroupedActionHold(userId) : null;
  for (const m of filteredUpcoming) {
    if (!groupMap.has(m.ruleSetId)) {
      groupMap.set(m.ruleSetId, { ruleSet: m.ruleSet, items: [], count: 0 });
    }
    const group = groupMap.get(m.ruleSetId)!;
    const snapshot = m.itemData as Record<string, unknown> | null;
    const detectedPlusDelay = new Date(m.detectedAt);
    detectedPlusDelay.setDate(detectedPlusDelay.getDate() + m.ruleSet.actionDelayDays);
    const estimatedDate = heldScheduledFor(detectedPlusDelay, hold, {
      type: m.ruleSet.type,
      title: snapshot?.title,
      parentTitle: snapshot?.parentTitle,
    });
    const memberIds = memberIdsFromItemData(m.itemData);
    const mi = buildActionMediaItem({
      actionType: m.ruleSet.actionType!,
      matchedMediaItemIds: memberIds,
      mediaItemId: m.mediaItemId,
      mediaItemTitle: m.mediaItem.title,
      mediaItemParentTitle: m.mediaItem.parentTitle,
      ruleSetType: m.ruleSet.type,
      mediaItem: m.mediaItem,
    }, m.ruleSet.type, memberEpisodes);

    group.items.push({
      id: `rm_${m.id}`,
      actionType: m.ruleSet.actionType!,
      addImportExclusion: m.ruleSet.addImportExclusion,
      addArrTags: m.ruleSet.addArrTags,
      removeArrTags: m.ruleSet.removeArrTags,
      targetQualityProfileId: m.ruleSet.targetQualityProfileId,
      status: "PENDING",
      scheduledFor: estimatedDate.toISOString(),
      executedAt: null,
      error: null,
      createdAt: m.detectedAt.toISOString(),
      estimated: true,
      mediaItem: applyGroupAggregation(mi, memberIds),
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

  return jsonResponse(request, { groups });
}

/**
 * COMPLETED / FAILED / CANCELLED / ALL: group LifecycleAction records by rule set.
 */
async function handleStatusGrouped(request: NextRequest, userId: string, status: string) {
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
          addImportExclusion: true, searchAfterAction: true, addArrTags: true,
          removeArrTags: true, arrInstanceId: true, targetQualityProfileId: true,
        },
      },
    },
    orderBy: { scheduledFor: "desc" },
  });

  // Lazy backfill: snapshot title for actions that have a live mediaItem but no
  // denormalized title yet (pre-migration records). Prevents "Unknown" after deletion.
  const backfill: { id: string; data: ReturnType<typeof actionTitleSnapshot> }[] = [];
  for (const a of actions) {
    if (a.mediaItem && !a.mediaItemTitle) {
      backfill.push({ id: a.id, data: actionTitleSnapshot({ ...a, mediaItem: a.mediaItem }) });
    }
  }
  if (backfill.length > 0) {
    await Promise.all(
      backfill.map((b) =>
        prisma.lifecycleAction.update({
          where: { id: b.id },
          data: b.data,
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

  // Pre-aggregate series/music member data for actions with matchedMediaItemIds
  const statusMemberIds = deduped.flatMap((a) => a.matchedMediaItemIds);
  let statusMemberMap = new Map<string, { fileSize: bigint; playCount: number; lastPlayedAt: Date | null }>();
  if (statusMemberIds.length > 0) {
    const members = await prisma.mediaItem.findMany({
      where: { id: { in: statusMemberIds } },
      select: { id: true, fileSize: true, playCount: true, lastPlayedAt: true },
    });
    statusMemberMap = new Map(members.map((m) => [m.id, { fileSize: m.fileSize ?? BigInt(0), playCount: m.playCount, lastPlayedAt: m.lastPlayedAt }]));
  }

  // A series action on exactly one other episode is named after that episode.
  const memberEpisodes = await loadMemberEpisodes(deduped.map(loneMemberId));

  const groupMap = new Map<string, RuleSetGroup>();

  for (const a of deduped) {
    const groupKey = a.ruleSetId ?? `deleted:${a.ruleSetName ?? "unknown"}`;

    // When the rule set has been deleted, build a synthetic object from denormalized fields
    const ruleSetData = a.ruleSet ?? {
      id: groupKey,
      name: a.ruleSetName ?? "Deleted Rule Set",
      type: a.ruleSetType ?? a.mediaItem?.type ?? "MOVIE",
      actionType: a.actionType,
      actionDelayDays: 0,
      addImportExclusion: false,
      searchAfterAction: false,
      addArrTags: [] as string[],
      removeArrTags: [] as string[],
      arrInstanceId: null,
      targetQualityProfileId: a.targetQualityProfileId ?? null,
      deleted: true,
    };

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, { ruleSet: ruleSetData, items: [], count: 0 });
    }
    const group = groupMap.get(groupKey)!;
    let mi = buildActionMediaItem(a, ruleSetData.type, memberEpisodes);

    // Apply series/music aggregation from member items
    if (a.matchedMediaItemIds.length > 0) {
      let totalSize = BigInt(0);
      let totalPlays = 0;
      let latest: Date | null = null;
      for (const id of a.matchedMediaItemIds) {
        const d = statusMemberMap.get(id);
        if (!d) continue;
        totalSize += d.fileSize;
        totalPlays += d.playCount;
        if (d.lastPlayedAt && (!latest || d.lastPlayedAt > latest)) latest = d.lastPlayedAt;
      }
      // For completed delete actions, prefer deletedBytes (items may no longer exist in DB)
      const useDeletedBytes = a.status === "COMPLETED" && a.deletedBytes;
      mi = {
        ...mi,
        fileSize: useDeletedBytes
          ? a.deletedBytes!.toString()
          : totalSize > BigInt(0) ? totalSize.toString() : mi.fileSize,
        playCount: totalPlays > 0 ? totalPlays : mi.playCount,
        lastPlayedAt: latest?.toISOString() ?? mi.lastPlayedAt,
        matchedEpisodes: a.matchedMediaItemIds.length,
      };
    }

    group.items.push({
      id: a.id,
      actionType: a.actionType,
      addImportExclusion: a.addImportExclusion,
      addArrTags: a.addArrTags,
      removeArrTags: a.removeArrTags,
      targetQualityProfileId: a.targetQualityProfileId,
      status: a.status,
      scheduledFor: a.scheduledFor.toISOString(),
      executedAt: a.executedAt?.toISOString() ?? null,
      error: a.error,
      createdAt: a.createdAt.toISOString(),
      estimated: false,
      mediaItem: mi,
    });
    group.count++;
  }

  const groups = Array.from(groupMap.values());

  return jsonResponse(request, { groups });
}
