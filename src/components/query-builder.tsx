"use client";

import {
  type QueryRule,
  type QueryGroup,
  type RuleCondition,
  QUERY_FIELDS,
  QUERY_OPERATORS,
  QUERY_FIELD_SECTIONS,
  ARR_QUERY_FIELDS,
  SEERR_QUERY_FIELDS,
} from "@/lib/query/types";
import {
  STREAM_QUERY_FIELDS,
  STREAM_QUERY_SECTIONS,
  getStreamQueryFieldsForType,
  type StreamQueryStreamType,
} from "@/lib/rules/types";
import { generateId } from "@/lib/utils";
import { BaseBuilder } from "./builder/base-builder";
import type { BuilderConfig, FieldContext } from "./builder/types";
import {
  countAllRules as _countAllRules,
  validateAllRules as _validateAllRules,
} from "./builder/tree-utils";

// ─── Re-exports for backward compatibility ──────────────────────────────────

export function countAllRules(groups: QueryGroup[]): number {
  return _countAllRules(groups);
}

export function validateAllRules(groups: QueryGroup[]): boolean {
  return _validateAllRules(
    groups,
    (field) =>
      QUERY_FIELDS.find((f) => f.value === field)?.type
      ?? STREAM_QUERY_FIELDS.find((f) => f.value === field)?.type
      ?? "text",
    (op) => op === "isNull" || op === "isNotNull",
  );
}

// ─── Config ─────────────────────────────────────────────────────────────────

function createRule(): QueryRule {
  return {
    id: generateId(),
    field: "title",
    operator: "contains",
    value: "",
    condition: "OR" as RuleCondition,
  };
}

export const queryBuilderConfig: BuilderConfig<QueryRule, QueryGroup> = {
  fields: QUERY_FIELDS,
  operators: QUERY_OPERATORS,
  sections: QUERY_FIELD_SECTIONS,

  createRule,
  createGroup: (condition: RuleCondition = "AND") => ({
    id: generateId(),
    condition,
    rules: [createRule()],
    groups: [],
  }),

  isFieldDisabled: (field, ctx) => {
    if (ARR_QUERY_FIELDS.has(field) && ctx.arrConnected === false) return true;
    if (SEERR_QUERY_FIELDS.has(field) && ctx.seerrConnected === false)
      return true;
    return false;
  },

  getDisabledTooltip: (field, ctx) => {
    if (ARR_QUERY_FIELDS.has(field) && ctx.arrConnected === false)
      return "Configure an Arr integration in Settings to use Arr criteria";
    if (SEERR_QUERY_FIELDS.has(field) && ctx.seerrConnected === false)
      return "Configure a Seerr instance in Settings to use Seerr criteria";
    return null;
  },

  isSectionHidden: (sectionKey, ctx) => {
    if (sectionKey.startsWith("arr") && !ctx.arrConnected) return true;
    if (sectionKey === "seerr" && ctx.seerrConnected === undefined) return true;
    return false;
  },

  isValuelessOperator: (op) => op === "isNull" || op === "isNotNull",

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
        field: defaultField,
        operator: "equals",
        value: "",
        condition: "AND" as RuleCondition,
      }],
      groups: [],
      streamQuery: { streamType },
    };
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

interface QueryBuilderProps {
  groups: QueryGroup[];
  onChange: (groups: QueryGroup[]) => void;
  distinctValues?: Record<string, string[]>;
  arrConnected?: boolean;
  seerrConnected?: boolean;
}

export function QueryBuilder({
  groups,
  onChange,
  distinctValues,
  arrConnected,
  seerrConnected,
}: QueryBuilderProps) {
  const fieldContext: FieldContext = { arrConnected, seerrConnected };
  return (
    <BaseBuilder<QueryRule, QueryGroup>
      groups={groups}
      onChange={onChange}
      distinctValues={distinctValues}
      config={queryBuilderConfig}
      fieldContext={fieldContext}
    />
  );
}
