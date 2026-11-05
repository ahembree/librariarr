/**
 * Criteria a rule set may not use while it judges whole shows or artists.
 *
 * With "Match against entire series" on (a SERIES rule set's `seriesScope`)
 * or "Match against entire artist" on (a MUSIC rule set's), a rule is
 * evaluated against a whole show or artist and its action applies to the
 * whole show or artist. A criterion whose value belongs to one file or one
 * episode/track — Resolution, the codecs, Year, a stream query — then lets one
 * episode decide for the whole show: "Resolution = 4K" matches a show with a
 * single 4K episode, and a whole-series delete takes every 1080p episode with
 * it. Such criteria are therefore not allowed at that scope:
 *
 *  - every route that creates or updates a rule set refuses them
 *    (`ruleSetCreateSchema`, `ruleSetScopeError` in validation.ts);
 *  - the rule editor disables them while the scope is on and offers to turn
 *    the scope off;
 *  - a rule set already holding them (saved before this rule, or restored from
 *    a backup) is skipped by detection (`checkLifecycleRuleEvaluability`) and
 *    its actions are held (`actionHoldOf`, held-actions.ts) until it is edited;
 *  - the group-scope engines refuse to evaluate one (`evaluateSeriesScope`,
 *    `evaluateMusicScope`).
 *
 * With the scope off the same criteria are checked per episode or track, and
 * movies have no scope: neither is affected.
 *
 * Every other field stays allowed: what a group answers as a whole (its name,
 * play total, latest play, earliest addition, summed size, watchers, the
 * cross-system values, its external ids, the series aggregates, every Arr and
 * Seerr field), and the metadata the sync gives every episode from its show
 * (Genre, Studio, Country, Content Rating, Label, Is Watchlisted).
 *
 * The check covers a rule set's rules whether enabled or disabled, at any
 * depth: a disabled criterion is one click from being evaluated.
 *
 * Client-safe, and free of path aliases: the docs build's rule-set library
 * check (scripts/rule-set-library-check.ts) imports it.
 */
import { getConditionField } from "./fields";
import { isStreamQueryField } from "./stream-query";

/**
 * The fields whose value belongs to one file or one episode/track, by id.
 * `tests/unit/conditions/group-scope.test.ts` classifies every field of
 * `CONDITION_FIELDS`, so a new field has to be placed deliberately.
 */
export const GROUP_SCOPE_BLOCKED_FIELDS: ReadonlySet<string> = new Set([
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
  // Streams
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
]);

/**
 * Whether `field` may not be used while a rule set judges whole shows or
 * artists. A stream-query field (`sq*`, one stream's property) is blocked
 * wherever it appears, as its group is.
 */
export function isBlockedAtGroupScope(field: string): boolean {
  return GROUP_SCOPE_BLOCKED_FIELDS.has(field) || isStreamQueryField(field);
}

/** The library types with a whole-show / whole-artist scope. */
export type GroupScopeType = "SERIES" | "MUSIC";

/**
 * Whether a rule set of `type` with this `seriesScope` judges whole shows or
 * artists. Callers resolve their own default for an absent `seriesScope`
 * first: a stored rule set always has one, and creation defaults it to true.
 */
export function isGroupScope(type: string, seriesScope: boolean): type is GroupScopeType {
  return seriesScope && (type === "SERIES" || type === "MUSIC");
}

/** The criteria a rule tree holds that a whole-show or whole-artist rule may not use. */
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
export function findGroupScopeBlockedCriteria(rules: unknown): GroupScopeBlockedCriteria | null {
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
        else if (GROUP_SCOPE_BLOCKED_FIELDS.has(obj.field)) fields.add(obj.field);
      }
    }
  };
  walk(rules);
  return fields.size > 0 || streamQuery ? { fields: [...fields], streamQuery } : null;
}

/** A rule set judging whole shows or artists on criteria it may not use. */
export interface GroupScopeViolation extends GroupScopeBlockedCriteria {
  type: GroupScopeType;
}

/**
 * Why a rule set as it would be saved or evaluated is not allowed: its scope
 * is on and its rules hold blocked criteria. Null otherwise — scope off, a
 * movie rule set, or nothing blocked. The one predicate every save, skip and
 * hold reads.
 */
export function groupScopeViolation(
  type: string,
  seriesScope: boolean,
  rules: unknown,
): GroupScopeViolation | null {
  if (!isGroupScope(type, seriesScope)) return null;
  const blocked = findGroupScopeBlockedCriteria(rules);
  return blocked ? { type, ...blocked } : null;
}

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
}> = {
  SERIES: { toggle: "Match against entire series", scope: "series scope", group: "show", member: "episode" },
  MUSIC: { toggle: "Match against entire artist", scope: "artist scope", group: "artist", member: "track" },
};

/** The message a refused save answers with (a 400's validation detail). */
export function groupScopeSaveError(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  return (
    `With "${t.toggle}" on, a rule judges a whole ${t.group}, so it can't use criteria that describe one ` +
    `${t.member} or file: ${groupScopeBlockedLabels(violation).join(", ")}. Turn "${t.toggle}" off to check ` +
    `them per ${t.member}, or remove them.`
  );
}

/**
 * Why detection skips such a rule set, and why its actions are held: the
 * reason the rules list, the run summary, the logs, Preview, Test Media, the
 * Pending page and every refused execution show.
 */
export function groupScopeHoldReason(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  return (
    `This rule set uses per-${t.member} criteria (${groupScopeBlockedLabels(violation).join(", ")}) with ` +
    `"${t.toggle}" on, which would judge a whole ${t.group} by one ${t.member}. It is not evaluated and its ` +
    `actions are held until it is edited: turn ${t.scope} off or remove those criteria.`
  );
}
