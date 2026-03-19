"use client";

import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { generatePseudocode, type PseudocodeLine } from "./pseudocode-generator";
import type { BaseRule, BaseGroup, BuilderConfig } from "./types";

interface PseudocodePanelProps<R extends BaseRule, G extends BaseGroup<R>> {
  groups: G[];
  config: BuilderConfig<R, G>;
  highlightedRuleIds?: Set<string>;
  /** Map of ruleId → actual item value (shown as hover tooltip on rule lines) */
  actualValues?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

function PseudocodeLineItem({
  line,
  green,
  actualValue,
}: {
  line: PseudocodeLine;
  green?: boolean;
  actualValue?: string;
}) {
  const paddingLeft = `${line.depth * 1.25}rem`;

  const highlightClass = green
    ? "bg-green-500/20 border-l-2 border-green-500 rounded-sm px-2"
    : "";

  if (line.type === "connector") {
    return (
      <div
        style={{ paddingLeft }}
        className={`text-xs font-semibold tracking-wide ${
          line.disabled
            ? "text-muted-foreground/40"
            : "text-primary/70"
        } ${highlightClass}`}
      >
        {line.text}
      </div>
    );
  }

  if (line.type === "group-start" || line.type === "group-end") {
    return (
      <div
        style={{ paddingLeft }}
        className={`font-semibold ${
          line.disabled
            ? "text-muted-foreground/40"
            : "text-foreground/80"
        } ${highlightClass}`}
      >
        {line.text}
      </div>
    );
  }

  if (line.type === "eval-open" || line.type === "eval-close") {
    return (
      <div
        style={{ paddingLeft }}
        className={`font-semibold ${
          line.disabled
            ? "text-muted-foreground/30"
            : "text-muted-foreground/50"
        } ${highlightClass}`}
      >
        {line.text}
      </div>
    );
  }

  // rule
  const ruleDiv = (
    <div
      style={{ paddingLeft }}
      className={`${
        line.disabled
          ? "text-muted-foreground/40 line-through"
          : "text-foreground"
      } ${highlightClass}`}
    >
      {line.text}
    </div>
  );

  if (actualValue) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{ruleDiv}</TooltipTrigger>
          <TooltipContent>Actual: {actualValue}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return ruleDiv;
}

// ---------------------------------------------------------------------------
// Group matching computation
// ---------------------------------------------------------------------------

/**
 * Evaluate AND/OR logic to classify each group as passing, partial, or failed.
 *
 * - **passing**: the group's AND/OR logic evaluates to TRUE (green)
 * - **partial**: some rules/subgroups match but the group doesn't pass (yellow)
 * - neither set → nothing matched (red)
 *
 * Items within a group are evaluated in the same order as the pseudocode
 * generator: rules first, then subgroups. Each item's `condition` (AND/OR)
 * determines how it combines with the running result.
 */
function computeGroupMatchStates<R extends BaseRule>(
  groups: BaseGroup<R>[],
  highlightedRuleIds: Set<string>,
): { passing: Set<string>; partial: Set<string>; evalPassing: Set<string> } {
  const passing = new Set<string>();
  const partial = new Set<string>();
  const evalPassing = new Set<string>();

  function check(group: BaseGroup<R>): { passes: boolean; hasAnyMatch: boolean } {
    if (group.enabled === false) return { passes: true, hasAnyMatch: false };

    const enabledRules = group.rules.filter((r) => r.enabled !== false);
    const enabledSubgroups = (group.groups ?? []).filter((g) => g.enabled !== false);

    if (enabledRules.length === 0 && enabledSubgroups.length === 0) {
      return { passes: true, hasAnyMatch: false };
    }

    // Build items in same order as pseudocode generator: rules first, then subgroups
    const allItems: Array<
      | { kind: "rule"; condition: string; id: string }
      | { kind: "group"; condition: string; group: BaseGroup<R> }
    > = [];
    for (const rule of enabledRules) {
      allItems.push({ kind: "rule", condition: rule.condition, id: rule.id });
    }
    for (const sg of enabledSubgroups) {
      allItems.push({ kind: "group", condition: sg.condition, group: sg });
    }

    // Detect mixed operators (same logic as pseudocode generator)
    const conditions = allItems.slice(1).map((item) =>
      item.kind === "rule" ? item.condition : item.condition,
    );
    const hasMixedOps = conditions.length >= 2 && new Set(conditions).size > 1;

    let hasAnyMatch = false;
    let combinedResult: boolean | null = null;

    for (let idx = 0; idx < allItems.length; idx++) {
      const item = allItems[idx];
      let itemPasses: boolean;

      if (item.kind === "rule") {
        itemPasses = highlightedRuleIds.has(item.id);
      } else {
        const sub = check(item.group);
        itemPasses = sub.passes;
        if (sub.hasAnyMatch) hasAnyMatch = true;
      }

      if (itemPasses) hasAnyMatch = true;

      if (combinedResult === null) {
        combinedResult = itemPasses;
      } else if (item.condition === "OR") {
        combinedResult = combinedResult || itemPasses;
      } else {
        combinedResult = combinedResult && itemPasses;
      }

      // Track intermediate eval-group results (after items 1 through N-2)
      if (hasMixedOps && idx >= 1 && idx < allItems.length - 1) {
        if (combinedResult) {
          evalPassing.add(`${group.id}-eval-${idx}`);
        }
      }
    }

    const passes = combinedResult ?? true;

    if (passes) {
      passing.add(group.id);
    } else if (hasAnyMatch) {
      partial.add(group.id);
    }

    return { passes, hasAnyMatch };
  }

  // Evaluate root-level sibling groups with intermediate eval tracking
  const rootConditions = groups.slice(1).map((g) => g.condition);
  const hasMixedRootOps = rootConditions.length >= 2 && new Set(rootConditions).size > 1;

  let rootCombined: boolean | null = null;
  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx];
    const sub = check(g);
    const itemPasses = sub.passes;

