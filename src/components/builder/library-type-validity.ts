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
      if (keptRules.length === 0 && keptSubGroups.length === 0) continue;
      result.push({ ...g, rules: keptRules, groups: keptSubGroups });
    }
    return result;
  };
  return prune(groups);
}
