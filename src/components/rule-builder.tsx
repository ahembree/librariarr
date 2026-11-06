"use client";

import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CONDITION_SECTIONS,
  STREAM_QUERY_FIELDS,
  STREAM_QUERY_SECTIONS,
  getStreamQueryFieldsForType,
  getConditionField,
  isValuelessOperator,
  isBlockedAtGroupScope,
  wholeRecordActionOf,
  GROUP_SCOPE_TERMS,
  type Condition,
  type ConditionGroup,
  type ConditionLogic,
  type GroupScopeAction,
  type GroupScopeType,
  type LibraryType,
  type StreamQueryStreamType,
} from "@/lib/conditions";
import { generateId } from "@/lib/utils";
import { BaseBuilder } from "./builder/base-builder";
import type { BuilderConfig, FieldContext } from "./builder/types";
import {
  countAllRules as _countAllRules,
  validateAllRules as _validateAllRules,
} from "./builder/tree-utils";

// Backward-compat type aliases for existing callers
type LifecycleRule = Condition;
type LifecycleRuleGroup = ConditionGroup;

// ─── Re-exports for backward compatibility ──────────────────────────────────

export function countAllRules(groups: LifecycleRuleGroup[]): number {
  return _countAllRules(groups);
}

export function validateAllRules(groups: LifecycleRuleGroup[]): boolean {
  return _validateAllRules(
    groups,
    (field) =>
      CONDITION_FIELDS.find((f) => f.value === field)?.type
      ?? STREAM_QUERY_FIELDS.find((f) => f.value === field)?.type
      ?? "text",
    (op) => op === "isNull" || op === "isNotNull",
  );
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** The builder's gate (`FieldContext.groupScope`), or null when nothing is gated. */
type BuilderGate = NonNullable<FieldContext["groupScope"]>;

/**
 * The gate while a criterion of one episode or track could make a whole show
 * or artist the action's target (`FieldContext.groupScope`): such criteria
 * are not allowed then (`isBlockedAtGroupScope`, src/lib/conditions/group-scope.ts).
 */
function groupScopeOf(ctx: FieldContext): BuilderGate | null {
  const gate = ctx.groupScope;
  return gate && (gate.type === "SERIES" || gate.type === "MUSIC") ? gate : null;
}

function isGatedField(field: string, gate: BuilderGate | null): boolean {
  return !!gate && isBlockedAtGroupScope(field, gate.type, gate.judgement);
}

/**
 * Why a criterion is not offered and what would let it be used: `what` says
 * what it reads ("Describes one episode"), `object` is "it" or "them", and
 * `scopeOnAllows` whether the whole show or artist answers it itself (turning
 * the scope on would then do).
 */
function gateReason(gate: BuilderGate, what: string, object: string, scopeOnAllows: boolean, notWhole: boolean): string {
  const t = GROUP_SCOPE_TERMS[gate.type];
  const memberAction = `pick an action that acts only on the matched ${t.member}s`;
  if (gate.judgement === "member") {
    return scopeOnAllows
      ? `${what}, and "${gate.wholeRecordAction}" acts on the whole ${t.group} — turn on "${t.toggle}" to judge the whole ${t.group} by ${object}, or ${memberAction}`
      : `${what}, and "${gate.wholeRecordAction}" acts on the whole ${t.group} — ${memberAction} to use ${object}`;
  }
  const head = notWhole ? `${what}, not the whole ${t.group}` : what;
  return gate.wholeRecordAction
    ? `${head} — turn off "${t.toggle}" and ${memberAction} to use ${object}`
    : `${head} — turn off "${t.toggle}" to use ${object}`;
}

function groupScopeFieldTooltip(field: string, gate: BuilderGate): string {
  return gateReason(
    gate,
    `Describes one ${GROUP_SCOPE_TERMS[gate.type].member}`,
    "it",
    !isBlockedAtGroupScope(field, gate.type, "group"),
    true,
  );
}

function createRule(): LifecycleRule {
  return {
    id: generateId(),
    field: "title",
    operator: "contains",
    value: "",
    condition: "OR" as ConditionLogic,
  };
}

export const ruleBuilderConfig: BuilderConfig<LifecycleRule, LifecycleRuleGroup> = {
  fields: CONDITION_FIELDS,
  operators: CONDITION_OPERATORS,
  sections: CONDITION_SECTIONS,

  createRule,
  createGroup: (condition: ConditionLogic = "AND") => ({
    id: generateId(),
    condition,
    rules: [createRule()],
    groups: [],
  }),

  isFieldDisabled: (field, ctx) => {
    if (isGatedField(field, groupScopeOf(ctx))) return true;
    const def = getConditionField(field);
    if (!def) return false;
    if (def.requiresArr && ctx.arrConnected === false) return true;
    if (def.requiresSeerr && ctx.seerrConnected === false) return true;
    if (def.isSeriesAggregate && ctx.libraryType !== "SERIES") return true;
    if (def.invalidForLibraryType && ctx.libraryType
      && def.invalidForLibraryType.includes(ctx.libraryType as LibraryType)) {
      return true;
    }
    return false;
  },

  getDisabledTooltip: (field, ctx) => {
    const gate = groupScopeOf(ctx);
    if (gate && isGatedField(field, gate)) return groupScopeFieldTooltip(field, gate);
    const def = getConditionField(field);
    if (!def) return null;
    if (def.requiresArr && ctx.arrConnected === false)
      return ctx.arrAvailableForLibrary
        ? "Select an Arr server above to use Arr criteria"
        : "Configure an Arr integration in Settings to use Arr criteria";
    if (def.requiresSeerr && ctx.seerrConnected === false)
      return "Configure a Seerr instance in Settings to use Seerr criteria";
    if (def.isSeriesAggregate && ctx.libraryType !== "SERIES")
      return "Series criteria are only available for series lifecycle rules";
    if (def.invalidForLibraryType && ctx.libraryType
      && def.invalidForLibraryType.includes(ctx.libraryType as LibraryType)) {
      return `${def.label} is not available for ${String(ctx.libraryType).toLowerCase()}`;
    }
    return null;
  },

  isValuelessOperator,

  getFieldUnreachableTooltip: (field, ctx) => {
    // A rule already using a criterion the gate does not allow (a rule set
    // saved before the rule, an import, the scope just turned on or a
    // whole-show action just picked): marked on its row, beside the editor's
    // warning listing them all.
    const gate = groupScopeOf(ctx);
    if (gate && isGatedField(field, gate)) return groupScopeFieldTooltip(field, gate);
    const def = getConditionField(field);
    if (!def) return null;
    // arrUnreachable / seerrUnreachable mean "configured but currently
    // unreachable" — already gated on configuration in the hook. Don't
    // additionally require ctx.arrConnected (which is the rule-set's
    // selected instance, not the user's overall Arr presence).
    if (def.requiresArr && ctx.arrUnreachable)
      return "The configured Arr integration is currently unreachable. This rule won't evaluate correctly until connectivity is restored.";
    if (def.requiresSeerr && ctx.seerrUnreachable)
      return "The configured Seerr integration is currently unreachable. This rule won't evaluate correctly until connectivity is restored.";
    return null;
  },

  isSectionHidden: (sectionKey, ctx) => {
    if (sectionKey.startsWith("arr") && !ctx.arrConnected) return true;
    if (sectionKey === "seerr" && ctx.seerrConnected === undefined) return true;
    if ((sectionKey === "series" || sectionKey === "episode") && ctx.libraryType !== "SERIES") return true;
    return false;
  },

  // Stream query support
  getStreamQueryDisabledTooltip: (ctx) => {
    const gate = groupScopeOf(ctx);
    if (!gate) return null;
    const t = GROUP_SCOPE_TERMS[gate.type];
    const what = gate.type === "SERIES"
      ? `Stream queries read one ${t.member}'s tracks`
      : `Stream queries read one ${t.member}'s streams`;
    return gateReason(gate, what, "them", false, false);
  },
  streamQueryFields: STREAM_QUERY_FIELDS,
  streamQuerySections: STREAM_QUERY_SECTIONS,
  getStreamQueryFieldsForType: (streamType) =>
    getStreamQueryFieldsForType(streamType as StreamQueryStreamType),
  createStreamQueryGroup: (streamType, condition: ConditionLogic = "AND") => {
    const sqFields = getStreamQueryFieldsForType(streamType as StreamQueryStreamType);
    const defaultField = sqFields.length > 0 ? sqFields[0].value : "sqCodec";
    return {
      id: generateId(),
      condition,
      rules: [{
        id: generateId(),
        field: defaultField,
        operator: "equals",
        value: "",
        condition: "AND" as ConditionLogic,
      }],
      groups: [],
      streamQuery: { streamType: streamType as StreamQueryStreamType },
    };
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

interface RuleBuilderProps {
  groups: LifecycleRuleGroup[];
  onChange: (groups: LifecycleRuleGroup[]) => void;
  distinctValues?: Record<string, string[]>;
  arrConnected?: boolean;
  arrUnreachable?: boolean;
  /** True when the user has at least one Arr instance of the appropriate
   * type configured globally (regardless of whether one is selected for
   * this rule set). Controls Arr-missing tooltip wording. */
  arrAvailableForLibrary?: boolean;
  seerrConnected?: boolean;
  seerrUnreachable?: boolean;
  libraryType?: LibraryType;
  /**
   * The gate while a criterion of one episode or track could make a whole
   * show or artist the action's target (`groupScopeGateOf`), or null: the
   * criteria that judgement may not use and stream queries are then offered
   * disabled, with the reason.
   */
  groupScope?: BuilderGate | null;
}

/**
 * The builder's gate for a rule set's scope and action: with the scope on,
 * the group judgement; with it off, the member judgement while its armed
 * action acts on the whole show or artist; otherwise none.
 */
export function groupScopeGateOf(
  type: string,
  seriesScope: boolean,
  action: GroupScopeAction | null,
): BuilderGate | null {
  if (type !== "SERIES" && type !== "MUSIC") return null;
  const wholeRecordAction = wholeRecordActionOf(type, action);
  if (seriesScope) return { type: type as GroupScopeType, judgement: "group", wholeRecordAction };
  return wholeRecordAction ? { type: type as GroupScopeType, judgement: "member", wholeRecordAction } : null;
}

export function RuleBuilder({
  groups,
  onChange,
  distinctValues,
  arrConnected,
  arrUnreachable,
  arrAvailableForLibrary,
  seerrConnected,
  seerrUnreachable,
  libraryType,
  groupScope = null,
}: RuleBuilderProps) {
  const fieldContext: FieldContext = {
    arrConnected,
    arrUnreachable,
    arrAvailableForLibrary,
    seerrConnected,
    seerrUnreachable,
    libraryType,
    groupScope,
  };
  return (
    <BaseBuilder<LifecycleRule, LifecycleRuleGroup>
      groups={groups}
      onChange={onChange}
      distinctValues={distinctValues}
      config={ruleBuilderConfig}
      fieldContext={fieldContext}
    />
  );
}
