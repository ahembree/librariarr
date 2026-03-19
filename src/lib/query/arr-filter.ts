import type { ArrMetadata, ArrDataMap } from "@/lib/rules/engine";
import type { QueryRule, QueryGroup, RuleCondition } from "./types";
import { ARR_QUERY_FIELDS } from "./types";

/** Convert a glob-style wildcard pattern to a RegExp */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i");
}

/** Map media item type to external ID source for Arr lookups */
function getExternalIdSource(type: string): string {
  switch (type) {
    case "MOVIE": return "TMDB";
    case "MUSIC": return "MUSICBRAINZ";
    default: return "TVDB"; // SERIES
  }
}

/** Evaluate a single Arr rule against Arr metadata */
export function evaluateQueryArrRule(rule: QueryRule, meta: ArrMetadata | undefined): boolean {
  // foundInArr must be checked before the !meta guard since it explicitly
  // tests for the presence/absence of Arr metadata
  if (rule.field === "foundInArr") {
    const boolVal = String(rule.value).toLowerCase() === "true";
    const found = meta !== undefined;
    const result = rule.operator === "notEquals" ? found !== boolVal : found === boolVal;
    return rule.negate ? !result : result;
  }
  if (!meta) return false;
  const { field, operator, value, negate } = rule;
  let result: boolean;

  switch (field) {
    case "arrTag": {
      const strVal = String(value).toLowerCase();
      switch (operator) {
        case "equals":
          result = meta.tags.some((t) => t.toLowerCase() === strVal);
          break;
        case "notEquals":
          result = !meta.tags.some((t) => t.toLowerCase() === strVal);
          break;
        case "contains": {
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) => meta.tags.some((t) => t.toLowerCase().includes(v)));
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) => meta.tags.some((t) => t.toLowerCase().includes(v)));
          break;
        }
        case "matchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = meta.tags.some((t) => re.test(t));
          break;
        }
        case "notMatchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = !meta.tags.some((t) => re.test(t));
          break;
        }
        default:
          result = true;
      }
      break;
    }
    case "arrQualityProfile": {
      const strVal = String(value).toLowerCase();
      switch (operator) {
        case "equals":
          result = meta.qualityProfile.toLowerCase() === strVal;
          break;
        case "notEquals":
          result = meta.qualityProfile.toLowerCase() !== strVal;
          break;
        case "contains": {
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) => meta.qualityProfile.toLowerCase().includes(v));
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) => meta.qualityProfile.toLowerCase().includes(v));
          break;
        }
        case "matchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = re.test(meta.qualityProfile);
          break;
        }
        case "notMatchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = !re.test(meta.qualityProfile);
          break;
        }
        default:
          result = true;
      }
      break;
    }
    case "arrMonitored": {
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals":
          result = meta.monitored === boolVal;
          break;
        case "notEquals":
          result = meta.monitored !== boolVal;
          break;
        default:
          result = true;
      }
      break;
    }
    case "arrRating": {
      const numVal = Number(value);
      if (meta.rating === null) {
        result = false;
        break;
      }
      switch (operator) {
        case "equals":
          result = meta.rating === numVal;
          break;
        case "notEquals":
          result = meta.rating !== numVal;
          break;
        case "greaterThan":
          result = meta.rating > numVal;
          break;
        case "greaterThanOrEqual":
          result = meta.rating >= numVal;
          break;
        case "lessThan":
          result = meta.rating < numVal;
          break;
        case "lessThanOrEqual":
          result = meta.rating <= numVal;
          break;
        default:
          result = true;
      }
      break;
    }
    case "arrTmdbRating": {
      const numVal = Number(value);
      if (meta.tmdbRating === null) {
        result = false;
        break;
      }
      switch (operator) {
        case "equals":
          result = meta.tmdbRating === numVal;
          break;
        case "notEquals":
          result = meta.tmdbRating !== numVal;
          break;
        case "greaterThan":
          result = meta.tmdbRating > numVal;
          break;
        case "greaterThanOrEqual":
          result = meta.tmdbRating >= numVal;
          break;
        case "lessThan":
          result = meta.tmdbRating < numVal;
          break;
        case "lessThanOrEqual":
          result = meta.tmdbRating <= numVal;
          break;
        default:
          result = true;
      }
      break;
    }
    case "arrRtCriticRating": {
      const numVal = Number(value);
      if (meta.rtCriticRating === null) {
        result = false;
        break;
      }
      switch (operator) {
        case "equals":
          result = meta.rtCriticRating === numVal;
          break;
        case "notEquals":
          result = meta.rtCriticRating !== numVal;
          break;
        case "greaterThan":
          result = meta.rtCriticRating > numVal;
          break;
        case "greaterThanOrEqual":
          result = meta.rtCriticRating >= numVal;
          break;
        case "lessThan":
          result = meta.rtCriticRating < numVal;
          break;
        case "lessThanOrEqual":
          result = meta.rtCriticRating <= numVal;
          break;
        default:
          result = true;
      }
      break;
    }
    // --- Date fields ---
    case "arrDateAdded":
    case "arrReleaseDate":
    case "arrInCinemasDate":
    case "arrDownloadDate":
    case "arrFirstAired": {
      const dateStr =
        field === "arrDateAdded" ? meta.dateAdded :
        field === "arrReleaseDate" ? meta.releaseDate :
        field === "arrInCinemasDate" ? meta.inCinemasDate :
        field === "arrDownloadDate" ? meta.downloadDate :
        meta.firstAired;
      const itemDate = dateStr ? new Date(dateStr) : null;
      if (!itemDate || isNaN(itemDate.getTime())) {
        result = operator === "isNull";
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
          result = false;
          break;
        case "isNotNull":
          result = true;
          break;
        default:
          result = true;
      }
      break;
    }
    // --- Numeric fields (sizeOnDisk stored as bytes, user inputs MB) ---
    case "arrSizeOnDisk": {
      if (meta.sizeOnDisk === null) {
        result = operator === "isNull";
        break;
      }
      if (operator === "isNotNull") { result = true; break; }
      const sizeMB = meta.sizeOnDisk / (1024 * 1024);
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = sizeMB === numVal; break;
        case "notEquals": result = sizeMB !== numVal; break;
        case "greaterThan": result = sizeMB > numVal; break;
        case "greaterThanOrEqual": result = sizeMB >= numVal; break;
        case "lessThan": result = sizeMB < numVal; break;
        case "lessThanOrEqual": result = sizeMB <= numVal; break;
        default: result = true;
      }
      break;
    }
    case "arrRuntime":
    case "arrSeasonCount":
    case "arrEpisodeCount":
    case "arrMonitoredSeasonCount":
    case "arrMonitoredEpisodeCount": {
      const metaVal =
        field === "arrRuntime" ? meta.runtime :
        field === "arrSeasonCount" ? meta.seasonCount :
        field === "arrEpisodeCount" ? meta.episodeCount :
        field === "arrMonitoredSeasonCount" ? meta.monitoredSeasonCount :
        meta.monitoredEpisodeCount;
      if (metaVal === null) {
        result = operator === "isNull";
        break;
      }
      if (operator === "isNotNull") { result = true; break; }
      const numVal = Number(value);
      switch (operator) {
        case "equals": result = metaVal === numVal; break;
        case "notEquals": result = metaVal !== numVal; break;
        case "greaterThan": result = metaVal > numVal; break;
        case "greaterThanOrEqual": result = metaVal >= numVal; break;
        case "lessThan": result = metaVal < numVal; break;
        case "lessThanOrEqual": result = metaVal <= numVal; break;
        default: result = true;
      }
      break;
    }
    // --- Boolean fields ---
    case "arrQualityCutoffMet":
    case "arrEnded":
    case "arrHasUnaired": {
      const metaVal =
        field === "arrQualityCutoffMet" ? meta.qualityCutoffMet :
        field === "arrEnded" ? meta.ended :
        meta.hasUnaired;
      if (metaVal === null) { result = false; break; }
      const boolVal = String(value).toLowerCase() === "true";
      switch (operator) {
        case "equals": result = metaVal === boolVal; break;
        case "notEquals": result = metaVal !== boolVal; break;
        default: result = true;
      }
      break;
    }
    // --- Text fields ---
    case "arrPath":
    case "arrOriginalLanguage":
    case "arrQualityName":
    case "arrStatus":
    case "arrSeriesType": {
      const metaVal =
        field === "arrPath" ? meta.path :
        field === "arrOriginalLanguage" ? meta.originalLanguage :
        field === "arrQualityName" ? meta.qualityName :
        field === "arrStatus" ? meta.status :
        meta.seriesType;
      if (metaVal === null) {
        result = operator === "isNull";
        break;
      }
      if (operator === "isNotNull") { result = true; break; }
      const strVal = String(value).toLowerCase();
      switch (operator) {
        case "equals":
          result = metaVal.toLowerCase() === strVal;
          break;
        case "notEquals":
          result = metaVal.toLowerCase() !== strVal;
          break;
        case "contains": {
          const values = strVal.split("|").filter(Boolean);
          result = values.some((v) => metaVal.toLowerCase().includes(v));
          break;
        }
        case "notContains": {
          const values = strVal.split("|").filter(Boolean);
          result = !values.some((v) => metaVal.toLowerCase().includes(v));
          break;
        }
        case "matchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = re.test(metaVal);
          break;
        }
        case "notMatchesWildcard": {
          const re = wildcardToRegex(strVal);
          result = !re.test(metaVal);
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
 * Evaluate Arr rules in a group against an item's Arr metadata.
 * Returns true if the item passes the Arr conditions in the group tree.
 * Non-Arr rules are skipped (they were handled by the DB query).
 */
function evaluateGroupArrRules(
  group: QueryGroup,
  meta: ArrMetadata | undefined,
): boolean | null {
  if (group.enabled === false) return null;
  const items: Array<{ condition: RuleCondition; result: boolean }> = [];

  for (const rule of group.rules) {
    if (rule.enabled === false) continue;
    if (!ARR_QUERY_FIELDS.has(rule.field)) continue;
    items.push({ condition: rule.condition, result: evaluateQueryArrRule(rule, meta) });
  }

  for (const sub of group.groups ?? []) {
    const subResult = evaluateGroupArrRules(sub, meta);
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

/**
 * Check if an item passes all Arr rules in the query groups.
 * Items without a matching external ID fail Arr rules (evaluateQueryArrRule returns false for undefined meta).
 */
export function evaluateArrRulesForItem(
  groups: QueryGroup[],
  itemExternalIds: Array<{ source: string; externalId: string }>,
  itemType: string,
  arrDataByType: Record<string, ArrDataMap>,
): boolean {
  const source = getExternalIdSource(itemType);
  const externalId = itemExternalIds.find((e) => e.source === source)?.externalId;
  const arrData = arrDataByType[itemType];
  const meta = externalId && arrData ? arrData[externalId] : undefined;

  // Evaluate each group's Arr rules, collecting results for groups that have Arr rules
  const arrResults: Array<{ condition: string; passed: boolean }> = [];
  for (const group of groups) {
    const result = evaluateGroupArrRules(group, meta);
    if (result === null) continue; // no Arr rules in this group
    arrResults.push({ condition: group.condition, passed: result });
  }

  if (arrResults.length === 0) return true; // no Arr rules at all

  // Combine inter-group results respecting AND/OR conditions
  let combined = arrResults[0].passed;
  for (let i = 1; i < arrResults.length; i++) {
    const { condition, passed } = arrResults[i];
    if (condition === "OR") {
      combined = combined || passed;
    } else {
      combined = combined && passed;
    }
  }
  return combined;
}
