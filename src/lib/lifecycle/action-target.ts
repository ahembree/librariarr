// Client-safe (no server imports).
import { actionHonorsMemberIds } from "@/lib/lifecycle/action-types";
import {
  formatEpisodeTitle,
  seriesTitleOf,
  type EpisodeTitleParts,
  type MediaTitleParts,
} from "@/lib/media/display-title";

/** An episode as far as naming it goes: its own title and its SxxExx. */
export type MemberEpisode = Omit<EpisodeTitleParts, "parentTitle">;

export interface ActionTargetParts {
  actionType: string;
  /** The episodes a member-scoped action acts on. */
  matchedMediaItemIds?: readonly string[] | null;
  mediaItem: MediaTitleParts & { id: string; title: string; parentTitle: string | null; type: string };
  /**
   * Episodes by id, for naming an action on exactly one episode that is NOT
   * the item it is stored against (`loneMemberId`): a series match is stored
   * against the show's lowest-id episode, which need not be one it matched.
   * Without that episode here the action is named by its show.
   */
  memberEpisodes?: ReadonlyMap<string, MemberEpisode>;
}

/** What decides which episode, if any, an action acts on alone. */
export type MemberScope = Pick<ActionTargetParts, "actionType" | "matchedMediaItemIds"> & {
  mediaItem: { id: string; type: string } | null;
};

/** The one episode a series file delete acts on, when it acts on exactly one. */
function soleEpisodeId(action: MemberScope): string | null {
  const members = action.matchedMediaItemIds ?? [];
  if (action.mediaItem?.type !== "SERIES" || !actionHonorsMemberIds(action.actionType) || members.length !== 1) {
    return null;
  }
  return members[0];
}

/**
 * The episode an action must find in `memberEpisodes` to be named after it —
 * the one it acts on alone, when that is not its own item — else null.
 */
export function loneMemberId(action: MemberScope): string | null {
  const id = soleEpisodeId(action);
  return id !== action.mediaItem?.id ? id : null;
}

/** The one episode a series action acts on, when it acts on exactly one we know. */
function targetEpisode(action: ActionTargetParts): MemberEpisode | null {
  const id = soleEpisodeId(action);
  if (!id) return null;
  return id === action.mediaItem.id ? action.mediaItem : (action.memberEpisodes?.get(id) ?? null);
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
  if (item.type !== "SERIES") return item.title;
  const episode = targetEpisode(action);
  if (!episode) return seriesTitleOf(item);
  return formatEpisodeTitle({
    title: episode.title,
    parentTitle: item.parentTitle,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
  });
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
export function actionTitleSnapshot(action: ActionTargetParts): {
  mediaItemTitle: string;
  mediaItemParentTitle: string | null;
  mediaItemSeasonNumber?: number | null;
  mediaItemEpisodeNumber?: number | null;
} {
  const item = action.mediaItem;
  if (item.type !== "SERIES") return { mediaItemTitle: item.title, mediaItemParentTitle: item.parentTitle };
  const episode = targetEpisode(action);
  return {
    mediaItemTitle: seriesTitleOf(item),
    mediaItemParentTitle: null,
    mediaItemSeasonNumber: episode?.seasonNumber ?? null,
    mediaItemEpisodeNumber: episode?.episodeNumber ?? null,
  };
}

/**
 * A series action named from the snapshot `actionTitleSnapshot` recorded:
 * "<Show> SxxExx" when it acted on one episode, else the show. A snapshot from
 * before series actions recorded their show (title = the episode, parent = the
 * show) still yields the show.
 */
export function snapshotTargetTitle(snapshot: {
  mediaItemTitle: string | null;
  mediaItemParentTitle: string | null;
  mediaItemSeasonNumber?: number | null;
  mediaItemEpisodeNumber?: number | null;
}): string {
  return formatEpisodeTitle({
    parentTitle: seriesTitleOf({ title: snapshot.mediaItemTitle, parentTitle: snapshot.mediaItemParentTitle }),
    seasonNumber: snapshot.mediaItemSeasonNumber,
    episodeNumber: snapshot.mediaItemEpisodeNumber,
  });
}
