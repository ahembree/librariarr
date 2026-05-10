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

// Backward-compat type aliases
export type QueryRule = Condition;
export type QueryGroup = ConditionGroup;

// ─── Re-exports for backward compatibility ──────────────────────────────────

export function countAllRules(groups: QueryGroup[]): number {
  return _countAllRules(groups);
}

export function validateAllRules(groups: QueryGroup[]): boolean {
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

function createRule(): QueryRule {
  return {
    id: generateId(),
    field: "title",
    operator: "contains",
    value: "",
    condition: "OR" as ConditionLogic,
  };
}

/**
 * For query (multi-type), a field is invalid only when EVERY selected
 * media type is in the field's `invalidForLibraryType` list. If no
 * media types are selected (= "all"), treat as valid.
 */
function fieldInvalidForSelectedTypes(
  invalidFor: LibraryType[] | undefined,
  mediaTypes: LibraryType[] | undefined,
): boolean {
  if (!invalidFor || invalidFor.length === 0) return false;
  if (!mediaTypes || mediaTypes.length === 0) return false;
  return mediaTypes.every((t) => invalidFor.includes(t));
}

export const queryBuilderConfig: BuilderConfig<QueryRule, QueryGroup> = {
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
    if (def.isSeriesAggregate) {
      const seriesSelected = !ctx.mediaTypes
        || ctx.mediaTypes.length === 0
        || ctx.mediaTypes.includes("SERIES");
      if (!seriesSelected) return true;
      if (ctx.includeEpisodes) return true;
    }
    if (fieldInvalidForSelectedTypes(def.invalidForLibraryType, ctx.mediaTypes)) {
      return true;
    }
    return false;
  },

  getDisabledTooltip: (field, ctx) => {
    const def = getConditionField(field);
    if (!def) return null;
    if (def.requiresArr && ctx.arrConnected === false)
      return "Configure an Arr integration in Settings to use Arr criteria";
    if (def.requiresSeerr && ctx.seerrConnected === false)
      return "Configure a Seerr instance in Settings to use Seerr criteria";
    if (def.isSeriesAggregate) {
      const seriesSelected = !ctx.mediaTypes
        || ctx.mediaTypes.length === 0
        || ctx.mediaTypes.includes("SERIES");
      if (!seriesSelected) return "Select Series in media types to use series criteria";
      if (ctx.includeEpisodes) return "Series criteria are not available in episode mode";
    }
    if (fieldInvalidForSelectedTypes(def.invalidForLibraryType, ctx.mediaTypes)) {
      return `${def.label} is not available for the selected media types`;
    }
    return null;
  },

  isSectionHidden: (sectionKey, ctx) => {
    if (sectionKey.startsWith("arr") && !ctx.arrConnected) return true;
    if (sectionKey === "seerr" && ctx.seerrConnected === undefined) return true;
    if (sectionKey === "series") {
      const seriesSelected = !ctx.mediaTypes
        || ctx.mediaTypes.length === 0
        || ctx.mediaTypes.includes("SERIES");
      if (!seriesSelected || ctx.includeEpisodes) return true;
    }
    return false;
  },

  getFieldUnreachableTooltip: (field, ctx) => {
    const def = getConditionField(field);
    if (!def) return null;
    if (def.requiresArr && ctx.arrUnreachable)
      return "The configured Arr integration is currently unreachable. This rule won't evaluate correctly until connectivity is restored.";
    if (def.requiresSeerr && ctx.seerrUnreachable)
      return "The configured Seerr integration is currently unreachable. This rule won't evaluate correctly until connectivity is restored.";
    return null;
  },

  isValuelessOperator: (op) => op === "isNull" || op === "isNotNull",

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

interface QueryBuilderProps {
  groups: QueryGroup[];
  onChange: (groups: QueryGroup[]) => void;
  distinctValues?: Record<string, string[]>;
  arrConnected?: boolean;
  arrUnreachable?: boolean;
  seerrConnected?: boolean;
  seerrUnreachable?: boolean;
  mediaTypes?: LibraryType[];
  includeEpisodes?: boolean;
}

export function QueryBuilder({
  groups,
  onChange,
  distinctValues,
  arrConnected,
  arrUnreachable,
  seerrConnected,
  seerrUnreachable,
  mediaTypes,
  includeEpisodes,
}: QueryBuilderProps) {
  const fieldContext: FieldContext = {
    arrConnected,
    arrUnreachable,
    seerrConnected,
    seerrUnreachable,
    mediaTypes,
    includeEpisodes,
  };
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