    if (rootCombined === null) {
      rootCombined = itemPasses;
    } else if (g.condition === "OR") {
      rootCombined = rootCombined || itemPasses;
    } else {
      rootCombined = rootCombined && itemPasses;
    }

    if (hasMixedRootOps && idx >= 1 && idx < groups.length - 1) {
      if (rootCombined) {
        evalPassing.add(`siblings-root-eval-${idx}`);
      }
    }
  }

  return { passing, partial, evalPassing };
}

// ---------------------------------------------------------------------------
// Segment tree (supports nested ranges)
// ---------------------------------------------------------------------------

type Segment =
  | { kind: "line"; line: PseudocodeLine; green?: boolean }
  | {
      kind: "range";
      segments: Segment[];
      color: "green" | "yellow" | "red" | "neutral" | "eval-pass" | "eval-fail" | "eval";
      key: string;
    };

function findGroupEndIndex(lines: PseudocodeLine[], startIdx: number): number {
  const groupId = lines[startIdx].groupId;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].type === "group-end" && lines[i].groupId === groupId) {
      return i;
    }
  }
  return lines.length - 1;
}

function findEvalCloseIndex(lines: PseudocodeLine[], startIdx: number): number {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].type === "eval-open") depth++;
    if (lines[i].type === "eval-close") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return lines.length - 1;
}

/**
 * Recursively build a segment tree from a slice of pseudocode lines.
 * Fully matched groups → green range (all lines plain inside).
 * Partially matched groups → yellow range with per-rule green highlights.
 * Unmatched groups → red range with per-rule green highlights for matched rules.
 */
