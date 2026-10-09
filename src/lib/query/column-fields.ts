import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import { CONDITION_SECTIONS } from "@/lib/conditions/sections";
import type { ConditionField } from "@/lib/conditions/types";
import { formatBytesNum } from "@/lib/format";

/**
 * Client-safe registry of the Query page's criterion columns. Every field a
 * query can filter on can be shown as a table column, except those the table
 * already has a fixed column for. Derived from CONDITION_FIELDS so a new
 * criterion becomes a column without another list to keep in step.
 */

export type QueryColumnValue = string | number | boolean | string[] | null;

/** Fields the Query table already shows through its own fixed columns. */
export const BUILTIN_COLUMN_FIELDS = new Set([
  "title", "year", "resolution", "videoCodec", "dynamicRange", "audioCodec",
  "audioProfile", "container", "fileSize", "duration", "playCount",
]);

export const QUERY_COLUMN_FIELD_DEFS: ConditionField[] = CONDITION_FIELDS.filter(
  (f) => !BUILTIN_COLUMN_FIELDS.has(f.value),
);

export const QUERY_COLUMN_FIELDS = new Set(QUERY_COLUMN_FIELD_DEFS.map((f) => f.value));

const SECTION_LABELS = new Map(CONDITION_SECTIONS.map((s) => [s.key, s.label]));

export function columnSectionLabel(section: string): string {
  return SECTION_LABELS.get(section as ConditionField["section"]) ?? section;
}

/**
 * Column header for a criterion. Arr fields reuse labels the library fields
 * also use ("Release Date", "Date Added"), so they are prefixed.
 */
export function columnHeader(def: ConditionField): string {
  if (def.requiresArr && !def.label.startsWith("Arr")) return `Arr ${def.label}`;
  return def.label;
}

/** Table column id for a criterion column. */
export function criterionColumnId(field: string): string {
  return `field:${field}`;
}

/** Byte-valued numeric fields (stored in bytes, filtered in MB). */
const BYTE_FIELDS = new Set(["arrSizeOnDisk"]);
const MINUTE_FIELDS = new Set(["arrRuntime"]);
const PERCENT_FIELDS = new Set(["watchedEpisodePercentage"]);

/** Display text for a criterion column cell ("-" for no value). */
export function formatColumnValue(def: ConditionField, value: QueryColumnValue | undefined): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (def.type === "date") {
    const d = new Date(String(value));
    return isNaN(d.getTime())
      ? "-"
      : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }
  if (typeof value === "number") {
    if (BYTE_FIELDS.has(def.value)) return formatBytesNum(value);
    if (MINUTE_FIELDS.has(def.value)) return `${value} min`;
    if (PERCENT_FIELDS.has(def.value)) return `${value.toFixed(1)}%`;
    return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Math.round(value * 100) / 100);
  }
  return String(value);
}

/** Sort key for a criterion column (null sorts last). */
export function columnSortValue(def: ConditionField, value: QueryColumnValue | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ").toLowerCase() : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (def.type === "date") {
    const t = new Date(value).getTime();
    return isNaN(t) ? null : t;
  }
  return value.toLowerCase();
}
