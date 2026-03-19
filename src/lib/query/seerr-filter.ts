import type { SeerrMetadata, SeerrDataMap } from "@/lib/rules/engine";
import type { QueryRule, QueryGroup, RuleCondition } from "./types";
import { SEERR_QUERY_FIELDS } from "./types";

/** Evaluate a single Seerr rule against Seerr metadata */
export function evaluateQuerySeerrRule(rule: QueryRule, meta: SeerrMetadata | undefined): boolean {
  const { field, operator, value, negate } = rule;
  let result: boolean;

  const defaultMeta: SeerrMetadata = {
    requested: false,
    requestCount: 0,
    requestDate: null,
    requestedBy: [],
    approvalDate: null,
    declineDate: null,
  };
  const m = meta ?? defaultMeta;

  switch (field) {
    case "seerrRequested": {
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals":
          result = m.requested === boolVal;
          break;
        case "notEquals":
          result = m.requested !== boolVal;
          break;
        default:
          result = true;
      }
      break;
    }
    case "seerrRequestCount": {
      const numVal = Number(value);
      switch (operator) {
        case "equals":
          result = m.requestCount === numVal;
          break;
        case "notEquals":
          result = m.requestCount !== numVal;
          break;
        case "greaterThan":
          result = m.requestCount > numVal;
          break;
        case "greaterThanOrEqual":
          result = m.requestCount >= numVal;
          break;
        case "lessThan":
          result = m.requestCount < numVal;
          break;
        case "lessThanOrEqual":
          result = m.requestCount <= numVal;
          break;
        default:
          result = true;
      }
      break;
    }
    case "seerrRequestDate":
    case "seerrApprovalDate":
    case "seerrDeclineDate": {
      const dateStr =
        field === "seerrRequestDate" ? m.requestDate :
        field === "seerrApprovalDate" ? m.approvalDate :
        m.declineDate;
      const itemDate = dateStr ? new Date(dateStr) : null;
      if (!itemDate || isNaN(itemDate.getTime())) {
        result = false;
        break;
      }
      switch (operator) {
        case "before":
          result = itemDate < new Date(String(value));
          break;
        case "after":
          result = itemDate > new Date(String(value));
          break;
        case "inLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate >= daysAgo;
          break;
        }
        case "notInLastDays": {
          const daysAgo = new Date();
          daysAgo.setDate(daysAgo.getDate() - Number(value));
          result = itemDate < daysAgo;
          break;
        }
        case "equals":
          result =
            itemDate.toISOString().split("T")[0] ===
            new Date(String(value)).toISOString().split("T")[0];
          break;
        case "isNull":
          result = false; // we have a date, so it's not null
          break;
        case "isNotNull":
          result = true; // we have a date, so it's not null
          break;
        default:
          result = true;
      }
      break;
    }
    case "seerrRequestedBy": {
      const strVal = String(value).toLowerCase();
      switch (operator) {
        case "equals":
          result = m.requestedBy.some((u) => u.toLowerCase() === strVal);
          break;
        case "notEquals":
          result = !m.requestedBy.some((u) => u.toLowerCase() === strVal);
          break;
        case "contains": {
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) =>
            m.requestedBy.some((u) => u.toLowerCase().includes(v))
          );
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) =>
            m.requestedBy.some((u) => u.toLowerCase().includes(v))
          );
          break;
        }
        default:
          result = true;
      }
      break;
    }
    default:
      result = true;
  }

  return negate ? !result : result;
}

/**
 * Evaluate Seerr rules in a group against an item's Seerr metadata.
 * Returns true if the item passes the Seerr conditions in the group tree.
 * Non-Seerr rules are skipped (they were handled by the DB query).
 */
function evaluateGroupSeerrRules(
  group: QueryGroup,
  meta: SeerrMetadata | undefined,
): boolean | null {
  if (group.enabled === false) return null;
  const items: Array<{ condition: RuleCondition; result: boolean }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    if (!SEERR_QUERY_FIELDS.has(rule.field)) continue;
    items.push({ condition: rule.condition, result: evaluateQuerySeerrRule(rule, meta) });
  }

  for (const sub of group.groups ?? []) {
    const subResult = evaluateGroupSeerrRules(sub, meta);
    if (subResult !== null) items.push({ condition: sub.condition, result: subResult });
  }

  if (items.length === 0) return null;
  if (items.length === 1) return items[0].result;

  let combined = items[0].result;
  for (let i = 1; i < items.length; i++) {
    const { condition, result } = items[i];
    if (condition === "OR") {
      combined = combined || result;
    } else {
      combined = combined && result;
    }
  }
  return combined;
}

/** Map media item type to external ID source for Seerr lookups */
function getSeerrExternalIdSource(type: string): string {
  switch (type) {
    case "MOVIE": return "TMDB";
    default: return "TVDB"; // SERIES
  }
}

/**
 * Check if an item passes all Seerr rules in the query groups.
 */
export function evaluateSeerrRulesForItem(
  groups: QueryGroup[],
  itemExternalIds: Array<{ source: string; externalId: string }>,
  itemType: string,
  seerrDataByType: Record<string, SeerrDataMap>,
): boolean {
  const source = getSeerrExternalIdSource(itemType);
  const externalId = itemExternalIds.find((e) => e.source === source)?.externalId;
  const seerrData = seerrDataByType[itemType];
  const meta = externalId && seerrData ? seerrData[externalId] : undefined;

  const seerrResults: Array<{ condition: string; passed: boolean }> = [];
  for (const group of groups) {
    const result = evaluateGroupSeerrRules(group, meta);
    if (result === null) continue;
    seerrResults.push({ condition: group.condition, passed: result });
  }

  if (seerrResults.length === 0) return true;

  let combined = seerrResults[0].passed;
  for (let i = 1; i < seerrResults.length; i++) {
    const { condition, passed } = seerrResults[i];
    if (condition === "OR") {
      combined = combined || passed;
    } else {
      combined = combined && passed;
    }
  }
  return combined;
}
