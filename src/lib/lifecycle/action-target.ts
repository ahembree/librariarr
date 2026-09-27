// Client-safe (no server imports).
import { actionHonorsMemberIds } from "@/lib/lifecycle/action-types";
import { formatEpisodeTitle, seriesTitleOf, type MediaTitleParts } from "@/lib/media/display-title";

export interface ActionTargetParts {
  actionType: string;
  /** The episodes a member-scoped action acts on. */
  matchedMediaItemIds?: readonly string[] | null;
  mediaItem: MediaTitleParts & { id: string; title: string; parentTitle: string | null };
}

function isSeriesAction(action: ActionTargetParts): boolean {
  return action.mediaItem.type === "SERIES" || action.actionType.endsWith("_SONARR");
}

/** Whether a series action acts on exactly one episode: the one it is stored against. */
function targetsOneEpisode(action: ActionTargetParts): boolean {
  const members = action.matchedMediaItemIds ?? [];
  return actionHonorsMemberIds(action.actionType) && members.length === 1 && members[0] === action.mediaItem.id;
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
  return targetsOneEpisode(action) ? formatEpisodeTitle(item) : seriesTitleOf(item);
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
  const one = targetsOneEpisode(action);
  return {
    mediaItemTitle: seriesTitleOf(item),
    mediaItemParentTitle: null,
    mediaItemSeasonNumber: one ? (item.seasonNumber ?? null) : null,
    mediaItemEpisodeNumber: one ? (item.episodeNumber ?? null) : null,
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
