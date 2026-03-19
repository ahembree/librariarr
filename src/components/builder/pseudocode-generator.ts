import type { BaseRule, BaseGroup, BuilderConfig } from "./types";

export interface PseudocodeLine {
  id: string;
  depth: number;
  type: "group-start" | "group-end" | "rule" | "connector" | "eval-open" | "eval-close";
  text: string;
  disabled: boolean;
  negated: boolean;
  ruleId?: string;
  /** The group's own ID (set on group-start and group-end lines) */
  groupId?: string;
  /** The immediate parent group's ID (set on rule, connector, and nested group lines) */
  parentGroupId?: string;
  /** Unique ID linking matching eval-open/eval-close pairs */
  evalId?: string;
}

const OPERATOR_DISPLAY: Record<string, string> = {
  equals: "=",
  notEquals: "!=",
  greaterThan: ">",
  greaterThanOrEqual: ">=",
  lessThan: "<",
  lessThanOrEqual: "<=",
  contains: "contains",
  notContains: "not contains",
  before: "before",
  after: "after",
  inLastDays: "in last",
  notInLastDays: "> ago",
  matchesWildcard: "matches",
  notMatchesWildcard: "not matches",
  isNull: "is empty",
  isNotNull: "is not empty",
};

const DAYS_SUFFIX_OPS = new Set(["inLastDays", "notInLastDays"]);
const VALUELESS_OPS = new Set(["isNull", "isNotNull"]);

let idCounter = 0;
function nextId(): string {
  return `pl-${++idCounter}`;
}

/**
 * Generate pseudocode lines from a rule group tree.
 * Pure function (aside from the monotonic ID counter which resets per call).
 */
export function generatePseudocode<
  R extends BaseRule,
  G extends BaseGroup<R>,
>(
  groups: G[],
  config: BuilderConfig<R, G>,
): PseudocodeLine[] {
  idCounter = 0;
  const fieldMap = new Map([
    ...config.fields.map((f) => [f.value, f] as const),
    ...(config.streamQueryFields ?? []).map((f) => [f.value, f] as const),
  ]);
  const opMap = new Map(config.operators.map((o) => [o.value, o]));
  const lines: PseudocodeLine[] = [];

  processGroups(groups, 0, false, undefined, lines, fieldMap, opMap, config);

  return lines;
}

