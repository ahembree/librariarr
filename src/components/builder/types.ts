import type { RuleCondition } from "@/lib/rules/types";

/** Constraint for any rule type (Rule & QueryRule both satisfy this) */
export interface BaseRule {
  id: string;
  field: string;
  operator: string;
  value: string | number;
  condition: RuleCondition;
  negate?: boolean;
  enabled?: boolean;
}

/** Constraint for any group type (RuleGroup & QueryGroup both satisfy this) */
export interface BaseGroup<R extends BaseRule = BaseRule> {
  id: string;
  name?: string;
  condition: RuleCondition;
  operator?: RuleCondition;
  rules: R[];
  groups: BaseGroup<R>[];
  enabled?: boolean;
  /** When set, this group is a stream query — rules apply to individual stream records */
  streamQuery?: { streamType: string; quantifier?: "any" | "none" | "all" };
}

/** Field definition (both RuleFieldDef and QueryFieldDef match this shape) */
export interface FieldDef {
  value: string;
  label: string;
  type: "number" | "text" | "date" | "boolean";
  section: string;
  enumerable?: boolean;
  knownValues?: string[];
}

/** Operator definition */
export interface OperatorDef {
  value: string;
  label: string;
  /** Optional label shown when the selected field is a date type */
  dateLabel?: string;
  types: ("number" | "text" | "date" | "boolean")[];
}

/** Section definition */
export interface SectionDef {
  key: string;
  label: string;
}

/** Runtime context passed to config callbacks (integration booleans + domain extras) */
export interface FieldContext {
  arrConnected?: boolean;
  seerrConnected?: boolean;
  [key: string]: unknown;
}

/** Static configuration capturing all behavioral differences between builder variants */
export interface BuilderConfig<R extends BaseRule, G extends BaseGroup<R>> {
  fields: FieldDef[];
  operators: OperatorDef[];
  sections: SectionDef[];
  createRule: () => R;
  createGroup: (condition?: RuleCondition) => G;
  isFieldDisabled: (field: string, ctx: FieldContext) => boolean;
  getDisabledTooltip: (field: string, ctx: FieldContext) => string | null;
  isSectionHidden?: (sectionKey: string, ctx: FieldContext) => boolean;
  isValuelessOperator?: (op: string) => boolean;
  /** Stream query support — when provided, "Add Stream Query" button appears */
  streamQueryFields?: FieldDef[];
  streamQuerySections?: SectionDef[];
  /** Returns fields applicable to the given stream type */
  getStreamQueryFieldsForType?: (streamType: string) => FieldDef[];
  createStreamQueryGroup?: (streamType: string, condition?: RuleCondition) => G;
}

/** Props for BaseBuilder */
export interface BaseBuilderProps<R extends BaseRule, G extends BaseGroup<R>> {
  groups: G[];
  onChange: (groups: G[]) => void;
  distinctValues?: Record<string, string[]>;
  config: BuilderConfig<R, G>;
  fieldContext: FieldContext;
}
