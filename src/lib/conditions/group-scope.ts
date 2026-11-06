/**
 * The rule: a criterion whose value belongs to one episode or one track must
 * never be able to make a whole show or a whole artist the target of an
 * action. A Series or Music rule set reaches a whole show or artist in two
 * ways, and each has its own list of criteria it may not use:
 *
 *  - **Group judgement** — "Match against entire series" on (a SERIES rule
 *    set's `seriesScope`) or "Match against entire artist" on (a MUSIC rule
 *    set's): every rule is evaluated against the whole show or artist, which
 *    matches through ANY of its members (`matchGroupThroughMembers`), and its
 *    action covers all of it. "Resolution = 4K" then matches a show with a
 *    single 4K episode, and a whole-series delete takes every 1080p episode
 *    with it. Not allowed: every field whose value the sync stores per episode
 *    or track without guaranteeing the show's or artist's members agree
 *    (`GROUP_SCOPE_BLOCKED_FIELDS`). What stays is what the group answers as a
 *    whole — its name, play total, latest play, earliest addition, summed size,
 *    watchers, the series aggregates, every Arr and Seerr field, and, for a
 *    show, its external ids — and the cross-system fields, which the group
 *    answers through EVERY member (`isEveryMemberField`): it matches only when
 *    the rule holds for each member's own value, so none decides for the rest.
 *  - **Member judgement** — the scope off, so each episode or track is judged
 *    on its own, with an armed action that nevertheless acts on the whole Arr
 *    record (`WHOLE_RECORD_ACTION_TYPES`, Arr tags, a Lidarr file delete's
 *    artist search): the show or artist is acted on whole when one member
 *    matches. Not allowed: every field that is that member's own, which is
 *    every field but the few every member of a show or artist answers alike
 *    (`isMemberConstantField`: its name, the series aggregates, Arr and Seerr,
 *    a show's external ids).
 *
 * With the scope off and an action that acts only on the matched members
 * (Delete Files Only, a Series rule set's episode-scoped Unmonitor or Search,
 * Do Nothing without tags), nothing is restricted, and movies have no scope.
 *
 * `groupScopeViolation(type, seriesScope, rules, action)` is the one predicate:
 *
 *  - every route that creates or updates a rule set refuses a violation
 *    (`ruleSetCreateSchema`, `ruleSetScopeError` in validation.ts);
 *  - the rule editor disables the criteria, and the actions, that would make
 *    one, and offers the valid ways out;
 *  - a rule set already holding one (saved before this rule, or restored from
 *    a backup) is skipped by detection (`checkLifecycleRuleEvaluability`) and
 *    its actions are held (`actionHoldOf`, held-actions.ts) until it is edited;
 *  - the group-scope engines refuse to evaluate a group-judgement violation
 *    (`evaluateSeriesScope`, `evaluateMusicScope`).
 *
 * The check covers a rule set's rules whether enabled or disabled, at any
 * depth: a disabled criterion is one click from being evaluated.
 *
 * Client-safe, and free of path aliases: the docs build's rule-set library
 * check (scripts/rule-set-library-check.ts) imports it.
 */
import { getConditionField } from "./fields";
import { isStreamQueryField } from "./stream-query";
import { MUSIC_ACTION_TYPES, SERIES_ACTION_TYPES } from "../lifecycle/action-types";

/** The library types with a whole-show / whole-artist scope. */
export type GroupScopeType = "SERIES" | "MUSIC";

/**
 * How a rule set's rules reach the show or artist its action acts on:
 * `group` — the scope on, each show or artist judged as a whole; `member` —
 * the scope off, each episode or track judged on its own, under an action
 * that acts on its whole show or artist.
 */
export type GroupJudgement = "group" | "member";

// ─── Criteria ────────────────────────────────────────────────────────────

/**
 * Fields whose value belongs to one file or one episode/track by nature: the
 * media's own properties, the item's own year, release date and ratings, a
 * track's album.
 */
