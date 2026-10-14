/**
 * Validates the docs' Rule Set Library (docs/src/content/docs/docs/guides/
 * rule-set-library.mdx): every ```json block on that page is a rule set in
 * the shape the rule editor's Export button produces, and every field,
 * operator and action type it names exists in the registries the editor and
 * engine use. Nothing at runtime reads those blocks, so without this a rename
 * in the registries would silently leave the docs offering JSON the editor
 * cannot evaluate.
 *
 * Shared by the docs build (`scripts/validate-rule-set-library.ts`, run
 * before `astro build`) and the app's unit test
 * (`tests/unit/docs/rule-set-library.test.ts`), so the two cannot drift.
 * Alias-free and Node-import-free on purpose: the docs build runs it with
 * tsx from a separate workspace.
 */
import { getConditionField } from "../src/lib/conditions/fields";
import { CONDITION_OPERATORS } from "../src/lib/conditions/operators";
import type { ConditionGroup, LibraryType } from "../src/lib/conditions/types";
import {
  MOVIE_ACTION_TYPES,
  SERIES_ACTION_TYPES,
  MUSIC_ACTION_TYPES,
} from "../src/lib/lifecycle/action-types";

/** The `RuleSetExport` shape in src/components/lifecycle-rule-page.tsx. */
export interface RuleSetExport {
  version: 1;
  type: LibraryType;
  name: string;
  rules: ConditionGroup[];
  seriesScope?: boolean;
  enabled: boolean;
  actionEnabled: boolean;
  actionType: string | null;
  actionDelayDays: number;
  addImportExclusion: boolean;
  searchAfterAction?: boolean;
  addArrTags: string[];
  removeArrTags: string[];
  collectionEnabled: boolean;
  collectionName: string | null;
  collectionSortName: string | null;
  collectionHomeScreen: boolean;
  collectionRecommended: boolean;
  collectionSort?: string;
  discordNotifyOnAction?: boolean;
  discordNotifyOnMatch?: boolean;
  stickyMatches?: boolean;
  serverIds?: string[];
}

const EXPORT_KEYS = new Set<string>([
  "version", "type", "name", "rules", "seriesScope", "enabled", "actionEnabled",
  "actionType", "actionDelayDays", "addImportExclusion", "searchAfterAction",
  "addArrTags", "removeArrTags", "collectionEnabled", "collectionName",
  "collectionSortName", "collectionHomeScreen", "collectionRecommended",
  "collectionSort", "discordNotifyOnAction", "discordNotifyOnMatch",
  "stickyMatches", "serverIds",
]);

const LIBRARY_TYPES = new Set<string>(["MOVIE", "SERIES", "MUSIC"]);
const SCOPED_TYPES = new Set<string>(["SERIES", "MUSIC"]);
const COLLECTION_SORTS = new Set<string>(["RELEASE_DATE", "ALPHABETICAL", "ACTION_DATE"]);
const DAY_OPERATORS = new Set(["inLastDays", "notInLastDays"]);
const VALUELESS_OPERATORS = new Set(["isNull", "isNotNull"]);
const EXACT_OPERATORS = new Set(["equals", "notEquals"]);

const ACTION_TYPES: Record<LibraryType, Set<string>> = {
  MOVIE: new Set(MOVIE_ACTION_TYPES.map((a) => a.value)),
  SERIES: new Set(SERIES_ACTION_TYPES.map((a) => a.value)),
  MUSIC: new Set(MUSIC_ACTION_TYPES.map((a) => a.value)),
};

const OPERATOR_TYPES = new Map<string, readonly string[]>(
  CONDITION_OPERATORS.map((op) => [op.value, op.types]),
);

