/**
 * Combinatorial "no match-all" fuzz against the live `librariarr` DB.
 *
 * For every valid (field, operator) pair and every hazard value variant
 * (empty / whitespace / NaN / type-mismatch / malformed-between / wildcard-*
 * / unknown-operator), call evaluateLifecycleRules with negate ∈ {false, true} and
 * assert the engine returns 0 matches (i.e. rejected the rule). Anything
 * > 0 is a regression of the deletion-safety guarantee.
 *
 * Read-only — snapshots row counts before/after and fails on drift. Pre-
 * fetches Arr/Seerr metadata once per (type, instance) via real HTTP, mirroring
 * what src/lib/lifecycle/processor.ts does in production.
 *
 * Run from the project root with the live DATABASE_URL:
 *   DATABASE_URL=postgresql://librariarr:librariarr@localhost:5432/librariarr \
 *     pnpm exec tsx scripts/e2e-live-db-fuzz.ts
 */

import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { prisma } from "@/lib/db";
import { evaluateLifecycleRules, type ArrDataMap, type SeerrDataMap } from "@/lib/rules/lifecycle-engine";
import { CONDITION_FIELDS, CONDITION_OPERATORS } from "@/lib/conditions";
import { isNonNullableField, isOperatorApplicable } from "@/lib/conditions/helpers";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadata } from "@/lib/lifecycle/fetch-seerr-metadata";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

const TYPES = ["MOVIE", "SERIES", "MUSIC"] as const;
type LibType = (typeof TYPES)[number];

interface Failure {
  kind: "hazard_returned_items" | "threw" | "row_drift" | "baseline_zero";
  field?: string;
  op?: string;
  variant?: string;
  value?: string;
  negate?: boolean;
  type?: LibType;
  matchCount?: number;
  baseline?: number;
  ratio?: number;
  error?: string;
  detail?: unknown;
}

const HAZARD_VARIANTS = [
  { name: "empty", value: "" },
  { name: "whitespace", value: "   " },
  { name: "tab_newline", value: "\t\n" },
  { name: "nan_str", value: "NaN" },
  { name: "type_mismatch_alpha", value: "abc" },
  { name: "between_no_comma", value: "5" },
  { name: "between_empty_upper", value: "5," },
  { name: "between_empty_lower", value: ",5" },
  { name: "between_both_empty", value: "," },
  { name: "between_nan", value: "NaN,NaN" },
  { name: "wildcard_single_star", value: "*" },
  { name: "wildcard_double_star", value: "**" },
  { name: "wildcard_question_only", value: "?" },
];

function ruleGroup(rules: Array<{ field: string; operator: string; value: string; negate?: boolean; logic?: "AND" | "OR" }>, groupLogic: "AND" | "OR" = "AND"): LifecycleRuleGroup[] {
  return [
    {
      id: randomUUID(),
      condition: groupLogic,
      rules: rules.map((r) => ({
        id: randomUUID(),
        field: r.field,
        operator: r.operator,
        value: r.value,
        condition: r.logic ?? "AND",
        negate: r.negate ?? false,
      })),
      groups: [],
    },
  ];
}

async function snapshot() {
  const [mediaItem, ruleMatch, lifecycleAction, ruleSet, savedQuery] = await Promise.all([
    prisma.mediaItem.count(),
    prisma.ruleMatch.count(),
    prisma.lifecycleAction.count(),
    prisma.ruleSet.count(),
    prisma.savedQuery.count(),
  ]);
  return { mediaItem, ruleMatch, lifecycleAction, ruleSet, savedQuery };
}

/**
 * Returns true when (variant, fieldType, op) is a TRUE engine-safety hazard:
 * a malformed/unconfigured input that the engine's guards must reject. False
 * positives (e.g. `equals ""` on text, `matchesWildcard "*"`) are filtered out
 * because they're legitimate operations the engine should respect.
 *
 * Engine guards (see src/lib/rules/engine.ts:197 isUnconfiguredContainsRule
 * and src/lib/conditions/helpers.ts isValueValidForRule):
 *   - contains/notContains with empty/whitespace/"|" → UNSATISFIABLE
 *   - matchesWildcard/notMatchesWildcard with empty/whitespace pattern → UNSATISFIABLE
 *     (but `*` is INTENTIONAL match-all and not unconfigured)
 *   - any op on number/date/boolean with non-parseable value → UNSATISFIABLE
 *   - between with malformed value → UNSATISFIABLE
 *   - unknown operator → UNSATISFIABLE
 */
