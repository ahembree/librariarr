import type { ConditionGroup, LibraryType } from "@/lib/conditions";
import { getConditionField } from "@/lib/conditions";

export interface IncompatibleRule {
  groupId: string;
  ruleId: string;
  field: string;
  fieldLabel: string;
  reason: "invalidForLibraryType" | "seriesAggregateWithoutSeries";
}

function ruleIncompatibility(
  field: string,
  targetLibraryType: LibraryType,
): IncompatibleRule["reason"] | null {
  const def = getConditionField(field);
  if (!def) return null;
  if (def.invalidForLibraryType?.includes(targetLibraryType)) {
    return "invalidForLibraryType";
  }
  if (def.isSeriesAggregate && targetLibraryType !== "SERIES") {
    return "seriesAggregateWithoutSeries";
  }
  return null;
}

function fieldLabel(field: string): string {
  return getConditionField(field)?.label ?? field;
}

export function findIncompatibleRules(
  groups: ConditionGroup[],
  targetLibraryType: LibraryType,
): IncompatibleRule[] {
  const out: IncompatibleRule[] = [];
  const walk = (gs: ConditionGroup[]) => {
    for (const g of gs) {
      for (const r of g.rules) {
        const reason = ruleIncompatibility(r.field, targetLibraryType);
        if (reason) {
          out.push({
            groupId: g.id,
            ruleId: r.id,
            field: r.field,
            fieldLabel: fieldLabel(r.field),
            reason,
          });
        }
      }
      if (g.groups?.length) walk(g.groups);
    }
  };
  walk(groups);
  return out;
}

/**
 * Count rules across the tree regardless of enabled-state, used by the
 * convert-to-rule flow to detect when a conversion would leave a tree with
 * placeholder groups but no actionable rules. `countAllRules` in tree-utils
 * is enabled-aware and intended for a different purpose.
 */
export function countAllRulesIncludingDisabled(
  groups: ConditionGroup[],
): number {
  let total = 0;
  for (const g of groups) {
    total += g.rules.length;
    total += countAllRulesIncludingDisabled(g.groups ?? []);
  }
  return total;
}

export function dropIncompatibleRules(
  groups: ConditionGroup[],
  targetLibraryType: LibraryType,
): ConditionGroup[] {
  const prune = (gs: ConditionGroup[]): ConditionGroup[] => {
    const result: ConditionGroup[] = [];
    for (const g of gs) {
      const keptRules = g.rules.filter(
        (r) => ruleIncompatibility(r.field, targetLibraryType) === null,
      );
      const keptSubGroups = prune(g.groups ?? []);
      // Drop the group only when pruning actually emptied it. If the group
      // started empty (e.g. a placeholder, or a stream-query group whose
      // semantics live in its `streamQuery` field rather than its rules),
      // preserve it verbatim — we shouldn't silently strip the user's tree.
      const startedEmpty = g.rules.length === 0 && (g.groups?.length ?? 0) === 0;
      const becameEmpty =
        !startedEmpty && keptRules.length === 0 && keptSubGroups.length === 0;
      if (becameEmpty) continue;
      result.push({ ...g, rules: keptRules, groups: keptSubGroups });
    }
    return result;
  };
  return prune(groups);
}
