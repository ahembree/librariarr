// Client-safe (no server imports).
import { actionHonorsMemberIds } from "@/lib/lifecycle/action-types";
import { formatEpisodeTitle, seriesTitleOf, type MediaTitleParts } from "@/lib/media/display-title";

/** An episode as far as naming it goes: its own title and its SxxExx. */
export interface MemberEpisode {
  title?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

export interface ActionTargetParts {
  actionType: string;
  /** The episodes a member-scoped action acts on. */
  matchedMediaItemIds?: readonly string[] | null;
  mediaItem: MediaTitleParts & { id: string; title: string; parentTitle: string | null };
  /**
   * The one episode a member-scoped action acts on when that episode is NOT
   * the item the action is stored against (see `loneMemberId`). A series match
   * is stored against the show's lowest-id episode, which need not be one of
   * the episodes it matched, so the caller has to look this one up; without it
   * the action is named by its show.
   */
  memberEpisode?: MemberEpisode | null;
}

function isSeriesAction(action: ActionTargetParts): boolean {
  return action.mediaItem.type === "SERIES" || action.actionType.endsWith("_SONARR");
}

/**
 * The id of the one episode a member-scoped action acts on when it is not the
 * action's own item — the episode whose numbers the caller must supply as
 * `memberEpisode` — else null.
 */
export function loneMemberId(action: {
  actionType: string;
  matchedMediaItemIds?: readonly string[] | null;
  mediaItemId?: string | null;
}): string | null {
  const members = action.matchedMediaItemIds ?? [];
  if (!actionHonorsMemberIds(action.actionType) || members.length !== 1) return null;
  return members[0] !== action.mediaItemId ? members[0] : null;
}

/** The one episode a series action acts on, when it acts on exactly one. */
function targetEpisode(action: ActionTargetParts): MemberEpisode | null {
  const members = action.matchedMediaItemIds ?? [];
  if (!actionHonorsMemberIds(action.actionType) || members.length !== 1) return null;
  return members[0] === action.mediaItem.id ? action.mediaItem : (action.memberEpisode ?? null);
}

/**
 * What a log line, error, notification or list row calls the thing a
 * lifecycle action acts on.
 *
 * A series action is stored against ONE representative episode, but it acts on
 * the show — a whole-series action on the Sonarr series, a file delete on the
 * episodes it matched — so it is named by the show, never by that episode's
 * own title. The exception is an action on exactly one episode (the Query
 * page's file delete on a single episode, or a rule that matched just the one),
 * which is named "<Show> SxxExx". A movie or track keeps its own title.
 */
export function actionTargetTitle(action: ActionTargetParts): string {
  const item = action.mediaItem;
  if (!isSeriesAction(action)) return item.title;
  const episode = targetEpisode(action);
  if (!episode) return seriesTitleOf(item);
  return formatEpisodeTitle({
    title: episode.title,
    parentTitle: item.parentTitle,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
  });
}

export interface ActionTitleSnapshot {
  mediaItemTitle: string;
  mediaItemParentTitle: string | null;
  mediaItemSeasonNumber?: number | null;
  mediaItemEpisodeNumber?: number | null;
}

/**
 * The title snapshot a `LifecycleAction` records for its item — what the
 * history shows once the item is gone, and the identity `matchIdentityChange`
 * checks before a force-retry. A series action records its show (title = the
 * show, no parent), the shape `scheduleActionsForRuleSet` writes, never the
 * representative episode's own title: that episode being re-titled by a
 * metadata refresh does not make it a different show, but compared against an
 * episode-level snapshot it refused the retry as a Fix Match. An action on one
 * episode also records that episode's numbers, and only such an action does,
 * so `snapshotTargetTitle` can still name it "<Show> SxxExx" once the episode's
 * row is purged.
 */
export function actionTitleSnapshot(action: ActionTargetParts): ActionTitleSnapshot {
  const item = action.mediaItem;
  if (!isSeriesAction(action)) return { mediaItemTitle: item.title, mediaItemParentTitle: item.parentTitle };
  const episode = targetEpisode(action);
  return {
    mediaItemTitle: seriesTitleOf(item),
    mediaItemParentTitle: null,
    mediaItemSeasonNumber: episode?.seasonNumber ?? null,
    mediaItemEpisodeNumber: episode?.episodeNumber ?? null,
  };
}

/**
 * `actionTargetTitle` for a series action whose item is gone, from the snapshot
 * `actionTitleSnapshot` recorded: "<Show> SxxExx" when it acted on one episode,
 * else the show. A snapshot from before series actions recorded their show
 * (title = the episode, parent = the show) still yields the show.
 */
export function snapshotTargetTitle(snapshot: {
  mediaItemTitle: string | null;
  mediaItemParentTitle: string | null;
  mediaItemSeasonNumber?: number | null;
  mediaItemEpisodeNumber?: number | null;
}): string {
  const show = seriesTitleOf({ title: snapshot.mediaItemTitle, parentTitle: snapshot.mediaItemParentTitle });
  if (snapshot.mediaItemSeasonNumber == null && snapshot.mediaItemEpisodeNumber == null) return show;
  return formatEpisodeTitle({
    parentTitle: show,
    seasonNumber: snapshot.mediaItemSeasonNumber,
    episodeNumber: snapshot.mediaItemEpisodeNumber,
  });
}
