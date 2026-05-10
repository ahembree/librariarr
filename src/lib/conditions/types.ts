/**
 * Shared condition / criterion types used by both the lifecycle rule builder
 * and the query builder. Both systems build nested AND/OR trees over media
 * items; the engines that evaluate them differ, but the shapes are identical.
 */

export type ConditionOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "contains"
  | "notContains"
  | "matchesWildcard"
  | "notMatchesWildcard"
  | "before"
  | "after"
  | "inLastDays"
  | "notInLastDays"
  | "isNull"
  | "isNotNull"
  | "between";

export type ConditionLogic = "AND" | "OR";

export type ConditionFieldType = "number" | "text" | "date" | "boolean";

export type LibraryType = "MOVIE" | "SERIES" | "MUSIC";

export type StreamQueryStreamType = "audio" | "video" | "subtitle";

export interface Condition {
  id: string;
  field: string;
  operator: string;
  value: string | number;
  condition: ConditionLogic;
  negate?: boolean;
  enabled?: boolean;
}

export interface ConditionGroup {
  id: string;
  name?: string;
  condition: ConditionLogic;
  /** Deprecated — per-rule conditions are used instead */
  operator?: ConditionLogic;
  rules: Condition[];
  groups: ConditionGroup[];
  enabled?: boolean;
  /** When set, this group is a stream query — rules apply to individual stream records */
  streamQuery?: {
    streamType: StreamQueryStreamType;
    /** "any" (default/EXISTS), "none" (NOT EXISTS), "all" (FORALL) */
    quantifier?: "any" | "none" | "all";
  };
}

export type ConditionSection =
  | "content"
  | "activity"
  | "video"
  | "audio"
  | "streams"
  | "file"
  | "cross"
  | "external"
  | "arrStatus"
  | "arrMedia"
  | "arrEpisodes"
  | "seerr"
  | "series"
  | "streamQuery";

export interface ConditionField {
  value: string;
  label: string;
  type: ConditionFieldType;
  section: ConditionSection;
  enumerable?: boolean;
  knownValues?: string[];
  /** Field requires an Arr (Sonarr/Radarr/Lidarr) connection. */
  requiresArr?: boolean;
  /** Field requires a Seerr (Overseerr/Jellyseerr) connection. */
  requiresSeerr?: boolean;
  /** Field aggregates across child episodes (only meaningful with SERIES context). */
  isSeriesAggregate?: boolean;
  /** Library types for which this field is invalid. */
  invalidForLibraryType?: LibraryType[];
}

export interface ConditionOperatorDef {
  value: ConditionOperator;
  label: string;
  /** Optional alternate label shown when the field is a date type */
  dateLabel?: string;
  types: ConditionFieldType[];
}

export interface ConditionSectionDef {
  key: ConditionSection;
  label: string;
}
