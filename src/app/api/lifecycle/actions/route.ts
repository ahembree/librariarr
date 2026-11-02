import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { jsonResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { isDestructiveActionType, ruleSetActsOnEpisodes } from "@/lib/lifecycle/action-types";
import { actionConfigSignature } from "@/lib/lifecycle/action-signature";
import { coverageOf, uncoveredEpisodes, type EpisodeCoverage } from "@/lib/lifecycle/episode-coverage";
import { loadStoredMatchMembers } from "@/lib/lifecycle/match-snapshot";
import {
  actionTargetTitle,
  actionTitleSnapshot,
  snapshotTargetTitle,
  type MemberEpisode,
} from "@/lib/lifecycle/action-target";
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
  audioCodec: string | null;
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
  duration: true, resolution: true, dynamicRange: true, audioProfile: true, audioCodec: true, fileSize: true,
  genres: true, studio: true, playCount: true, lastPlayedAt: true, addedAt: true, libraryId: true,
} as const;

const RULE_SET_SELECT = {
  id: true, name: true, type: true, seriesScope: true, actionType: true, actionDelayDays: true,
  addImportExclusion: true, searchAfterAction: true, addArrTags: true,
  removeArrTags: true, arrInstanceId: true, targetQualityProfileId: true,
} as const;

type LibraryServers = ReadonlyMap<string, { id: string; name: string; type: string }>;

/**
 * The user's rule sets and each library's server, read once. They used to come
 * through Prisma's per-row relation includes (`ruleSet`, `library.mediaServer`),
 * which stitched the same handful of rows onto every action — measured at
 * ~150 ms of a 10.8k-action listing.
 */
async function loadActionLookups(userId: string) {
  const [ruleSets, libraries] = await Promise.all([
    prisma.ruleSet.findMany({ where: { userId }, select: RULE_SET_SELECT }),
    prisma.library.findMany({
      where: { mediaServer: { userId } },
      select: { id: true, mediaServer: { select: { id: true, name: true, type: true } } },
    }),
  ]);
  return {
    ruleSetById: new Map(ruleSets.map((rs) => [rs.id, rs])),
    servers: new Map(libraries.map((l) => [l.id, l.mediaServer])) as LibraryServers,
  };
}

type SelectedMediaItem = {
  id: string; title: string; parentTitle: string | null; type: string; thumbUrl: string | null;
  seasonNumber: number | null; episodeNumber: number | null;
  year: number | null; summary: string | null; parentSummary: string | null; contentRating: string | null;
  rating: number | null; ratingImage: string | null;
  audienceRating: number | null; audienceRatingImage: string | null;
  duration: number | null; resolution: string | null; dynamicRange: string | null;
  audioProfile: string | null; audioCodec: string | null; fileSize: bigint | null;
  genres: unknown; studio: string | null;
  playCount: number; lastPlayedAt: Date | null; addedAt: Date | null;
  libraryId: string;
};

function serializeMediaItem(mi: SelectedMediaItem, servers: LibraryServers): ActionItemMediaItem {
  const ms = servers.get(mi.libraryId);
  return {
    id: mi.id, title: mi.title, parentTitle: mi.parentTitle, type: mi.type, thumbUrl: mi.thumbUrl,
    year: mi.year, summary: mi.parentTitle ? (mi.parentSummary ?? mi.summary) : mi.summary, contentRating: mi.contentRating,
    rating: mi.rating, ratingImage: mi.ratingImage,
    audienceRating: mi.audienceRating, audienceRatingImage: mi.audienceRatingImage,
    duration: mi.duration, resolution: mi.resolution, dynamicRange: mi.dynamicRange,
    audioProfile: mi.audioProfile, audioCodec: mi.audioCodec, fileSize: mi.fileSize?.toString() ?? null,
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
    status: string;
    matchedMediaItemIds: string[];
    episodeScope?: boolean;
    mediaItemTitle: string | null;
    mediaItemParentTitle: string | null;
    mediaItemSeasonNumber?: number | null;
    mediaItemEpisodeNumber?: number | null;
    ruleSetType: string | null;
    mediaItem: SelectedMediaItem | null;
  },
  ruleSetType: string,
  /** The members' rows, which name an action on one episode (see actionTargetTitle). */
  memberEpisodes: ReadonlyMap<string, MemberEpisode>,
  servers: LibraryServers,
): ActionItemMediaItem {
  // A series action is named by what it acts on: the show, or "<Show> SxxExx"
  // when it acts on one episode — never by the representative episode's own
  // title (see actionTargetTitle). Once it has run, by the snapshot it recorded
  // then, as the episode it acted on may be gone since.
  if (action.mediaItem) {
    const mi = serializeMediaItem(action.mediaItem, servers);
    if (ruleSetType !== "SERIES") return mi;
    const title = action.status === "PENDING" || !action.mediaItemTitle
      ? actionTargetTitle({ ...action, mediaItem: action.mediaItem, memberEpisodes })
      : snapshotTargetTitle(action);
    return { ...mi, title, parentTitle: null };
  }
  // MediaItem deleted — use denormalized fields
  const title = action.mediaItemTitle ?? "Unknown";
  const parentTitle = action.mediaItemParentTitle ?? null;
  const nullFields = {
    thumbUrl: null, year: null, summary: null, contentRating: null, rating: null, ratingImage: null,
    audienceRating: null, audienceRatingImage: null, duration: null, resolution: null, dynamicRange: null,
    audioProfile: null, audioCodec: null, fileSize: null, genres: null, studio: null,
    playCount: 0, lastPlayedAt: null, addedAt: null, matchedEpisodes: null,
  };
  if (ruleSetType === "SERIES") {
    return { id: null, title: snapshotTargetTitle(action), parentTitle: null, type: ruleSetType, ...nullFields };
  }
  return { id: null, title, parentTitle, type: action.ruleSetType ?? ruleSetType, ...nullFields };
}

