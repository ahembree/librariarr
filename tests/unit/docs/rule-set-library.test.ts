/**
 * The docs' Rule Set Library (docs/src/content/docs/docs/guides/
 * rule-set-library.mdx) publishes rule sets as the JSON the rule editor's
 * Export button produces, for readers to paste into Import. Nothing at
 * runtime reads those blocks, so a field, operator or action type renamed
 * in the registries would silently leave the docs offering JSON the editor
 * cannot evaluate. `scripts/rule-set-library-check.ts` holds the checks
 * (the docs build runs them too); this test adds what only the app can
 * check — the rule set create schema, and that the lifecycle docs describe
 * every field the library uses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ruleSetCreateSchema } from "@/lib/validation";
import {
  checkRuleSetLibrary,
  fieldsUsed,
  ruleSetProblems,
  type RuleSetExport,
} from "../../../scripts/rule-set-library-check";

const DOCS = resolve(__dirname, "../../../docs/src/content/docs/docs");
const page = readFileSync(resolve(DOCS, "guides/rule-set-library.mdx"), "utf8");
const { ruleSets, problems } = checkRuleSetLibrary(page);

describe("docs rule set library", () => {
  it("publishes valid rule sets", () => {
    expect(ruleSets.length).toBeGreaterThanOrEqual(5);
    expect(Object.fromEntries(problems)).toEqual({});
  });

  it.each(ruleSets.map((r) => [r.name, r] as const))("%s saves through the rule set create schema", (_name, ruleSet) => {
    // What the editor sends once the reader has picked a server: the export
    // minus its version marker, plus a target. The export's `collection*`
    // keys are not schema fields (a rule set references a collection by
    // `collectionId`), so the schema strips them.
    const payload: Record<string, unknown> = { ...ruleSet };
    delete payload.version;
    const result = ruleSetCreateSchema.safeParse({ ...payload, serverIds: ["server"] });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("documents every field a rule set uses", () => {
    // A field that exists in the registry but not the docs' field tables is
    // a docs gap, not a JSON error; this keeps the two from drifting apart.
    const documented = readFileSync(resolve(DOCS, "features/lifecycle-rules.mdx"), "utf8");
    for (const ruleSet of ruleSets) {
      for (const field of fieldsUsed(ruleSet)) {
        expect(documented, `${field} is used by "${ruleSet.name}" but not described in lifecycle-rules.mdx`).toContain(`\`${field}\``);
      }
    }
  });

  it("rejects what the editor could not import", () => {
    const base = ruleSets[0];
    const broken = (patch: Partial<RuleSetExport> | ((r: RuleSetExport) => RuleSetExport)) =>
      ruleSetProblems(typeof patch === "function" ? patch(structuredClone(base)) : { ...structuredClone(base), ...patch });
    expect(broken({ actionEnabled: true })).toContain("actionEnabled must be false in the library");
    expect(broken({ actionType: "DELETE_SONARR" })).toEqual([`action DELETE_SONARR is not available on ${base.type} rule sets`]);
    expect(broken({ type: "SERIES" })).toContain("a SERIES rule set needs seriesScope");
    expect(broken((r) => { r.rules[0].rules[0].field = "noSuchField"; return r; })).toEqual(['unknown field "noSuchField"']);
    expect(broken((r) => { r.rules[0].rules[0].operator = "contains"; return r; })).toEqual([
      "contains does not apply to date field addedAt",
    ]);
    expect(broken((r) => { r.rules[0].rules[0].value = 180 as unknown as string; return r; })).toEqual([
      "addedAt: value must be a string, got number",
    ]);
    expect(broken((r) => { r.rules[0].rules[1].value = "yes"; return r; })).toEqual([
      'isWatchlisted: boolean value must be "true" or "false"',
      'isWatchlisted: "yes" is not one of true, false',
    ]);
    expect(broken((r) => { r.rules[0].rules[1].operator = "notEquals"; r.rules[0].rules[1].value = "yes"; return r; })).toEqual([
      'isWatchlisted: boolean value must be "true" or "false"',
      'isWatchlisted: "yes" is not one of true, false',
    ]);
    expect(checkRuleSetLibrary("```json\n{ not json\n```").problems.get("block #1")?.[0]).toMatch(/^not valid JSON/);
  });

  it("accepts the valueless operators as the editor stores them", () => {
    // Is Empty / Is Not Empty save `value: ""`, which is not a number.
    const base = structuredClone(ruleSets[0]);
    base.rules[0].rules[0] = { id: "r1", field: "lastPlayedAt", operator: "isNull", value: "", condition: "AND" };
    base.rules[0].rules[1] = { id: "r2", field: "playCount", operator: "isNotNull", value: "", condition: "AND" };
    expect(ruleSetProblems(base)).toEqual([]);
  });
});
