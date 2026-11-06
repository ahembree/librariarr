/**
 * Server-side enforcement of per-field library-type validity.
 *
 * The builders disable fields that are invalid for the selected library type
 * via `isFieldDisabled`, but that is only a UI affordance — a rule saved before
 * a field was gated, or a hand-crafted API request, can still carry a field
 * whose data is never populated for the target type. On the wrong type such a
 * field evaluates against a hardcoded-null value: in an AND group the clause
 * matches nothing (silently dead), and with `negate`/`isNull` it can flip to
 * match-all. For the lifecycle deletion pipeline that is a correctness risk, so
 * the create/update routes reject these rather than silently accepting (or
 * stripping — stripping an always-false AND clause would *widen* what matches).
 *
 * Field detection mirrors `validateRuleStructure` in validation.ts: an object
 * with a `rules` array is a group (recurse into `rules` and `groups`); an object
 * with a string `field` is a flat rule. Stream-query (`sq*`) fields aren't in
 * CONDITION_FIELDS so `getConditionField` returns undefined and they're skipped,
 * matching the builder's behaviour.
 */
import { getConditionField } from "./fields";
import type { LibraryType } from "./types";

/** Recursively collect every rule `field` name from a flat-or-grouped tree. */
export function collectRuleFields(rules: unknown[]): string[] {
  const out: string[] = [];
  const walk = (items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (Array.isArray(obj.rules)) {
        walk(obj.rules);
        if (Array.isArray(obj.groups)) walk(obj.groups);
      } else if (typeof obj.field === "string") {
        out.push(obj.field);
      }
    }
  };
  walk(rules);
  return out;
}

/**
 * Distinct field values in the tree that are invalid for a single target
 * library type — used by lifecycle rule set create/update, which are scoped to
 * exactly one type.
 */
export function findFieldsInvalidForType(
  rules: unknown[],
  type: LibraryType,
): string[] {
  const invalid = new Set<string>();
  for (const field of collectRuleFields(rules)) {
    const def = getConditionField(field);
    if (def?.invalidForLibraryType?.includes(type)) invalid.add(field);
  }
  return [...invalid];
}

/**
 * Distinct field values invalid for EVERY selected media type — used by the
 * query builder, which can target multiple types at once. An empty
 * `mediaTypes` means "all types", so nothing is invalid (mirrors the builder's
 * `fieldInvalidForSelectedTypes`).
 */
export function findFieldsInvalidForTypes(
  rules: unknown[],
  mediaTypes: LibraryType[],
): string[] {
  if (mediaTypes.length === 0) return [];
  const invalid = new Set<string>();
  for (const field of collectRuleFields(rules)) {
    const def = getConditionField(field);
    const inv = def?.invalidForLibraryType;
    if (inv && inv.length > 0 && mediaTypes.every((t) => inv.includes(t))) {
      invalid.add(field);
    }
  }
  return [...invalid];
}