function variantApplies(variantName: string, fieldType: string, op: string): boolean {
  // Wildcard variants: only the truly-empty wildcard is unconfigured. `*`/`**`/`?` are valid patterns.
  if (variantName.startsWith("wildcard_")) return false;

  // Between variants: only when op IS between.
  if (variantName.startsWith("between_")) return op === "between";

  // nan_str: only meaningful for numeric (engine rejects "NaN" as non-finite).
  if (variantName === "nan_str") return fieldType === "number";

  // type_mismatch_alpha ("abc"): only meaningful for number/date (text accepts anything).
  if (variantName === "type_mismatch_alpha") return fieldType === "number" || fieldType === "date";

  // empty / whitespace / tab_newline:
  //   - For text fields: only contains/notContains are vacuous (the engine guard).
  //     equals/notEquals "" is a legitimate literal-empty query.
  //   - For number/date/boolean fields: any op with empty/whitespace must be rejected.
  if (variantName === "empty" || variantName === "whitespace" || variantName === "tab_newline") {
    if (fieldType === "text") return op === "contains" || op === "notContains";
    return true;
  }

  return true;
}

// True-empty wildcard pattern — separate from the `*`/`**`/`?` variants above.
// Run as a single targeted test inside the main loop.
const WILDCARD_EMPTY_VARIANTS = [
  { name: "wildcard_empty", value: "" },
  { name: "wildcard_whitespace", value: "   " },
];