/**
 * Lazy backfill: snapshot the title of actions that have a live mediaItem but
 * no denormalized title yet (pre-migration records), so they don't read
 * "Unknown" once the item is deleted.
 */
async function backfillTitleSnapshots(
  actions: Array<{
    id: string;
    actionType: string;
    matchedMediaItemIds: string[];
    mediaItemTitle: string | null;
    mediaItem: SelectedMediaItem | null;
  }>,
): Promise<void> {
  await Promise.all(
    actions
      .filter((a) => a.mediaItem && !a.mediaItemTitle)
      .map((a) =>
        prisma.lifecycleAction.update({
          where: { id: a.id },
          data: actionTitleSnapshot({ ...a, mediaItem: a.mediaItem! }),
        }),
      ),
  );
}

export const GET = withSession(async (session, request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || "PENDING";
  if (!["PENDING", "COMPLETED", "FAILED", "ALL"].includes(status)) {
    return NextResponse.json(
      { error: "Invalid status. Must be PENDING, COMPLETED, FAILED, or ALL" },
      { status: 400 }
    );
  }

  if (status === "PENDING") {
    return handlePendingGrouped(request, session.userId);
  }

  return handleStatusGrouped(request, session.userId, status);
});

/**
 * PENDING: merge actual LifecycleAction PENDING records with RuleMatch-based
 * upcoming items, grouped by rule set.
 */