const PER_FILE_OR_ITEM_FIELDS = [
  // Video
  "resolution",
  "videoCodec",
  "videoProfile",
  "dynamicRange",
  "videoBitDepth",
  "videoBitrate",
  "videoFrameRate",
  "aspectRatio",
  "scanType",
  // Audio
  "audioCodec",
  "audioProfile",
  "audioChannels",
  "audioSamplingRate",
  "audioBitrate",
  // File
  "container",
  "duration",
  // Streams (a show's or artist's union of its members' streams, which one
  // member's file decides)
  "audioLanguage",
  "subtitleLanguage",
  "streamAudioCodec",
  "audioStreamCount",
  "subtitleStreamCount",
  // Per-item metadata. `originallyAvailableAt` is the item's own release date;
  // the Arr release and air dates describe the series and stay allowed.
  "year",
  "originallyAvailableAt",
  "rating",
  "audienceRating",
  "ratingCount",
  "albumTitle",
] as const;

/**
 * Content metadata the sync stores per episode or track and never copies from
 * the show or artist for every member, so the members of one show or artist
 * can disagree — and a group matches through any one of them:
 *
 *  - Genre: an episode keeps its own genres and takes the show's only when it
 *    has none (`buildItemData` in sync-server.ts, and the incremental sync), on
 *    every server type; a track keeps its own, with no artist fallback.
 *  - Studio and Content Rating: each item's own (Plex's `studio` and
 *    `contentRating`; Jellyfin's and Emby's `Studios[0]` and `OfficialRating`).
 *  - Label, Country: each item's own Plex tags (Jellyfin and Emby store none).
 *  - Is Watchlisted: Jellyfin's and Emby's per-item favourite flag; on Plex,
 *    the watchlist matched by each item's ids, kept from the stored row when
 *    the watchlist is unavailable and never read by the incremental sync, so a
 *    newly added episode reads false beside watchlisted siblings.
 */
const PER_MEMBER_METADATA_FIELDS = ["genre", "studio", "labels", "contentRating", "country", "isWatchlisted"] as const;

/**
 * The fields a rule judging whole shows or artists (group judgement) may not
 * use, per library type. `tests/unit/conditions/group-scope.test.ts`
 * classifies every field of `CONDITION_FIELDS` for each type, so a new field
 * has to be placed deliberately.
 *
 * Has External ID differs: every episode stores its show's ids (the sync
 * persists series-level ids only, or none), so a show answers it alike, while
 * a track carries its own recording id beside its artist's, and an artist's
 * tracks need not all carry the artist's id.
 */
export const GROUP_SCOPE_BLOCKED_FIELDS: Readonly<Record<GroupScopeType, ReadonlySet<string>>> = {
  SERIES: new Set<string>([...PER_FILE_OR_ITEM_FIELDS, ...PER_MEMBER_METADATA_FIELDS]),
  MUSIC: new Set<string>([...PER_FILE_OR_ITEM_FIELDS, ...PER_MEMBER_METADATA_FIELDS, "hasExternalId"]),
};

/**
 * The fields every episode of a show, or every track of an artist, answers
 * alike while each is judged on its own (member judgement): the show's or
 * artist's name, a show's ids (see above), the series aggregates (injected as
 * show-level constants), and the Arr and Seerr fields (one record per show or
 * artist). Everything else — its title, play count, last play, size, watchers,
 * cross-system values, and every per-item field — is the member's own.
 */
const MEMBER_CONSTANT_FIELDS: Readonly<Record<GroupScopeType, ReadonlySet<string>>> = {
  SERIES: new Set(["parentTitle", "hasExternalId"]),
  MUSIC: new Set(["parentTitle"]),
};

function isMemberConstantField(field: string, type: GroupScopeType): boolean {
  if (MEMBER_CONSTANT_FIELDS[type].has(field)) return true;
  const def = getConditionField(field);
  return !!def && (!!def.requiresArr || !!def.requiresSeerr || !!def.isSeriesAggregate);
}

/**
 * Whether a rule set of `type` judging this way may not use `field`. A
 * stream-query field (`sq*`, one stream's property) is blocked wherever it
 * appears, as its group is.
 */
export function isBlockedAtGroupScope(
  field: string,
  type: GroupScopeType,
  judgement: GroupJudgement = "group",
): boolean {
  if (isStreamQueryField(field)) return true;
  return judgement === "group"
    ? GROUP_SCOPE_BLOCKED_FIELDS[type].has(field)
    : !isMemberConstantField(field, type);
}