function processGroups<R extends BaseRule, G extends BaseGroup<R>>(
  groups: G[],
  depth: number,
  parentDisabled: boolean,
  parentGroupId: string | undefined,
  lines: PseudocodeLine[],
  fieldMap: Map<string, { label: string; type: string }>,
  opMap: Map<string, { label: string; dateLabel?: string }>,
  config: BuilderConfig<R, G>,
): void {
  const enabledGroups = groups;

  // Detect mixed operators between sibling groups at this level
  const siblingConditions = enabledGroups.slice(1).map((g) => g.condition);
  const hasMixedSiblingOps = siblingConditions.length >= 2 && new Set(siblingConditions).size > 1;
  const siblingEvalCount = hasMixedSiblingOps ? enabledGroups.length - 2 : 0;

  // Push opening eval-group parens for sibling groups
  for (let p = 0; p < siblingEvalCount; p++) {
    lines.push({
      id: nextId(),
      depth,
      type: "eval-open",
      text: "(",
      disabled: parentDisabled,
      negated: false,
      parentGroupId,
      evalId: `siblings-${parentGroupId ?? "root"}-eval-${siblingEvalCount - p}`,
    });
  }

  for (let gi = 0; gi < enabledGroups.length; gi++) {
    const group = enabledGroups[gi];
    const groupDisabled = parentDisabled || group.enabled === false;

    // Connector between sibling groups
    if (gi > 0) {
      lines.push({
        id: nextId(),
        depth,
        type: "connector",
        text: group.condition,
        disabled: groupDisabled,
        negated: false,
        parentGroupId,
      });
    }

    // Group start
    const label = gi === 0 && depth === 0 ? "WHERE" : "";
    const nameStr = group.name ? `${group.name}: ` : "";
    const streamQueryPrefix = group.streamQuery
      ? `${(group.streamQuery.quantifier ?? "any") === "none" ? "NO" : (group.streamQuery.quantifier ?? "any") === "all" ? "ALL" : "ANY"} ${group.streamQuery.streamType} stream WHERE `
      : "";
    lines.push({
      id: nextId(),
      depth,
      type: "group-start",
      text: `${label}${label ? " " : ""}${streamQueryPrefix}(${nameStr}`.trimStart(),
      disabled: groupDisabled,
      negated: false,
      groupId: group.id,
      parentGroupId,
    });

    // Collect all items: rules and sub-groups, interleaved in order
    // Rules come first, then sub-groups (matching visual builder order)
    const innerDepth = depth + 1;
    const allItems: Array<{ kind: "rule"; rule: R } | { kind: "group"; group: G }> = [];
    for (const rule of group.rules) {
      allItems.push({ kind: "rule", rule });
    }
    for (const sg of (group.groups ?? []) as G[]) {
      allItems.push({ kind: "group", group: sg });
    }

    // Detect mixed AND/OR operators — if mixed, add evaluation grouping
    // parentheses to make left-to-right evaluation order visible.
    // e.g. A OR B AND C OR D → ((A OR B) AND C) OR D
    const conditions = allItems.slice(1).map((item) =>
      item.kind === "rule" ? item.rule.condition : item.group.condition,
    );
    const hasMixedOps = conditions.length >= 2 && new Set(conditions).size > 1;
    const evalGroupCount = hasMixedOps ? allItems.length - 2 : 0;

    // Push opening eval-group parens before items
    // p=0 is outermost, matches eval-close after item N-2
    // p=k matches eval-close after item N-2-k
    for (let p = 0; p < evalGroupCount; p++) {
      lines.push({
        id: nextId(),
        depth: innerDepth,
        type: "eval-open",
        text: "(",
        disabled: groupDisabled,
        negated: false,
        parentGroupId: group.id,
        evalId: `${group.id}-eval-${evalGroupCount - p}`,
      });
    }

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];

      // Connector between items — each item's condition specifies how
      // IT connects to the previous item (first item's condition is ignored)
      if (i > 0) {
        const connectorCondition =
          item.kind === "rule"
            ? item.rule.condition
            : item.group.condition;
        lines.push({
          id: nextId(),
          depth: innerDepth,
          type: "connector",
          text: connectorCondition,
          disabled: groupDisabled,
          negated: false,
          parentGroupId: group.id,
        });
      }

      if (item.kind === "rule") {
        const rule = item.rule;
        const ruleDisabled = groupDisabled || rule.enabled === false;
        const field = fieldMap.get(rule.field);
        const fieldLabel = field?.label ?? rule.field;
        const fieldType = field?.type ?? "text";
        const opDef = opMap.get(rule.operator);

        // Pick operator display text
        let opDisplay =
          OPERATOR_DISPLAY[rule.operator] ??
          (fieldType === "date" && opDef?.dateLabel
            ? opDef.dateLabel
            : opDef?.label ?? rule.operator);

        // For date fields, prefer dateLabel when available
        if (fieldType === "date" && opDef?.dateLabel && !OPERATOR_DISPLAY[rule.operator]) {
          opDisplay = opDef.dateLabel;
        }

        // Build value display
        let valueStr = "";
        if (
          !VALUELESS_OPS.has(rule.operator) &&
          !(config.isValuelessOperator?.(rule.operator))
        ) {
          const rawVal = String(rule.value).trim();
          if (DAYS_SUFFIX_OPS.has(rule.operator)) {
            valueStr = ` ${rawVal} days`;
          } else if (fieldType === "number") {
            valueStr = ` ${rawVal}`;
          } else {
            valueStr = ` "${rawVal}"`;
          }
        }

        const negatePrefix = rule.negate ? "NOT " : "";
        const text = `${negatePrefix}${fieldLabel} ${opDisplay}${valueStr}`;

        lines.push({
          id: nextId(),
          depth: innerDepth,
          type: "rule",
          text,
          disabled: ruleDisabled,
          negated: !!rule.negate,
          ruleId: rule.id,
          parentGroupId: group.id,
        });
      } else {
        // Recurse into sub-group
        processGroups(
          [item.group],
          innerDepth,
          groupDisabled,
          group.id,
          lines,
          fieldMap,
          opMap,
          config,
        );
      }

      // Close one eval-group paren after items 1 through N-2
      if (hasMixedOps && i >= 1 && i < allItems.length - 1) {
        lines.push({
          id: nextId(),
          depth: innerDepth,
          type: "eval-close",
          text: ")",
          disabled: groupDisabled,
          negated: false,
          parentGroupId: group.id,
          evalId: `${group.id}-eval-${i}`,
        });
      }
    }

    // Group end
    lines.push({
      id: nextId(),
      depth,
      type: "group-end",
      text: ")",
      disabled: groupDisabled,
      negated: false,
      groupId: group.id,
      parentGroupId,
    });

    // Close one sibling eval-group paren after groups 1 through N-2
    if (hasMixedSiblingOps && gi >= 1 && gi < enabledGroups.length - 1) {
      lines.push({
        id: nextId(),
        depth,
        type: "eval-close",
        text: ")",
        disabled: parentDisabled,
        negated: false,
        parentGroupId,
        evalId: `siblings-${parentGroupId ?? "root"}-eval-${gi}`,
      });
    }
  }
}