/** The ```json blocks of a page, in order, still as text. */
export function extractJsonBlocks(page: string): string[] {
  return [...page.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

function* walkGroups(groups: ConditionGroup[]): Generator<ConditionGroup> {
  for (const group of groups) {
    yield group;
    yield* walkGroups(group.groups ?? []);
  }
}

/** Every field a rule set reads, nested groups included. */
export function fieldsUsed(ruleSet: RuleSetExport): Set<string> {
  const used = new Set<string>();
  for (const group of walkGroups(ruleSet.rules)) {
    for (const rule of group.rules) used.add(rule.field);
  }
  return used;
}

/**
 * The problems with one rule set, as sentences; empty when it is an export
 * the editor can import and the engine can evaluate.
 */
export function ruleSetProblems(ruleSet: RuleSetExport): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);

  if (ruleSet.version !== 1) fail(`version must be 1, got ${JSON.stringify(ruleSet.version)}`);
  if (!LIBRARY_TYPES.has(ruleSet.type)) fail(`unknown type ${JSON.stringify(ruleSet.type)}`);
  if (typeof ruleSet.name !== "string" || ruleSet.name.trim() === "") fail("name is required");
  for (const key of Object.keys(ruleSet)) {
    if (!EXPORT_KEYS.has(key)) fail(`unknown export key "${key}"`);
  }
  // The Series and Music tabs export their scope (series / artist) as
  // `seriesScope`; the Movies tab has none and its importer ignores it.
  if (SCOPED_TYPES.has(ruleSet.type) && typeof ruleSet.seriesScope !== "boolean") fail(`a ${ruleSet.type} rule set needs seriesScope`);
  if (!SCOPED_TYPES.has(ruleSet.type) && "seriesScope" in ruleSet) fail("seriesScope only applies to SERIES and MUSIC rule sets");

  // The library never arms an action: the reader previews first.
  if (ruleSet.actionEnabled !== false) fail("actionEnabled must be false in the library");
  if (ruleSet.actionType == null) fail("actionType is required");
  else if (LIBRARY_TYPES.has(ruleSet.type) && !ACTION_TYPES[ruleSet.type].has(ruleSet.actionType)) {
    fail(`action ${ruleSet.actionType} is not available on ${ruleSet.type} rule sets`);
  }
  if (!Number.isInteger(ruleSet.actionDelayDays) || ruleSet.actionDelayDays < 0 || ruleSet.actionDelayDays > 365) {
    fail(`actionDelayDays must be an integer from 0 to 365, got ${JSON.stringify(ruleSet.actionDelayDays)}`);
  }
  if (ruleSet.collectionSort !== undefined && !COLLECTION_SORTS.has(ruleSet.collectionSort)) {
    fail(`unknown collectionSort ${JSON.stringify(ruleSet.collectionSort)}`);
  }
  if (ruleSet.collectionEnabled && !ruleSet.collectionName) fail("an enabled collection needs a collectionName");
  for (const key of ["addArrTags", "removeArrTags"] as const) {
    if (!Array.isArray(ruleSet[key]) || ruleSet[key].some((t) => typeof t !== "string")) fail(`${key} must be a string array`);
  }

  if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length === 0) {
    fail("rules must be a non-empty array of groups");
    return problems;
  }
  for (const group of walkGroups(ruleSet.rules)) {
    if (!Array.isArray(group.rules) || !Array.isArray(group.groups)) {
      fail(`group ${JSON.stringify(group.id)} needs rules and groups arrays`);
      continue;
    }
    if (group.condition !== "AND" && group.condition !== "OR") fail(`group ${JSON.stringify(group.id)} needs condition AND or OR`);
    if (group.rules.length + group.groups.length === 0) fail(`group ${JSON.stringify(group.id)} is empty`);
    for (const rule of group.rules) {
      if (typeof rule.field !== "string" || typeof rule.operator !== "string") {
        fail(`rule ${JSON.stringify(rule.id)} needs string field and operator`);
        continue;
      }
      if (rule.condition !== "AND" && rule.condition !== "OR") fail(`rule ${rule.field}: condition must be AND or OR`);
      const field = getConditionField(rule.field);
      if (!field) {
        fail(`unknown field "${rule.field}"`);
        continue;
      }
      if (field.invalidForLibraryType?.includes(ruleSet.type)) fail(`${rule.field} is not available on ${ruleSet.type} rule sets`);
      const types = OPERATOR_TYPES.get(rule.operator);
      if (!types) fail(`unknown operator "${rule.operator}"`);
      else if (!types.includes(field.type)) fail(`${rule.operator} does not apply to ${field.type} field ${rule.field}`);
      // Values are strings, as the editor's own inputs produce them.
      if (typeof rule.value !== "string") {
        fail(`${rule.field}: value must be a string, got ${typeof rule.value}`);
        continue;
      }
      // Is Empty / Is Not Empty take no value; the editor stores "".
      if (VALUELESS_OPERATORS.has(rule.operator)) continue;
      if (field.type === "boolean" && rule.value !== "true" && rule.value !== "false") fail(`${rule.field}: boolean value must be "true" or "false"`);
      if ((field.type === "number" || DAY_OPERATORS.has(rule.operator)) && !/^-?\d+(\.\d+)?$/.test(rule.value)) {
        fail(`${rule.field} ${rule.operator} needs a number, got "${rule.value}"`);
      }
      if (field.knownValues && EXACT_OPERATORS.has(rule.operator) && !field.knownValues.includes(rule.value)) {
        fail(`${rule.field}: "${rule.value}" is not one of ${field.knownValues.join(", ")}`);
      }
    }
  }
  return problems;
}

export interface LibraryCheck {
  ruleSets: RuleSetExport[];
  /** `name → problems` for every block that has any. A block that is not JSON is keyed by its index. */
  problems: Map<string, string[]>;
}

/** Parse and check every ```json block of the library page's text. */
export function checkRuleSetLibrary(page: string): LibraryCheck {
  const ruleSets: RuleSetExport[] = [];
  const problems = new Map<string, string[]>();
  const names = new Set<string>();
  extractJsonBlocks(page).forEach((block, index) => {
    let parsed: RuleSetExport;
    try {
      parsed = JSON.parse(block) as RuleSetExport;
    } catch (error) {
      problems.set(`block #${index + 1}`, [`not valid JSON: ${(error as Error).message}`]);
      return;
    }
    const key = typeof parsed?.name === "string" && parsed.name ? parsed.name : `block #${index + 1}`;
    const found = ruleSetProblems(parsed);
    if (names.has(key)) found.push("duplicate rule set name");
    names.add(key);
    if (found.length > 0) problems.set(key, found);
    ruleSets.push(parsed);
  });
  if (ruleSets.length === 0 && problems.size === 0) problems.set("page", ["no ```json blocks found"]);
  return { ruleSets, problems };
}