/**
 * Whether a rule set of `type` with this `seriesScope` judges whole shows or
 * artists. Callers resolve their own default for an absent `seriesScope`
 * first: a stored rule set always has one, and creation defaults it to true.
 */
export function isGroupScope(type: string, seriesScope: boolean): type is GroupScopeType {
  return seriesScope && (type === "SERIES" || type === "MUSIC");
}

/** The criteria a rule tree holds that a rule set may not use. */
export interface GroupScopeBlockedCriteria {
  /** The blocked fields' ids, distinct, in tree order. */
  fields: string[];
  /** Whether the tree holds a stream query group. */
  streamQuery: boolean;
}

/**
 * The blocked criteria in a rule tree — flat (legacy) or grouped, enabled or
 * disabled, at any depth — or null when it holds none. An object with a
 * `rules` array is a group (its `streamQuery` makes it a stream query group);
 * an object with a string `field` is a rule, as `validateRuleStructure` reads
 * them.
 */
export function findGroupScopeBlockedCriteria(
  rules: unknown,
  type: GroupScopeType,
  judgement: GroupJudgement = "group",
): GroupScopeBlockedCriteria | null {
  const fields = new Set<string>();
  let streamQuery = false;
  const walk = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (Array.isArray(obj.rules)) {
        if (obj.streamQuery) streamQuery = true;
        walk(obj.rules);
        walk(obj.groups);
      } else if (typeof obj.field === "string") {
        if (isStreamQueryField(obj.field)) streamQuery = true;
        else if (isBlockedAtGroupScope(obj.field, type, judgement)) fields.add(obj.field);
      }
    }
  };
  walk(rules);
  return fields.size > 0 || streamQuery ? { fields: [...fields], streamQuery } : null;
}

// ─── Actions ─────────────────────────────────────────────────────────────

/**
 * The action types that act on the whole Sonarr series or Lidarr artist
 * whatever members matched (`src/lib/lifecycle/actions.ts`):
 *
 *  - Delete from Sonarr / Lidarr: `deleteSeries` / `deleteArtist`.
 *  - Unmonitor & Delete Files: unmonitors the series or artist, then deletes
 *    the matched files (and, for Lidarr, searches the whole artist).
 *  - Monitor & Delete Files: monitors the series or artist when it was not,
 *    then deletes the matched files (Lidarr: searches the whole artist).
 *  - Change Quality Profile: the series' or artist's profile.
 *  - Lidarr's Unmonitor Only and Search for New Copy: the artist (Lidarr has
 *    no per-track form).
 *
 * Not listed, because they act only on the matched members: Delete Files
 * Only (Sonarr deletes and searches the matched episodes by id; Lidarr's
 * search after is the one exception, `wholeRecordActionOf`), Sonarr's
 * Unmonitor Only and Search for New Copy with series scope off (they act on
 * the matched episodes, `ruleSetActsOnEpisodes`; with it on the group
 * judgement applies anyway), and Do Nothing. Arr tags, set on any action,
 * are applied to the whole record (`wholeRecordActionOf`).
 */
export const WHOLE_RECORD_ACTION_TYPES: Readonly<Record<GroupScopeType, ReadonlySet<string>>> = {
  SERIES: new Set([
    "DELETE_SONARR",
    "UNMONITOR_DELETE_FILES_SONARR",
    "MONITOR_DELETE_FILES_SONARR",
    "CHANGE_QUALITY_PROFILE_SONARR",
  ]),
  MUSIC: new Set([
    "DELETE_LIDARR",
    "UNMONITOR_DELETE_FILES_LIDARR",
    "MONITOR_DELETE_FILES_LIDARR",
    "CHANGE_QUALITY_PROFILE_LIDARR",
    "UNMONITOR_LIDARR",
    "SEARCH_LIDARR",
  ]),
};

/**
 * A rule set's action as far as whether it acts on a whole show or artist:
 * the rule set's own configuration, or a scheduled action's snapshot of it.
 */
export interface GroupScopeAction {
  /** Whether the action is turned on; absent or null reads as on (a scheduled action). */
  actionEnabled?: boolean | null;
  actionType?: string | null;
  addArrTags?: readonly string[] | null;
  removeArrTags?: readonly string[] | null;
  searchAfterAction?: boolean | null;
}