function buildSegmentTree(
  lines: PseudocodeLine[],
  start: number,
  end: number,
  passingGroupIds: Set<string>,
  partiallyMatchedGroupIds: Set<string>,
  highlightedRuleIds: Set<string>,
  evalPassingIds: Set<string>,
): Segment[] {
  const result: Segment[] = [];
  let i = start;

  while (i <= end) {
    const line = lines[i];

    if (line.type === "group-start" && line.groupId) {
      const groupEndIdx = findGroupEndIndex(lines, i);

      // All groups recursively process inner content for per-rule highlighting
      const innerSegments: Segment[] = [];
      innerSegments.push({ kind: "line", line: lines[i] });
      const inner = buildSegmentTree(
        lines, i + 1, groupEndIdx - 1,
        passingGroupIds, partiallyMatchedGroupIds, highlightedRuleIds,
        evalPassingIds,
      );
      innerSegments.push(...inner);
      innerSegments.push({ kind: "line", line: lines[groupEndIdx] });

      const color = highlightedRuleIds.size === 0
        ? "neutral"
        : passingGroupIds.has(line.groupId)
          ? "green"
          : partiallyMatchedGroupIds.has(line.groupId)
            ? "yellow"
            : "red";
      result.push({
        kind: "range",
        segments: innerSegments,
        color,
        key: `range-${line.groupId}`,
      });

      i = groupEndIdx + 1;
      continue;
    }

    // Eval-open: wrap content up to matching eval-close in an eval range
    if (line.type === "eval-open") {
      const evalCloseIdx = findEvalCloseIndex(lines, i);
      const innerSegments: Segment[] = [];
      innerSegments.push({ kind: "line", line: lines[i] });
      const inner = buildSegmentTree(
        lines, i + 1, evalCloseIdx - 1,
        passingGroupIds, partiallyMatchedGroupIds, highlightedRuleIds,
        evalPassingIds,
      );
      innerSegments.push(...inner);
      innerSegments.push({ kind: "line", line: lines[evalCloseIdx] });

      // Determine eval range color from the evalId on the open line
      let evalColor: "eval-pass" | "eval-fail" | "eval" = "eval";
      if (highlightedRuleIds.size > 0 && line.evalId) {
        evalColor = evalPassingIds.has(line.evalId) ? "eval-pass" : "eval-fail";
      }

      result.push({
        kind: "range",
        segments: innerSegments,
        color: evalColor,
        key: `eval-${lines[i].id}`,
      });
      i = evalCloseIdx + 1;
      continue;
    }

    // Individual line (rule or connector between groups)
    const isMatchedRule =
      line.type === "rule" &&
      !!line.ruleId &&
      highlightedRuleIds.has(line.ruleId);

    result.push({ kind: "line", line, green: isMatchedRule || undefined });
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Recursive segment renderer
// ---------------------------------------------------------------------------

function renderSegments(
  segments: Segment[],
  actualValues?: Map<string, string>,
): React.ReactNode[] {
  return segments.map((seg) => {
    if (seg.kind === "range") {
      if (seg.color === "eval-pass" || seg.color === "eval-fail" || seg.color === "eval") {
        const evalClass =
          seg.color === "eval-pass"
            ? "bg-gradient-to-r from-green-500/10 to-transparent border-2 border-green-500/30"
            : seg.color === "eval-fail"
              ? "bg-gradient-to-r from-red-500/10 to-transparent border-2 border-red-500/30"
              : "border-2 border-muted-foreground/20";
        return (
          <div
            key={seg.key}
            className={`${evalClass} rounded-sm px-2 space-y-0.5`}
          >
            {renderSegments(seg.segments, actualValues)}
          </div>
        );
      }
      const bgClass =
        seg.color === "neutral"
          ? "bg-muted-foreground/5 border-l-2 border-muted-foreground/20"
          : seg.color === "green"
            ? "bg-green-500/15 border-l-2 border-green-500"
            : seg.color === "yellow"
              ? "bg-yellow-500/15 border-l-2 border-yellow-500"
              : "bg-red-500/15 border-l-2 border-red-500";
      return (
        <div key={seg.key} className={`${bgClass} rounded-sm px-2 space-y-0.5`}>
          {renderSegments(seg.segments, actualValues)}
        </div>
      );
    }
    const ruleActualValue =
      seg.line.type === "rule" && seg.line.ruleId
        ? actualValues?.get(seg.line.ruleId)
        : undefined;
    return (
      <PseudocodeLineItem
        key={seg.line.id}
        line={seg.line}
        green={seg.green}
        actualValue={ruleActualValue}
      />
    );
  });
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

export function PseudocodePanel<
  R extends BaseRule,
  G extends BaseGroup<R>,
>({ groups, config, highlightedRuleIds, actualValues }: PseudocodePanelProps<R, G>) {
  const lines = useMemo(
    () => generatePseudocode(groups, config),
    [groups, config],
  );

  const groupMatchStates = useMemo(() => {
    if (!highlightedRuleIds || highlightedRuleIds.size === 0) return undefined;
    return computeGroupMatchStates(groups, highlightedRuleIds);
  }, [groups, highlightedRuleIds]);

  const segments = useMemo(() => {
    if (!highlightedRuleIds || highlightedRuleIds.size === 0 || !groupMatchStates) {
      // No highlighting — build segment tree with neutral group colors and eval outlines
      return buildSegmentTree(
        lines, 0, lines.length - 1,
        new Set(), new Set(), new Set(), new Set(),
      );
    }
    return buildSegmentTree(
      lines, 0, lines.length - 1,
      groupMatchStates.passing, groupMatchStates.partial, highlightedRuleIds,
      groupMatchStates.evalPassing,
    );
  }, [lines, groupMatchStates, highlightedRuleIds]);

  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Add rules to see the logic preview
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <h3 className="text-sm font-medium mb-3 text-muted-foreground">
        Logic Preview
      </h3>
      <div className="font-mono text-sm leading-relaxed space-y-0.5">
        {renderSegments(segments, actualValues)}
      </div>
    </div>
  );
}
