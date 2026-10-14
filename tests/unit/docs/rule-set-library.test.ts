/**
 * The docs' Rule Set Library (docs/src/content/docs/docs/guides/
 * rule-set-library.mdx) publishes rule sets as the JSON the rule editor's
 * Export button produces, for readers to paste into Import. Nothing at
 * runtime reads those blocks, so a field, operator or action type renamed
 * in the registries would silently leave the docs offering JSON the editor
 * cannot evaluate. This test parses every ```json block on the page and
 * checks it against the same registries the editor and engine use.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CONDITION_FIELDS, getConditionField } from "@/lib/conditions/fields";
import { CONDITION_OPERATORS } from "@/lib/conditions/operators";
import type { ConditionGroup, LibraryType } from "@/lib/conditions/types";
import {
  MOVIE_ACTION_TYPES,
  SERIES_ACTION_TYPES,
  MUSIC_ACTION_TYPES,
} from "@/lib/lifecycle/action-types";
import { ruleSetCreateSchema } from "@/lib/validation";

const PAGE = resolve(
  __dirname,
  "../../../docs/src/content/docs/docs/guides/rule-set-library.mdx",
);

/** The `RuleSetExport` shape in src/components/lifecycle-rule-page.tsx. */
interface RuleSetExport {
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

const EXPORT_KEYS = new Set<keyof RuleSetExport>([
  "version", "type", "name", "rules", "seriesScope", "enabled", "actionEnabled",
  "actionType", "actionDelayDays", "addImportExclusion", "searchAfterAction",
  "addArrTags", "removeArrTags", "collectionEnabled", "collectionName",
  "collectionSortName", "collectionHomeScreen", "collectionRecommended",
  "collectionSort", "discordNotifyOnAction", "discordNotifyOnMatch",
  "stickyMatches", "serverIds",
]);

const ACTION_TYPES: Record<LibraryType, Set<string>> = {
  MOVIE: new Set(MOVIE_ACTION_TYPES.map((a) => a.value)),
  SERIES: new Set(SERIES_ACTION_TYPES.map((a) => a.value)),
  MUSIC: new Set(MUSIC_ACTION_TYPES.map((a) => a.value)),
};

const OPERATOR_TYPES = new Map(CONDITION_OPERATORS.map((op) => [op.value, op.types]));
const DAY_OPERATORS = new Set(["inLastDays", "notInLastDays"]);

function loadLibrary(): RuleSetExport[] {
  const page = readFileSync(PAGE, "utf8");
  const blocks = [...page.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  return blocks.map((block) => JSON.parse(block) as RuleSetExport);
}

function* walkGroups(groups: ConditionGroup[]): Generator<ConditionGroup> {
  for (const group of groups) {
    yield group;
    yield* walkGroups(group.groups ?? []);
  }
}

describe("docs rule set library", () => {
  const library = loadLibrary();

  it("publishes at least one rule set per guide it links", () => {
    expect(library.length).toBeGreaterThanOrEqual(5);
    expect(new Set(library.map((r) => r.name)).size).toBe(library.length);
  });

  it.each(library.map((r) => [r.name, r] as const))("%s is an export the editor can import", (_name, ruleSet) => {
    expect(ruleSet.version).toBe(1);
    expect(["MOVIE", "SERIES", "MUSIC"]).toContain(ruleSet.type);
    expect(ruleSet.name.trim()).not.toBe("");
    for (const key of Object.keys(ruleSet)) {
      expect(EXPORT_KEYS.has(key as keyof RuleSetExport), `unknown export key "${key}"`).toBe(true);
    }
    // Series Scope is a series-only setting; the importer reads it only there.
    if (ruleSet.type === "SERIES") expect(typeof ruleSet.seriesScope).toBe("boolean");
    else expect(ruleSet).not.toHaveProperty("seriesScope");
    // An instance id and a quality profile id never travel in an export.
    expect(ruleSet).not.toHaveProperty("arrInstanceId");
    expect(ruleSet).not.toHaveProperty("targetQualityProfileId");
  });

  it.each(library.map((r) => [r.name, r] as const))("%s never arms an action on import", (_name, ruleSet) => {
    expect(ruleSet.actionEnabled).toBe(false);
    expect(ruleSet.actionType).not.toBeNull();
    expect(ACTION_TYPES[ruleSet.type].has(ruleSet.actionType!)).toBe(true);
    expect(Number.isInteger(ruleSet.actionDelayDays)).toBe(true);
    expect(ruleSet.actionDelayDays).toBeGreaterThanOrEqual(0);
  });

  it.each(library.map((r) => [r.name, r] as const))("%s uses only registered fields and operators", (_name, ruleSet) => {
    expect(ruleSet.rules.length).toBeGreaterThan(0);
    for (const group of walkGroups(ruleSet.rules)) {
      expect(["AND", "OR"]).toContain(group.condition);
      expect(group.rules.length + (group.groups?.length ?? 0)).toBeGreaterThan(0);
      for (const rule of group.rules) {
        const field = getConditionField(rule.field);
        expect(field, `unknown field "${rule.field}"`).toBeDefined();
        expect(
          field!.invalidForLibraryType ?? [],
          `${rule.field} is not available on ${ruleSet.type} rule sets`,
        ).not.toContain(ruleSet.type);
        const types = OPERATOR_TYPES.get(rule.operator);
        expect(types, `unknown operator "${rule.operator}"`).toBeDefined();
        expect(types, `${rule.operator} does not apply to ${field!.type} field ${rule.field}`).toContain(field!.type);
        expect(["AND", "OR"]).toContain(rule.condition);
        // Values are strings, as the editor's own inputs produce them.
        expect(typeof rule.value).toBe("string");
        const value = String(rule.value);
        if (field!.type === "boolean") expect(["true", "false"]).toContain(value);
        if (field!.type === "number" || DAY_OPERATORS.has(rule.operator)) {
          expect(Number.isFinite(Number(value)), `${rule.field} ${rule.operator} needs a number, got "${value}"`).toBe(true);
        }
        if (field!.knownValues && rule.operator === "equals") {
          expect(field!.knownValues).toContain(value);
        }
      }
    }
  });

  it.each(library.map((r) => [r.name, r] as const))("%s saves through the rule set create schema", (_name, ruleSet) => {
    // What the editor sends once the reader has picked a server: the export
    // minus its version marker, plus a target. Collection settings go
    // through their own fields and are not part of this payload.
    const { version: _version, ...payload } = ruleSet;
    const result = ruleSetCreateSchema.safeParse({ ...payload, serverIds: ["server"] });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("documents every field a block uses", () => {
    // A field that exists in the registry but not the docs' field tables is
    // a docs gap, not a JSON error; this keeps the two from drifting apart.
    const documented = readFileSync(
      resolve(__dirname, "../../../docs/src/content/docs/docs/features/lifecycle-rules.mdx"),
      "utf8",
    );
    const used = new Set<string>();
    for (const ruleSet of library) {
      for (const group of walkGroups(ruleSet.rules)) {
        for (const rule of group.rules) used.add(rule.field);
      }
    }
    for (const field of used) {
      expect(CONDITION_FIELDS.some((f) => f.value === field)).toBe(true);
      expect(documented, `${field} is used by the library but not described in lifecycle-rules.mdx`).toContain(`\`${field}\``);
    }
  });
});