const ACTION_LABELS: Record<GroupScopeType, Map<string, string>> = {
  SERIES: new Map(SERIES_ACTION_TYPES.map((a) => [a.value, a.label])),
  MUSIC: new Map(MUSIC_ACTION_TYPES.map((a) => [a.value, a.label])),
};

/** The name of an action type in the rule editor's picker. */
function actionLabel(type: GroupScopeType, actionType: string): string {
  return ACTION_LABELS[type].get(actionType) ?? actionType;
}

/**
 * Whether the action type acts on the whole series or artist on its own,
 * whatever else the action is configured with (`WHOLE_RECORD_ACTION_TYPES`).
 */
export function isWholeRecordActionType(type: GroupScopeType, actionType: string | null | undefined): boolean {
  return !!actionType && WHOLE_RECORD_ACTION_TYPES[type].has(actionType);
}

/**
 * What makes an armed action act on the whole show or artist, named as the
 * rule editor names it — its type, its Arr tags, or a Lidarr file delete's
 * search after — or null when it acts only on the matched members, or is not
 * armed (turned off, or nothing configured).
 */
export function wholeRecordActionOf(type: string, action: GroupScopeAction | null | undefined): string | null {
  if (type !== "SERIES" && type !== "MUSIC") return null;
  if (!action || action.actionEnabled === false) return null;
  const tagged = (action.addArrTags?.length ?? 0) > 0 || (action.removeArrTags?.length ?? 0) > 0;
  if (!action.actionType && !tagged) return null;
  if (isWholeRecordActionType(type, action.actionType)) return actionLabel(type, action.actionType!);
  if (tagged) return "Arr tags";
  if (type === "MUSIC" && action.actionType === "DELETE_FILES_LIDARR" && action.searchAfterAction) {
    return `${actionLabel(type, action.actionType)} with Search after`;
  }
  return null;
}

// ─── The predicate ───────────────────────────────────────────────────────

/** A rule set judging, or acting on, whole shows or artists on criteria it may not use. */
export interface GroupScopeViolation extends GroupScopeBlockedCriteria {
  type: GroupScopeType;
  judgement: GroupJudgement;
  /**
   * The armed action's part that acts on the whole show or artist
   * (`wholeRecordActionOf`), or null. Always set for a member judgement.
   */
  wholeRecordAction: string | null;
  /**
   * Member judgement only: whether turning the scope on resolves it — every
   * blocked criterion is one the whole show or artist answers itself.
   */
  scopeOnResolves: boolean;
}

/**
 * Why a rule set as it would be saved, evaluated or run is not allowed, or
 * null: its scope is on and its rules hold criteria a whole-show or
 * whole-artist rule may not use, or its scope is off and its armed action
 * acts on the whole show or artist while its rules hold criteria of one
 * member. Null for a movie rule set, or with nothing blocked. The one
 * predicate every save, skip and hold reads.
 *
 * `action` is the rule set's action configuration (or a scheduled action's
 * own); left out, only the scope is judged.
 */
export function groupScopeViolation(
  type: string,
  seriesScope: boolean,
  rules: unknown,
  action?: GroupScopeAction | null,
): GroupScopeViolation | null {
  if (type !== "SERIES" && type !== "MUSIC") return null;
  const wholeRecordAction = wholeRecordActionOf(type, action);
  if (seriesScope) {
    const blocked = findGroupScopeBlockedCriteria(rules, type, "group");
    return blocked ? { type, judgement: "group", wholeRecordAction, scopeOnResolves: false, ...blocked } : null;
  }
  if (!wholeRecordAction) return null;
  const blocked = findGroupScopeBlockedCriteria(rules, type, "member");
  if (!blocked) return null;
  return {
    type,
    judgement: "member",
    wholeRecordAction,
    scopeOnResolves: findGroupScopeBlockedCriteria(rules, type, "group") === null,
    ...blocked,
  };
}

/**
 * Why choosing `actionType` would make the rule set a violation when the rest
 * of its action does not (the rule editor disables it in the picker), or null.
 * With the scope on the scope decides, whatever the action.
 */
