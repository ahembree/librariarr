"use client";

import {
  type Rule,
  type RuleGroup,
  type RuleField,
  type RuleCondition,
  type StreamQueryStreamType,
  RULE_FIELDS,
  RULE_OPERATORS,
  FIELD_SECTIONS,
  STREAM_QUERY_FIELDS,
  STREAM_QUERY_SECTIONS,
  ARR_FIELDS,
  SEERR_FIELDS,
  isSeriesAggregateField,
  getStreamQueryFieldsForType,
} from "@/lib/rules/types";
import { generateId } from "@/lib/utils";
import { BaseBuilder } from "./builder/base-builder";
import type { BuilderConfig, FieldContext } from "./builder/types";
import {
  countAllRules as _countAllRules,
  validateAllRules as _validateAllRules,
} from "./builder/tree-utils";

// ─── Re-exports for backward compatibility ──────────────────────────────────

export function countAllRules(groups: RuleGroup[]): number {
  return _countAllRules(groups);
}

export function validateAllRules(groups: RuleGroup[]): boolean {
  return _validateAllRules(
    groups,
    (field) =>
      RULE_FIELDS.find((f) => f.value === field)?.type
      ?? STREAM_QUERY_FIELDS.find((f) => f.value === field)?.type
      ?? "text",
    (op) => op === "isNull" || op === "isNotNull",
  );
}

// ─── Config ─────────────────────────────────────────────────────────────────

function createRule(): Rule {
  return {
    id: generateId(),
    field: "playCount" as RuleField,
    operator: "equals",
    value: "",
    condition: "OR" as RuleCondition,
  };
}

export const ruleBuilderConfig: BuilderConfig<Rule, RuleGroup> = {
  fields: RULE_FIELDS,
  operators: RULE_OPERATORS,
  sections: FIELD_SECTIONS,

  createRule,
  createGroup: (condition: RuleCondition = "AND") => ({
    id: generateId(),
    condition,
    rules: [createRule()],
    groups: [],
  }),

  isFieldDisabled: (field, ctx) => {
    if (ARR_FIELDS.includes(field as RuleField) && ctx.arrConnected === false)
      return true;
    if (
      SEERR_FIELDS.includes(field as RuleField) &&
      ctx.seerrConnected === false
    )
      return true;
    if (
      isSeriesAggregateField(field as RuleField) &&
      ctx.libraryType !== "SERIES"
    )
      return true;
    if (
      (field === "arrTmdbRating" || field === "arrRtCriticRating") &&
      ctx.libraryType === "MUSIC"
    )
      return true;
    return false;
  },

  getDisabledTooltip: (field, ctx) => {
    if (ARR_FIELDS.includes(field as RuleField) && ctx.arrConnected === false)
      return "Select an Arr server above to use Arr criteria";
    if (
      SEERR_FIELDS.includes(field as RuleField) &&
      ctx.seerrConnected === false
    )
      return "Configure a Seerr instance in Settings to use Seerr criteria";
    if (
      isSeriesAggregateField(field as RuleField) &&
      ctx.libraryType !== "SERIES"
    )
      return "Series criteria are only available for series lifecycle rules";
    if (
      (field === "arrTmdbRating" || field === "arrRtCriticRating") &&
      ctx.libraryType === "MUSIC"
    )
      return "TMDB and RT ratings are not available for music";
    return null;
  },

  isValuelessOperator: (op) => op === "isNull" || op === "isNotNull",

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
  createStreamQueryGroup: (streamType, condition: RuleCondition = "AND") => {
    const sqFields = getStreamQueryFieldsForType(streamType as StreamQueryStreamType);
    const defaultField = sqFields.length > 0 ? sqFields[0].value : "sqCodec";
    return {
      id: generateId(),
      condition,
      rules: [{
        id: generateId(),
        field: defaultField as RuleField,
        operator: "equals" as const,
        value: "",
        condition: "AND" as RuleCondition,
      }],
      groups: [],
      streamQuery: { streamType: streamType as StreamQueryStreamType },
    };
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

interface RuleBuilderProps {
  groups: RuleGroup[];
  onChange: (groups: RuleGroup[]) => void;
  distinctValues?: Record<string, string[]>;
  arrConnected?: boolean;
  seerrConnected?: boolean;
  libraryType?: "MOVIE" | "SERIES" | "MUSIC";
}

export function RuleBuilder({
  groups,
  onChange,
  distinctValues,
  arrConnected,
  seerrConnected,
  libraryType,
}: RuleBuilderProps) {
  const fieldContext: FieldContext = { arrConnected, seerrConnected, libraryType };
  return (
    <BaseBuilder<Rule, RuleGroup>
      groups={groups}
      onChange={onChange}
      distinctValues={distinctValues}
      config={ruleBuilderConfig}
      fieldContext={fieldContext}
    />
  );
}
