/**
 * Fail the docs build when the Rule Set Library page offers JSON the rule
 * editor could not import or the engine could not evaluate. Run before
 * `astro build` and `astro dev` (`docs/package.json`); the same checks run in
 * the app's unit tests through `scripts/rule-set-library-check.ts`.
 *
 * Run from anywhere: `tsx scripts/validate-rule-set-library.ts [page.mdx]`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRuleSetLibrary } from "./rule-set-library-check";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = path.resolve(
  process.argv[2] ?? path.join(root, "docs/src/content/docs/docs/guides/rule-set-library.mdx"),
);

const { ruleSets, problems } = checkRuleSetLibrary(readFileSync(page, "utf8"));
if (problems.size > 0) {
  console.error(`Rule Set Library (${path.relative(process.cwd(), page)}) has invalid rule sets:`);
  for (const [name, list] of problems) {
    for (const problem of list) console.error(`  ${name}: ${problem}`);
  }
  process.exit(1);
}
console.log(`Rule Set Library: ${ruleSets.length} rule set(s) valid (${path.relative(process.cwd(), page)})`);