export function wholeRecordActionBlockedBy(
  type: string,
  seriesScope: boolean,
  rules: unknown,
  actionType: string,
): GroupScopeBlockedCriteria | null {
  if (type !== "SERIES" && type !== "MUSIC") return null;
  if (seriesScope || !isWholeRecordActionType(type, actionType)) return null;
  return findGroupScopeBlockedCriteria(rules, type, "member");
}

// ─── Words ───────────────────────────────────────────────────────────────

/** The label of a stream query group in the lists below (the builder's button). */
export const STREAM_QUERY_LABEL = "Stream Query";

/** The blocked criteria as the rule editor names them. */
export function groupScopeBlockedLabels(blocked: GroupScopeBlockedCriteria): string[] {
  const labels = blocked.fields.map((field) => getConditionField(field)?.label ?? field);
  if (blocked.streamQuery) labels.push(STREAM_QUERY_LABEL);
  return labels;
}

/** How each scope is named in the editor and in messages. */
export const GROUP_SCOPE_TERMS: Record<GroupScopeType, {
  /** The switch's label in the rule editor. */
  toggle: string;
  /** The scope, as the rules list's chip names it. */
  scope: string;
  /** What the rule set judges. */
  group: string;
  /** One member of it. */
  member: string;
  /** The actions that act only on the matched members, as the picker names them. */
  memberActions: string;
}> = {
  SERIES: {
    toggle: "Match against entire series",
    scope: "series scope",
    group: "show",
    member: "episode",
    memberActions: "Delete Files Only, Unmonitor Only or Search for New Copy, without Arr tags",
  },
  MUSIC: {
    toggle: "Match against entire artist",
    scope: "artist scope",
    group: "artist",
    member: "track",
    memberActions: "Delete Files Only, without Search after or Arr tags",
  },
};

/** The message a refused save answers with (a 400's validation detail). */
export function groupScopeSaveError(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  const labels = groupScopeBlockedLabels(violation).join(", ");
  if (violation.judgement === "member") {
    return (
      `"${violation.wholeRecordAction}" acts on the whole ${t.group}, so with "${t.toggle}" off it can't follow criteria ` +
      `that describe one ${t.member} or file: ${labels} — one ${t.member} would decide for the whole ${t.group}. ` +
      `Remove them, or switch to an action that acts only on the matched ${t.member}s (${t.memberActions})` +
      (violation.scopeOnResolves ? `, or turn "${t.toggle}" on to judge the whole ${t.group}.` : ".")
    );
  }
  const head =
    `With "${t.toggle}" on, a rule judges a whole ${t.group}, so it can't use criteria that describe one ` +
    `${t.member} or file: ${labels}.`;
  return violation.wholeRecordAction
    ? `${head} Remove them, or turn "${t.toggle}" off and switch to an action that acts only on the matched ` +
        `${t.member}s (${t.memberActions}) — "${violation.wholeRecordAction}" acts on the whole ${t.group}.`
    : `${head} Turn "${t.toggle}" off to check them per ${t.member}, or remove them.`;
}

/**
 * Why detection skips such a rule set, and why its actions are held: the
 * reason the rules list, the run summary, the logs, Preview, Test Media, the
 * Pending page and every refused execution show.
 */
export function groupScopeHoldReason(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  const labels = groupScopeBlockedLabels(violation).join(", ");
  if (violation.judgement === "member") {
    return (
      `This rule set's action ("${violation.wholeRecordAction}") acts on the whole ${t.group} but follows per-${t.member} ` +
      `criteria (${labels}) with ${t.scope} off, which would let one ${t.member} decide for the whole ${t.group}. It is ` +
      `not evaluated and its actions are held until it is edited: remove those criteria or switch to an action that ` +
      `acts only on the matched ${t.member}s` +
      (violation.scopeOnResolves ? `, or turn ${t.scope} on.` : ".")
    );
  }
  const head =
    `This rule set uses per-${t.member} criteria (${labels}) with "${t.toggle}" on, which would judge a whole ` +
    `${t.group} by one ${t.member}. It is not evaluated and its actions are held until it is edited: `;
  return violation.wholeRecordAction
    ? `${head}remove those criteria, or turn ${t.scope} off and switch to an action that acts only on the matched ${t.member}s.`
    : `${head}turn ${t.scope} off or remove those criteria.`;
}