async function handlePendingGrouped(request: NextRequest, userId: string) {
  // 1. The PENDING actions, read with everything step 2 needs to tell which
  // matches still have none — four reads, none depending on another.
  const [pendingActions, { ruleSetById, servers }, settledActions, matchKeys] = await Promise.all([
    prisma.lifecycleAction.findMany({
      where: { userId, status: "PENDING", ruleSetId: { not: null } },
      include: {
        mediaItem: {
          select: MEDIA_ITEM_SELECT,
        },
      },
      orderBy: { scheduledFor: "asc" },
    }),
    loadActionLookups(userId),
    // COMPLETED/FAILED non-destructive actions also suppress an estimated row —
    // but only when they are the SAME EFFECTIVE ACTION the rule set would
    // schedule now (matched on the full config signature; see below).
    // Destructive (DELETE*) actions never suppress: a still-matching item after
    // a "completed" delete means the delete failed silently on disk.
    prisma.lifecycleAction.findMany({
      where: {
        userId,
        status: { in: ["COMPLETED", "FAILED"] },
        actionType: { not: { contains: "DELETE" } },
      },
      select: {
        ruleSetId: true,
        mediaItemId: true,
        actionType: true,
        arrInstanceId: true,
        targetQualityProfileId: true,
        addImportExclusion: true,
        searchAfterAction: true,
        addArrTags: true,
        removeArrTags: true,
        matchedMediaItemIds: true,
      },
    }),
    // 2. The matches of action-enabled rule sets — their keys only. Once the
    // scheduler has run nearly every match already has a PENDING action, and
    // loading every match's `itemData` snapshot and media row just to drop it
    // was the slowest part of this route: measured on 10.8k matches, 640–900 ms
    // against ~35 ms for the keys. The full rows are read for those left.
    prisma.ruleMatch.findMany({
      where: { ruleSet: { userId, enabled: true, actionEnabled: true, actionType: { not: null } } },
      select: { id: true, ruleSetId: true, mediaItemId: true },
    }),
  ]);

  await backfillTitleSnapshots(pendingActions);

  // A pair is suppressed when it already has a PENDING action, or a
  // COMPLETED/FAILED action whose config SIGNATURE equals what the rule set
  // would schedule now. Matching on the full signature is what lets a changed
  // action ("Search for New Copy" → "Delete from Radarr") OR a re-configured
  // one (edited tags / new quality profile) surface again: a prior action with
  // a different signature no longer suppresses it.
  const pendingPairs = new Set(pendingActions.map((a) => `${a.ruleSetId}:${a.mediaItemId}`));
  const completedSigsByPair = new Map<string, Set<string>>();
  const settledByRuleSet = new Map<string, typeof settledActions>();
  for (const a of settledActions) {
    const pair = `${a.ruleSetId}:${a.mediaItemId}`;
    let sigs = completedSigsByPair.get(pair);
    if (!sigs) {
      sigs = new Set();
      completedSigsByPair.set(pair, sigs);
    }
    sigs.add(actionConfigSignature(a));
    if (a.ruleSetId) settledByRuleSet.set(a.ruleSetId, [...(settledByRuleSet.get(a.ruleSetId) ?? []), a]);
  }

  // A Series rule set's action is suppressed per episode, from every settled
  // action of the rule set with the same configuration (`episode-coverage.ts`),
  // exactly as the scheduler decides it — which needs the matches' member
  // lists, read only for the rule sets with such an action.
  const coverageByRuleSet = new Map<string, EpisodeCoverage>();
  for (const [ruleSetId, settled] of settledByRuleSet) {
    const ruleSet = ruleSetById.get(ruleSetId);
    if (!ruleSet || ruleSet.type !== "SERIES" || !ruleSet.actionType || isDestructiveActionType(ruleSet.actionType)) continue;
    const signature = actionConfigSignature(ruleSet);
    const same = settled.filter((a) => actionConfigSignature(a) === signature);
    if (same.length > 0) coverageByRuleSet.set(ruleSetId, coverageOf(same));
  }
  const currentMembersByPair = new Map<string, string[]>();
  for (const m of await loadStoredMatchMembers([...coverageByRuleSet.keys()])) {
    const ids = Array.isArray(m.memberIds) ? m.memberIds.filter((x): x is string => typeof x === "string") : [];
    currentMembersByPair.set(`${m.ruleSetId}:${m.mediaItemId}`, ids);
  }
  /** The episodes an estimated row's action would act on, or null when nothing narrows it. */
  const uncoveredFor = (ruleSetId: string, mediaItemId: string): string[] | null => {
    const coverage = coverageByRuleSet.get(ruleSetId);
    if (!coverage) return null;
    return uncoveredEpisodes(mediaItemId, currentMembersByPair.get(`${ruleSetId}:${mediaItemId}`) ?? [], coverage);
  };

  const upcomingIds = matchKeys
    .filter((m) => {
      const pair = `${m.ruleSetId}:${m.mediaItemId}`;
      if (pendingPairs.has(pair)) return false;
      // DELETE* actions are always eligible to re-surface; non-destructive
      // actions are suppressed only by a completed action with the same signature.
      // The lookups are read alongside the matches, so a rule set deleted in
      // between is simply not there: nothing to estimate for it.
      const ruleSet = ruleSetById.get(m.ruleSetId);
      if (!ruleSet) return false;
      if (!ruleSet.actionType || isDestructiveActionType(ruleSet.actionType)) return true;
      if (ruleSet.type === "SERIES") {
        const left = uncoveredFor(m.ruleSetId, m.mediaItemId);
        return left === null || left.length > 0;
      }
      return !completedSigsByPair.get(pair)?.has(actionConfigSignature(ruleSet));
    })
    .map((m) => m.id);

  const filteredUpcoming = (upcomingIds.length === 0
    ? []
    : await prisma.ruleMatch.findMany({
        where: { id: { in: upcomingIds } },
        include: {
          mediaItem: {
            select: MEDIA_ITEM_SELECT,
          },
        },
        orderBy: { detectedAt: "asc" },
      })
  ).flatMap((m) => {
    const ruleSet = ruleSetById.get(m.ruleSetId);
    return ruleSet ? [{ ...m, ruleSet }] : [];
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

  // 3. Group by rule set
  const groupMap = new Map<string, RuleSetGroup>();

  // Add pending LifecycleAction items
  for (const a of pendingActions) {
    const ruleSet = ruleSetById.get(a.ruleSetId!);
    // Deleted between this read and the lookups' (its actions lose the id).
    if (!ruleSet) continue;
    if (!groupMap.has(a.ruleSetId!)) {
      groupMap.set(a.ruleSetId!, { ruleSet, items: [], count: 0 });
    }
    const group = groupMap.get(a.ruleSetId!)!;
    const mi = buildActionMediaItem(
      { ...a, episodeScope: ruleSetActsOnEpisodes(a.actionType, ruleSet) },
      ruleSet.type,
      memberDataMap,
      servers,
    );
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
    // An episode-scoped action is scheduled for, and executes on, only the
    // episodes no settled action of the same configuration has covered: list
    // those, not every member.
    const allMembers = memberIdsFromItemData(m.itemData);
    const memberIds =
      m.ruleSet.actionType && ruleSetActsOnEpisodes(m.ruleSet.actionType, m.ruleSet)
        ? (uncoveredFor(m.ruleSetId, m.mediaItemId) ?? allMembers)
        : allMembers;
    const mi = buildActionMediaItem({
      actionType: m.ruleSet.actionType!,
      status: "PENDING",
      matchedMediaItemIds: memberIds,
      episodeScope: ruleSetActsOnEpisodes(m.ruleSet.actionType!, m.ruleSet),
      mediaItemTitle: m.mediaItem.title,
      mediaItemParentTitle: m.mediaItem.parentTitle,
      ruleSetType: m.ruleSet.type,
      mediaItem: m.mediaItem,
    }, m.ruleSet.type, memberDataMap, servers);

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
/**
 * The most recent action (by `scheduledFor`, then id) of each (rule set, item)
 * pair, newest first — picked in SQL, so the older actions of a pair, and
 * their media rows, are never read. A deleted rule set's actions pair by the
 * name they recorded; an action whose item is gone pairs with nothing but
 * itself.
 */
async function latestActionIdPerPair(userId: string, status: string): Promise<string[]> {
  const pairKey = `COALESCE("ruleSetId", 'deleted:' || COALESCE("ruleSetName", 'unknown')), COALESCE("mediaItemId", id)`;
  const filterStatus = status !== "ALL";
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM (
       SELECT DISTINCT ON (${pairKey}) id, "scheduledFor"
         FROM "LifecycleAction"
        WHERE "userId" = $1${filterStatus ? ` AND status = $2::"LifecycleActionStatus"` : ""}
        ORDER BY ${pairKey}, "scheduledFor" DESC, id
     ) latest
     ORDER BY "scheduledFor" DESC, id`,
    ...(filterStatus ? [userId, status] : [userId]),
  );
  return rows.map((r) => r.id);
}

async function handleStatusGrouped(request: NextRequest, userId: string, status: string) {
  const [ids, { ruleSetById, servers }] = await Promise.all([
    latestActionIdPerPair(userId, status),
    loadActionLookups(userId),
  ]);

  // Only the latest action per (rule set, item) is listed (see above).
  const deduped =
    ids.length === 0
      ? []
      : await prisma.lifecycleAction.findMany({
          where: { id: { in: ids } },
          include: {
            mediaItem: {
              select: MEDIA_ITEM_SELECT,
            },
          },
          orderBy: [{ scheduledFor: "desc" }, { id: "asc" }],
        });

  await backfillTitleSnapshots(deduped);

  // Pre-aggregate series/music member data for actions with matchedMediaItemIds
  const memberStats = await loadGroupMemberStats(deduped.flatMap((a) => a.matchedMediaItemIds));

  const groupMap = new Map<string, RuleSetGroup>();

  for (const a of deduped) {
    const groupKey = a.ruleSetId ?? `deleted:${a.ruleSetName ?? "unknown"}`;

    // When the rule set has been deleted, build a synthetic object from denormalized fields
    const ruleSetData = (a.ruleSetId ? ruleSetById.get(a.ruleSetId) : undefined) ?? {
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
    let mi = buildActionMediaItem(a, ruleSetData.type, memberStats, servers);

    // Apply series/music aggregation from member items
    const totals = aggregateGroupMembers(a.matchedMediaItemIds, memberStats);
    if (totals) {
      // For completed delete actions, prefer deletedBytes (items may no longer exist in DB)
      const useDeletedBytes = a.status === "COMPLETED" && a.deletedBytes;
      mi = {
        ...mi,
        fileSize: useDeletedBytes
          ? a.deletedBytes!.toString()
          : totals.fileSize > BigInt(0) ? totals.fileSize.toString() : mi.fileSize,
        playCount: totals.playCount > 0 ? totals.playCount : mi.playCount,
        lastPlayedAt: totals.lastPlayedAt?.toISOString() ?? mi.lastPlayedAt,
        matchedEpisodes: totals.matchedEpisodes,
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
