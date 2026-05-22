"use client";

import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CONDITION_SECTIONS,
  STREAM_QUERY_FIELDS,
  STREAM_QUERY_SECTIONS,
  getStreamQueryFieldsForType,
  getConditionField,
  type Condition,
  type ConditionGroup,
  type ConditionLogic,
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
export type LifecycleRule = Condition;
export type LifecycleRuleGroup = ConditionGroup;

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

  isValuelessOperator: (op) => op === "isNull" || op === "isNotNull",

  getFieldUnreachableTooltip: (field, ctx) => {
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
    if (sectionKey === "series" && ctx.libraryType !== "SERIES") return true;
    return false;
  },

  // Stream query support
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
}: RuleBuilderProps) {
  const fieldContext: FieldContext = {
    arrConnected,
    arrUnreachable,
    arrAvailableForLibrary,
    seerrConnected,
    seerrUnreachable,
    libraryType,
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