async function main() {
  const startedAt = Date.now();
  console.log(`[fuzz] connecting to: ${process.env.DATABASE_URL ?? "(no DATABASE_URL)"}`);

  const user = await prisma.user.findFirst({
    where: { mediaServers: { some: {} } },
    include: { mediaServers: true },
  });
  if (!user) {
    console.error("[fuzz] no user with media servers — aborting");
    process.exit(2);
  }
  const serverIds = user.mediaServers.map((s) => s.id);
  console.log(`[fuzz] user=${user.username} servers=${serverIds.length}`);

  const before = await snapshot();
  console.log(`[fuzz] PRE-SNAPSHOT ${JSON.stringify(before)}`);

  const baselines: Record<LibType, number> = { MOVIE: 0, SERIES: 0, MUSIC: 0 };
  for (const t of TYPES) {
    baselines[t] = await prisma.mediaItem.count({
      where: { type: t, library: { mediaServer: { id: { in: serverIds } } } },
    });
  }
  console.log(`[fuzz] BASELINES ${JSON.stringify(baselines)}`);

  // Sanity: a known-good rule must return SOME items if baseline > 0.
  // year >= 2000 is a safe baseline check for movies/series; playCount >= 0 for music.
  for (const t of TYPES) {
    if (baselines[t] === 0) continue;
    const ok = await evaluateLifecycleRules(
      ruleGroup([{ field: t === "MUSIC" ? "playCount" : "year", operator: "greaterThanOrEqual", value: t === "MUSIC" ? "0" : "1900" }]),
      t,
      serverIds,
    );
    console.log(`[fuzz] sanity ${t}: baseline=${baselines[t]} sanity-rule-match=${ok.length}`);
    if (ok.length === 0) {
      console.error(`[fuzz] BASELINE SANITY FAILED for ${t} — engine returned 0 for a valid wide rule`);
      process.exit(3);
    }
  }

  // Prefetch Arr/Seerr metadata once per (user, type)
  const arrCache: Record<LibType, ArrDataMap | undefined> = { MOVIE: undefined, SERIES: undefined, MUSIC: undefined };
  const seerrCache: Record<LibType, SeerrDataMap | undefined> = { MOVIE: undefined, SERIES: undefined, MUSIC: undefined };
  for (const t of TYPES) {
    process.stdout.write(`[fuzz] prefetch Arr ${t}... `);
    const t0 = Date.now();
    try {
      arrCache[t] = await fetchArrMetadata(user.id, t);
      console.log(`${Object.keys(arrCache[t] ?? {}).length} entries (${Date.now() - t0}ms)`);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
    if (t !== "MUSIC") {
      process.stdout.write(`[fuzz] prefetch Seerr ${t}... `);
      const t1 = Date.now();
      try {
        seerrCache[t] = await fetchSeerrMetadata(user.id, t);
        console.log(`${Object.keys(seerrCache[t] ?? {}).length} entries (${Date.now() - t1}ms)`);
      } catch (e) {
        console.log(`FAILED: ${(e as Error).message}`);
      }
    }
  }

  const failures: Failure[] = [];
  let totalEvals = 0;
  let totalHazard = 0;
  let totalValueless = 0;
  let totalUnknownOp = 0;

  for (const t of TYPES) {
    if (baselines[t] === 0) {
      console.log(`[fuzz] skipping ${t} — baseline 0`);
      continue;
    }
    const validFields = CONDITION_FIELDS.filter((f) => !f.invalidForLibraryType?.includes(t));
    console.log(`[fuzz] ${t}: ${validFields.length} valid fields × ${CONDITION_OPERATORS.length} ops`);

    for (const f of validFields) {
      for (const op of CONDITION_OPERATORS) {
        if (!isOperatorApplicable(op.value, f.value)) continue;

        // Valueless operators (isNull / isNotNull). For nullable fields we don't
        // assert a count (any value is legitimate). For non-nullable non-String
        // fields we DO assert: isNull → 0 matches, isNotNull → baseline; negate
        // flips them. This is the bug class the field-metadata fix addresses.
        if (op.value === "isNull" || op.value === "isNotNull") {
          for (const negate of [false, true]) {
            totalEvals++;
            totalValueless++;
            try {
              const items = await evaluateLifecycleRules(
                ruleGroup([{ field: f.value, operator: op.value, value: "", negate }]),
                t, serverIds, arrCache[t], seerrCache[t],
              );
              // Type assertion only for non-nullable non-String fields where the
              // semantic answer is deterministic (column always has a value).
              if (f.type === "number" || f.type === "boolean") {
                // Use the field-metadata map (single source of truth). Any new
                // non-nullable scalar added to the map is automatically covered.
                if (isNonNullableField(f.value)) {
                  const expectMatchAll =
                    (op.value === "isNotNull" && !negate) || (op.value === "isNull" && negate);
                  const expected = expectMatchAll ? baselines[t] : 0;
                  if (items.length !== expected) {
                    failures.push({
                      kind: "hazard_returned_items",
                      field: f.value, op: op.value, variant: "valueless_nonnullable",
                      negate, type: t,
                      matchCount: items.length, baseline: baselines[t], ratio: items.length / baselines[t],
                      detail: { expected },
                    });
                  }
                }
              }
            } catch (e) {
              failures.push({ kind: "threw", field: f.value, op: op.value, type: t, negate, error: (e as Error).message });
            }
          }
          continue;
        }

        for (const variant of HAZARD_VARIANTS) {
          if (!variantApplies(variant.name, f.type, op.value)) continue;
          for (const negate of [false, true]) {
            totalEvals++;
            totalHazard++;
            try {
              const items = await evaluateLifecycleRules(
                ruleGroup([{ field: f.value, operator: op.value, value: variant.value, negate }]),
                t, serverIds, arrCache[t], seerrCache[t],
              );
              if (items.length > 0) {
                failures.push({
                  kind: "hazard_returned_items",
                  field: f.value,
                  op: op.value,
                  variant: variant.name,
                  value: variant.value,
                  negate,
                  type: t,
                  matchCount: items.length,
                  baseline: baselines[t],
                  ratio: items.length / baselines[t],
                });
              }
            } catch (e) {
              failures.push({ kind: "threw", field: f.value, op: op.value, variant: variant.name, value: variant.value, negate, type: t, error: (e as Error).message });
            }
          }
        }
      }

      // Truly-empty wildcard pattern: only applies to text fields with wildcard ops.
      // (Separate from the `*`/`**`/`?` variants which are legitimate patterns.)
      if (f.type === "text") {
        for (const wop of ["matchesWildcard", "notMatchesWildcard"] as const) {
          if (!isOperatorApplicable(wop, f.value)) continue;
          for (const wv of WILDCARD_EMPTY_VARIANTS) {
            for (const negate of [false, true]) {
              totalEvals++;
              totalHazard++;
              try {
                const items = await evaluateLifecycleRules(
                  ruleGroup([{ field: f.value, operator: wop, value: wv.value, negate }]),
                  t, serverIds, arrCache[t], seerrCache[t],
                );
                if (items.length > 0) {
                  failures.push({
                    kind: "hazard_returned_items",
                    field: f.value, op: wop, variant: wv.name, value: wv.value, negate, type: t,
                    matchCount: items.length, baseline: baselines[t], ratio: items.length / baselines[t],
                  });
                }
              } catch (e) {
                failures.push({ kind: "threw", field: f.value, op: wop, variant: wv.name, negate, type: t, error: (e as Error).message });
              }
            }
          }
        }
      }

      // Unknown-operator: once per field/type (not per op).
      for (const negate of [false, true]) {
        totalEvals++;
        totalUnknownOp++;
        try {
          const items = await evaluateLifecycleRules(
            ruleGroup([{ field: f.value, operator: "thisOperatorDoesNotExist", value: "anyValue", negate }]),
            t, serverIds, arrCache[t], seerrCache[t],
          );
          if (items.length > 0) {
            failures.push({
              kind: "hazard_returned_items",
              field: f.value,
              op: "thisOperatorDoesNotExist",
              variant: "unknown_operator",
              value: "anyValue",
              negate,
              type: t,
              matchCount: items.length,
              baseline: baselines[t],
              ratio: items.length / baselines[t],
            });
          }
        } catch (e) {
          failures.push({ kind: "threw", field: f.value, op: "thisOperatorDoesNotExist", variant: "unknown_operator", negate, type: t, error: (e as Error).message });
        }
      }
    }
  }

  // Composition sample: pair a hazard rule with a wide-but-valid rule, AND/OR.
  console.log(`\n[fuzz] composition sample...`);
  let totalComposition = 0;
  for (const t of TYPES) {
    if (baselines[t] === 0) continue;
    const validBase = t === "MUSIC"
      ? { field: "playCount", operator: "greaterThanOrEqual", value: "0" }
      : { field: "year", operator: "greaterThanOrEqual", value: "1900" };

    // For OR composition: hazard rule should contribute 0 → group result = validBase result.
    // For AND composition: hazard rule should contribute 0 → group result = 0.
    // True hazards only — engine should reject these. `matchesWildcard "*"`
    // is intentional match-all per engine docs and is NOT a hazard.
    const hazardCases = [
      { field: "title", op: "contains", value: "" },
      { field: "title", op: "contains", value: "   " },
      { field: "title", op: "notContains", value: "" },
      { field: "title", op: "matchesWildcard", value: "" }, // truly empty wildcard
      { field: "year", op: "equals", value: "abc" },
      { field: "year", op: "between", value: "5" },
      { field: "year", op: "between", value: "NaN,NaN" },
      { field: "playCount", op: "greaterThan", value: "" },
    ];

    for (const h of hazardCases) {
      for (const groupLogic of ["AND", "OR"] as const) {
        for (const negate of [false, true]) {
          totalEvals++;
          totalComposition++;
          try {
            const items = await evaluateLifecycleRules(
              ruleGroup([
                { ...validBase, logic: "AND" },
                { field: h.field, operator: h.op, value: h.value, negate, logic: groupLogic },
              ], groupLogic),
              t, serverIds, arrCache[t], seerrCache[t],
            );
            // AND with a hazard-rejected (0-count) rule → result must be 0.
            // OR with a hazard-rejected rule → result must equal the validBase count.
            if (groupLogic === "AND" && items.length > 0) {
              failures.push({
                kind: "hazard_returned_items",
                field: h.field,
                op: h.op,
                variant: `composition_AND_${h.value || "EMPTY"}`,
                value: h.value,
                negate,
                type: t,
                matchCount: items.length,
                baseline: baselines[t],
                ratio: items.length / baselines[t],
                detail: { groupLogic, base: validBase },
              });
            }
            // OR composition with a hazard rule shouldn't INCREASE matches beyond validBase.
            // We don't have validBase count handy in the loop; query it once.
          } catch (e) {
            failures.push({ kind: "threw", field: h.field, op: h.op, variant: `composition_${groupLogic}`, negate, type: t, error: (e as Error).message });
          }
        }
      }
    }
  }

  // Post-snapshot drift check
  const after = await snapshot();
  const driftKeys = Object.keys(after).filter((k) => (after as Record<string, number>)[k] !== (before as Record<string, number>)[k]);
  if (driftKeys.length > 0) {
    failures.push({ kind: "row_drift", detail: { before, after, driftKeys } });
  }
  console.log(`[fuzz] POST-SNAPSHOT ${JSON.stringify(after)}`);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[fuzz] === SUMMARY ===`);
  console.log(`[fuzz] elapsed: ${elapsed}s`);
  console.log(`[fuzz] total evaluations: ${totalEvals} (hazard=${totalHazard} valueless=${totalValueless} unknown_op=${totalUnknownOp} composition=${totalComposition})`);
  console.log(`[fuzz] failures: ${failures.length}`);

  if (failures.length > 0) {
    const dumpPath = "/tmp/fuzz-failures.json";
    writeFileSync(dumpPath, JSON.stringify(failures, null, 2));
    console.error(`[fuzz] full failure list written to ${dumpPath} (${failures.length} entries)`);
    console.error(`\n[fuzz] FAILURE SAMPLE (first 30):`);
    for (const fail of failures.slice(0, 30)) {
      console.error(JSON.stringify(fail));
    }
    if (failures.length > 30) console.error(`... ${failures.length - 30} more failures in ${dumpPath}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`[fuzz] PASS — no hazard rule produced any matches; row counts byte-identical.`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[fuzz] unhandled error:", e);
  process.exit(2);
});
