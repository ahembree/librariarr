"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { useState, useId, useCallback, memo } from "react";
import {
  DndContext,
  closestCenter,
  rectIntersection,
  pointerWithin,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Plus,
  Trash2,
  Layers,
  ChevronDown,
  GripVertical,
  Eye,
  EyeOff,
  Copy,
  ArrowUpToLine,
  MoreVertical,
  Film,
  Monitor,
  Volume2,
  Radio,
  HardDrive,
  Activity,
  Link,
  Server,
  Bell,
  Tv,
  Calculator,
  Network,
  type LucideIcon,
} from "lucide-react";
import type { RuleCondition } from "@/lib/rules/types";
import type {
  BaseRule,
  BaseGroup,
  BaseBuilderProps,
  BuilderConfig,
  FieldContext,
} from "./types";
import { AudioLines } from "lucide-react";

/** Map section keys to icons */
const SECTION_ICONS: Record<string, LucideIcon> = {
  content: Film,
  video: Monitor,
  audio: Volume2,
  streams: Radio,
  streamQuery: AudioLines,
  file: HardDrive,
  activity: Activity,
  external: Link,
  arrStatus: Server,
  arrMedia: Server,
  arrEpisodes: Server,
  seerr: Bell,
  series: Tv,
  computed: Calculator,
  cross: Network,
};

const STREAM_TYPE_LABELS: Record<string, string> = {
  audio: "Audio",
  video: "Video",
  subtitle: "Subtitle",
};

import {
  updateGroupInTree,
  deepCloneRule,
  deepCloneGroup,
  findRuleInTree,
  findSubGroupInTree,
  parseItemId,
  isDescendantOrSelf,
  countAllRules,
} from "./tree-utils";

// ─── SortableRuleRow ────────────────────────────────────────────────────────

function SortableRuleRowImpl<R extends BaseRule, G extends BaseGroup<R>>({
  rule,
  groupId,
  isFirst,
  distinctValues,
  config,
  fieldContext,
  onUpdate,
  onRemove,
  onDuplicate,
  onToggleEnabled,
  onConditionChange,
}: {
  rule: R;
  groupId: string;
  isFirst: boolean;
  distinctValues?: Record<string, string[]>;
  config: BuilderConfig<R, G>;
  fieldContext: FieldContext;
  onUpdate: (groupId: string, ruleId: string, updates: Partial<R>) => void;
  onRemove: (groupId: string, ruleId: string) => void;
  onDuplicate: (groupId: string, ruleId: string) => void;
  onToggleEnabled: (groupId: string, ruleId: string) => void;
  onConditionChange: (ruleId: string, condition: RuleCondition) => void;
}) {
  const sortableId = `${groupId}:${rule.id}`;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const fieldDef = config.fields.find((f) => f.value === rule.field);
  const fieldType = fieldDef?.type ?? "text";
  const applicableOperators = config.operators.filter((op) =>
    op.types.includes(fieldType),
  );
  const enumerable = fieldDef?.enumerable ?? false;
  const knownVals = fieldDef?.knownValues;
  const distinctVals = distinctValues?.[rule.field];
  const dropdownValues =
    enumerable || fieldType === "boolean"
      ? [...new Set([...(knownVals ?? []), ...(distinctVals ?? [])])]
      : [];

  const isNullOp = config.isValuelessOperator?.(rule.operator) ?? false;

  const useSingleDropdown =
    !isNullOp &&
    (fieldType === "boolean" ||
      (enumerable &&
        (rule.operator === "equals" || rule.operator === "notEquals"))) &&
    dropdownValues.length > 0;

  const useMultiSelect =
    !isNullOp &&
    enumerable &&
    (rule.operator === "contains" || rule.operator === "notContains") &&
    dropdownValues.length > 0;

  const selectedValues = useMultiSelect
    ? String(rule.value).split("|").filter(Boolean)
    : [];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex flex-wrap items-center gap-2 ${rule.enabled === false ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Inline AND/OR condition selector */}
      {!isFirst && (
        <Select
          value={rule.condition}
          onValueChange={(v) => onConditionChange(rule.id, v as RuleCondition)}
        >
          <SelectTrigger className="w-20 h-8 text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AND">AND</SelectItem>
            <SelectItem value="OR">OR</SelectItem>
          </SelectContent>
        </Select>
      )}

      <div className="flex gap-2 w-full sm:w-auto">
        {/* Field selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="flex-1 sm:flex-none sm:w-45 justify-between font-normal">
              <span className="truncate">{fieldDef?.label ?? rule.field}</span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 max-w-[90vw] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
            {config.sections.map((section) => {
              if (config.isSectionHidden?.(section.key, fieldContext))
                return null;
              const sectionFields = config.fields.filter(
                (f) => f.section === section.key,
              );
              if (sectionFields.length === 0) return null;
              return (
                <DropdownMenuSub key={section.key}>
                  <DropdownMenuSubTrigger>
                    {(() => {
                      const Icon = SECTION_ICONS[section.key];
                      return Icon ? <Icon className="mr-2 h-4 w-4 text-muted-foreground" /> : null;
                    })()}
                    {section.label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52 max-w-[calc(100vw-2rem)] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
                    {sectionFields.map((f) => {
                      const disabled = config.isFieldDisabled(
                        f.value,
                        fieldContext,
                      );
                      const tooltip = config.getDisabledTooltip(
                        f.value,
                        fieldContext,
                      );
                      if (disabled && tooltip) {
                        return (
                          <TooltipProvider key={f.value}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div>
                                  <DropdownMenuItem disabled>
                                    {f.label}
                                  </DropdownMenuItem>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="left">
                                {tooltip}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        );
                      }
                      return (
                        <DropdownMenuItem
                          key={f.value}
                          onSelect={() =>
                            onUpdate(groupId, rule.id, { field: f.value } as Partial<R>)
                          }
                        >
                          {f.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Operator selector */}
        <Select
          value={rule.operator}
          onValueChange={(v) => {
            const update: Partial<R> = { operator: v } as Partial<R>;
            if (v === "between" && !String(rule.value).includes(",")) {
              (update as Record<string, unknown>).value = `${rule.value},`;
            } else if (v !== "between" && rule.operator === "between") {
              (update as Record<string, unknown>).value = String(rule.value).split(",")[0] ?? "";
            }
            onUpdate(groupId, rule.id, update);
          }}
        >
          <SelectTrigger className="flex-1 sm:flex-none sm:w-42.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {applicableOperators.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {fieldType === "date" && o.dateLabel ? o.dateLabel : o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Value input — varies by operator type */}
      {isNullOp ? (
        <span className="text-xs text-muted-foreground italic px-2">
          No value needed
        </span>
      ) : useMultiSelect ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="flex-1 justify-start font-normal h-9 px-3"
            >
              <span className="truncate">
                {selectedValues.length === 0
                  ? "Select values..."
                  : selectedValues.length <= 2
                    ? selectedValues.join(", ")
                    : `${selectedValues.length} selected`}
              </span>
              <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 max-w-[90vw] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search..." />
              <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup>
                  {dropdownValues.map((v) => {
                    const isSelected = selectedValues.includes(v);
                    return (
                      <CommandItem
                        key={v}
                        onSelect={() => {
                          const newValues = isSelected
                            ? selectedValues.filter((s) => s !== v)
                            : [...selectedValues, v];
                          onUpdate(groupId, rule.id, {
                            value: newValues.join("|"),
                          } as Partial<R>);
                        }}
                      >
                        <div
                          className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border ${isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50"}`}
                        >
                          {isSelected && <span className="text-xs">✓</span>}
                        </div>
                        {v}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
            {selectedValues.length > 0 && (
              <div className="border-t p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() =>
                    onUpdate(groupId, rule.id, { value: "" } as Partial<R>)
                  }
                >
                  Clear all
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      ) : useSingleDropdown ? (
        <Select
          value={String(rule.value)}
          onValueChange={(v) =>
            onUpdate(groupId, rule.id, { value: v } as Partial<R>)
          }
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select value..." />
          </SelectTrigger>
          <SelectContent>
            {dropdownValues.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : rule.operator === "between" ? (
        <div className="flex items-center gap-1 flex-1">
          <Input
            type={fieldType === "date" ? "date" : "number"}
            value={String(rule.value).split(",")[0] ?? ""}
            onChange={(e) => {
              const parts = String(rule.value).split(",");
              onUpdate(groupId, rule.id, {
                value: `${e.target.value},${parts[1] ?? ""}`,
              } as Partial<R>);
            }}
            placeholder={fieldType === "date" ? "From" : "Min"}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            type={fieldType === "date" ? "date" : "number"}
            value={String(rule.value).split(",")[1] ?? ""}
            onChange={(e) => {
              const parts = String(rule.value).split(",");
              onUpdate(groupId, rule.id, {
                value: `${parts[0] ?? ""},${e.target.value}`,
              } as Partial<R>);
            }}
            placeholder={fieldType === "date" ? "To" : "Max"}
            className="flex-1"
          />
        </div>
      ) : (
        <Input
          type={
            fieldType === "number"
              ? "number"
              : fieldType === "date" && rule.operator !== "inLastDays" && rule.operator !== "notInLastDays"
                ? "date"
                : "text"
          }
          value={rule.value}
          onChange={(e) =>
            onUpdate(groupId, rule.id, {
              value: e.target.value,
            } as Partial<R>)
          }
          placeholder={
            rule.operator === "inLastDays" || rule.operator === "notInLastDays"
              ? "Number of days"
              : rule.operator === "matchesWildcard" ||
                  rule.operator === "notMatchesWildcard"
                ? "e.g. *4k* or anime-??"
                : fieldType === "date"
                  ? "YYYY-MM-DD"
                  : "Value"
          }
          className="flex-1"
        />
      )}

      {/* Negate toggle */}
      <div className="flex items-center gap-1 shrink-0" title="Negate this condition">
        <Switch
          checked={rule.negate ?? false}
          onCheckedChange={(checked) =>
            onUpdate(groupId, rule.id, { negate: checked } as Partial<R>)
          }
          className="scale-75"
        />
        <span
          className={`text-xs ${rule.negate ? "text-red-400 font-medium" : "text-muted-foreground"}`}
        >
          NOT
        </span>
      </div>

      {/* Desktop: individual icon buttons */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onToggleEnabled(groupId, rule.id)}
        className="shrink-0 hidden sm:inline-flex"
        aria-label={rule.enabled === false ? "Enable condition" : "Disable condition"}
        title={rule.enabled === false ? "Enable condition" : "Disable condition"}
      >
        {rule.enabled === false ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDuplicate(groupId, rule.id)}
        className="shrink-0 hidden sm:inline-flex"
        aria-label="Duplicate condition"
        title="Duplicate condition"
      >
        <Copy className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onRemove(groupId, rule.id)}
        className="shrink-0 hidden sm:inline-flex"
        aria-label="Remove condition"
        title="Remove condition"
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      {/* Mobile: collapsed dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-9 w-9 sm:hidden"
            aria-label="More actions"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => onToggleEnabled(groupId, rule.id)}
          >
            {rule.enabled === false ? (
              <EyeOff className="mr-2 h-4 w-4" />
            ) : (
              <Eye className="mr-2 h-4 w-4" />
            )}
            {rule.enabled === false ? "Enable" : "Disable"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDuplicate(groupId, rule.id)}
          >
            <Copy className="mr-2 h-4 w-4" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onRemove(groupId, rule.id)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {(rule.operator === "matchesWildcard" ||
        rule.operator === "notMatchesWildcard") && (
        <p className="w-full pl-6 text-xs text-muted-foreground">
          Use <code className="px-1 py-0.5 rounded bg-muted">*</code> to match
          any characters and{" "}
          <code className="px-1 py-0.5 rounded bg-muted">?</code> to match a
          single character
        </p>
      )}
    </div>
  );
}
const SortableRuleRow = memo(SortableRuleRowImpl) as typeof SortableRuleRowImpl;

// ─── Shared constants ────────────────────────────────────────────────────────

const BORDER_COLORS = [
  "border-border",
  "border-blue-500/30",
  "border-purple-500/30",
  "border-green-500/30",
];
const ACTIVE_BORDER_COLORS = [
  "border-2 border-muted-foreground/70",
  "border-2 border-blue-400/80",
  "border-2 border-purple-400/80",
  "border-2 border-green-400/80",
];
const BG_COLORS = [
  "bg-muted/30",
  "bg-blue-500/5",
  "bg-purple-500/5",
  "bg-green-500/5",
];

// ─── GroupCard ───────────────────────────────────────────────────────────────

function GroupCardImpl<R extends BaseRule, G extends BaseGroup<R>>({
  group,
  depth,
  distinctValues,
  config,
  fieldContext,
  onUpdateTree,
  dragHandleProps,
  onDuplicateGroup,
  onToggleGroupEnabled,
  onPromoteToRoot,
  dragOverGroupId,
}: {
  group: G;
  depth: number;
  distinctValues?: Record<string, string[]>;
  config: BuilderConfig<R, G>;
  fieldContext: FieldContext;
  onUpdateTree: (groupId: string, updater: (g: G) => G | null) => void;
  dragHandleProps?: Record<string, unknown>;
  onDuplicateGroup?: () => void;
  onToggleGroupEnabled?: () => void;
  onPromoteToRoot?: (groupId: string) => void;
  dragOverGroupId?: string | null;
}) {
  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop:${group.id}`,
  });
  const isOver = dragOverGroupId === group.id;
  const subGroups = (group.groups ?? []) as G[];
  const ruleSortableIds = group.rules.map((r) => `${group.id}:${r.id}`);
  const subGroupSortableIds = subGroups.map(
    (sg) => `sg:${group.id}:${sg.id}`,
  );

  const handleUpdateRule = useCallback((
    groupId: string,
    ruleId: string,
    updates: Partial<R>,
  ) => {
    onUpdateTree(groupId, (g) => ({
      ...g,
      rules: g.rules.map((r) => {
        if (r.id !== ruleId) return r;
        const updated = { ...r, ...updates };
        if (updates.field) {
          const ft =
            config.fields.find((f) => f.value === updates.field)?.type ??
            "text";
          const applicable = config.operators.filter((op) =>
            op.types.includes(ft),
          );
          if (!applicable.find((op) => op.value === updated.operator)) {
            updated.operator = applicable[0]?.value ?? "equals";
          }
          updated.value = "";
        }
        // When switching between multi-select and single/text operators on enumerable fields
        if (updates.operator && !updates.field) {
          const fieldEnumerable =
            config.fields.find((f) => f.value === r.field)?.enumerable ?? false;
          if (fieldEnumerable) {
            const wasMulti =
              r.operator === "contains" || r.operator === "notContains";
            const isMulti =
              updated.operator === "contains" ||
              updated.operator === "notContains";
            if (wasMulti && !isMulti) {
              updated.value = String(r.value).split("|")[0] || "";
            }
          }
        }
        return updated;
      }),
    }));
  }, [onUpdateTree, config]);

  const handleRemoveRule = useCallback((groupId: string, ruleId: string) => {
    onUpdateTree(groupId, (g) => {
      const filtered = g.rules.filter((r) => r.id !== ruleId);
      // Auto-delete unnamed groups when they become empty
      if (filtered.length === 0 && (!g.groups || g.groups.length === 0) && !g.name) {
        return null;
      }
      return { ...g, rules: filtered };
    });
  }, [onUpdateTree]);

  const handleAddRule = useCallback(() => {
    onUpdateTree(group.id, (g) => {
      const newRule = config.createRule();
      // Default stream query rules to first applicable field
      if (g.streamQuery && config.getStreamQueryFieldsForType) {
        const sqFields = config.getStreamQueryFieldsForType(g.streamQuery.streamType);
        if (sqFields.length > 0) {
          (newRule as BaseRule).field = sqFields[0].value;
        }
      }
      return { ...g, rules: [...g.rules, newRule] };
    });
  }, [onUpdateTree, group.id, config]);

  const handleAddSubGroup = useCallback(() => {
    onUpdateTree(group.id, (g) => ({
      ...g,
      groups: [
        ...(g.groups ?? []),
        config.createGroup("AND"),
      ],
    }));
  }, [onUpdateTree, group.id, config]);

  const handleAddStreamQuery = useCallback(() => {
    if (!config.createStreamQueryGroup) return;
    onUpdateTree(group.id, (g) => ({
      ...g,
      groups: [
        ...(g.groups ?? []),
        config.createStreamQueryGroup!("audio", "AND"),
      ],
    }));
  }, [onUpdateTree, group.id, config]);

  const handleUpdateRuleCondition = useCallback((ruleId: string, condition: RuleCondition) => {
    onUpdateTree(group.id, (g) => ({
      ...g,
      rules: g.rules.map((r) =>
        r.id === ruleId ? { ...r, condition } : r,
      ),
    }));
  }, [onUpdateTree, group.id]);

  const handleUpdateSubGroupCondition = useCallback((subGroupId: string, condition: RuleCondition) => {
    onUpdateTree(subGroupId, (g) => ({ ...g, condition }));
  }, [onUpdateTree]);

  const handleRemoveGroup = useCallback(() => {
    onUpdateTree(group.id, () => null);
  }, [onUpdateTree, group.id]);

  const handleDuplicateRule = useCallback((groupId: string, ruleId: string) => {
    onUpdateTree(groupId, (g) => {
      const idx = g.rules.findIndex((r) => r.id === ruleId);
      if (idx === -1) return g;
      const cloned = deepCloneRule(g.rules[idx] as R);
      const newRules = [...g.rules];
      newRules.splice(idx + 1, 0, cloned);
      return { ...g, rules: newRules };
    });
  }, [onUpdateTree]);

  const handleToggleRuleEnabled = useCallback((groupId: string, ruleId: string) => {
    onUpdateTree(groupId, (g) => ({
      ...g,
      rules: g.rules.map((r) =>
        r.id === ruleId
          ? { ...r, enabled: r.enabled === false ? undefined : false }
          : r,
      ),
    }));
  }, [onUpdateTree]);

  const isEmptyGroup = group.rules.length === 0 && (!group.groups || group.groups.length === 0);
  const canDeleteGroup = depth > 0 || isEmptyGroup;
  const isStreamQuery = !!group.streamQuery;

  // For stream query groups, swap in stream query fields/sections
  const effectiveConfig = isStreamQuery && config.getStreamQueryFieldsForType
    ? {
        ...config,
        fields: config.getStreamQueryFieldsForType(group.streamQuery!.streamType),
        sections: config.streamQuerySections ?? [],
      }
    : config;

  return (
    <Card
      ref={setDropRef}
      className={`p-3 sm:p-4 space-y-2 overflow-hidden ${BG_COLORS[depth % BG_COLORS.length]} ${isOver ? ACTIVE_BORDER_COLORS[depth % ACTIVE_BORDER_COLORS.length] : BORDER_COLORS[depth % BORDER_COLORS.length]} ${group.enabled === false ? "opacity-50" : ""} ${isStreamQuery ? "border-primary/30" : ""}`}
    >
      {/* Stream query name - positioned at top-left, separate from the query logic */}
      {isStreamQuery && (
        <Input
          value={group.name ?? ""}
          onChange={(e) =>
            onUpdateTree(group.id, (g) => ({
              ...g,
              name: e.target.value || undefined,
            }))
          }
          placeholder="Name (optional)"
          className="h-8 max-w-48 text-xs"
        />
      )}
      {/* Group header */}
      <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {dragHandleProps && (
            <button
              type="button"
              className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none"
              {...dragHandleProps}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}
          {group.streamQuery ? (
            <>
              <AudioLines className="h-4 w-4 shrink-0 text-primary" />
              <Select
                value={group.streamQuery.quantifier ?? "any"}
                onValueChange={(v) =>
                  onUpdateTree(group.id, (g) => ({
                    ...g,
                    streamQuery: { ...g.streamQuery!, quantifier: v as "any" | "none" | "all" },
                  }))
                }
              >
                <SelectTrigger className="w-20 h-8 text-xs font-medium text-primary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">ANY</SelectItem>
                  <SelectItem value="none">NO</SelectItem>
                  <SelectItem value="all">ALL</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={group.streamQuery.streamType}
                onValueChange={(v) =>
                  onUpdateTree(group.id, (g) => ({
                    ...g,
                    streamQuery: { ...g.streamQuery!, streamType: v },
                    // Clear rules when stream type changes since fields differ
                    rules: g.streamQuery?.streamType !== v ? [] : g.rules,
                  }))
                }
              >
                <SelectTrigger className="w-24 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="audio">{STREAM_TYPE_LABELS.audio}</SelectItem>
                  <SelectItem value="video">{STREAM_TYPE_LABELS.video}</SelectItem>
                  <SelectItem value="subtitle">{STREAM_TYPE_LABELS.subtitle}</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs font-medium text-primary whitespace-nowrap">
                stream where
              </span>
            </>
          ) : (
            <>
              <Input
                value={group.name ?? ""}
                onChange={(e) =>
                  onUpdateTree(group.id, (g) => ({
                    ...g,
                    name: e.target.value || undefined,
                  }))
                }
                placeholder="Group name (optional)"
                className="h-8 flex-1 text-xs"
              />
              <span className="text-xs text-muted-foreground">
                conditions
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {/* Desktop: individual icon buttons */}
          {onToggleGroupEnabled && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hidden sm:inline-flex"
              onClick={onToggleGroupEnabled}
              aria-label={group.enabled === false ? "Enable group" : "Disable group"}
              title={
                group.enabled === false ? "Enable group" : "Disable group"
              }
            >
              {group.enabled === false ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          {onPromoteToRoot && depth > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hidden sm:inline-flex"
              onClick={() => onPromoteToRoot(group.id)}
              aria-label="Promote to root group"
              title="Promote to root group"
            >
              <ArrowUpToLine className="h-3.5 w-3.5" />
            </Button>
          )}
          {onDuplicateGroup && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hidden sm:inline-flex"
              onClick={onDuplicateGroup}
              aria-label="Duplicate group"
              title="Duplicate group"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDeleteGroup && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hidden sm:inline-flex"
              onClick={handleRemoveGroup}
              aria-label="Remove group"
              title="Remove group"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}

          {/* Mobile: collapsed dropdown */}
          {(onToggleGroupEnabled || onPromoteToRoot || onDuplicateGroup || canDeleteGroup) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 sm:hidden"
                  aria-label="More group actions"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onToggleGroupEnabled && (
                  <DropdownMenuItem onClick={onToggleGroupEnabled}>
                    {group.enabled === false ? (
                      <EyeOff className="mr-2 h-4 w-4" />
                    ) : (
                      <Eye className="mr-2 h-4 w-4" />
                    )}
                    {group.enabled === false
                      ? "Enable group"
                      : "Disable group"}
                  </DropdownMenuItem>
                )}
                {onPromoteToRoot && depth > 0 && (
                  <DropdownMenuItem onClick={() => onPromoteToRoot(group.id)}>
                    <ArrowUpToLine className="mr-2 h-4 w-4" />
                    Promote to root
                  </DropdownMenuItem>
                )}
                {onDuplicateGroup && (
                  <DropdownMenuItem onClick={onDuplicateGroup}>
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate group
                  </DropdownMenuItem>
                )}
                {canDeleteGroup && (
                  <DropdownMenuItem
                    onClick={handleRemoveGroup}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove group
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Rules */}
      <SortableContext
        items={ruleSortableIds}
        strategy={verticalListSortingStrategy}
      >
        {group.rules.map((rule, index) => (
          <SortableRuleRow
            key={rule.id}
            rule={rule as R}
            groupId={group.id}
            isFirst={index === 0}
            distinctValues={distinctValues}
            config={effectiveConfig}
            fieldContext={fieldContext}
            onUpdate={handleUpdateRule}
            onRemove={handleRemoveRule}
            onDuplicate={handleDuplicateRule}
            onToggleEnabled={handleToggleRuleEnabled}
            onConditionChange={handleUpdateRuleCondition}
          />
        ))}
      </SortableContext>

      {/* Sub-groups (not shown inside stream query groups) */}
      {!isStreamQuery && subGroups.length > 0 && (
        <SortableContext
          items={subGroupSortableIds}
          strategy={verticalListSortingStrategy}
        >
          {subGroups.map((sub, index) => (
            <div key={sub.id}>
              {(index > 0 || group.rules.length > 0) && (
                <div className="flex justify-center py-1">
                  <Select
                    value={sub.condition}
                    onValueChange={(v) => handleUpdateSubGroupCondition(sub.id, v as RuleCondition)}
                  >
                    <SelectTrigger className="w-20 h-6 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AND">AND</SelectItem>
                      <SelectItem value="OR">OR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <SortableGroupCard
                group={sub}
                parentGroupId={group.id}
                depth={depth + 1}
                distinctValues={distinctValues}
                config={config}
                fieldContext={fieldContext}
                onUpdateTree={onUpdateTree}
                dragOverGroupId={dragOverGroupId}
                onDuplicateGroup={() => {
                  onUpdateTree(group.id, (g) => {
                    const subs = (g.groups ?? []) as G[];
                    const idx = subs.findIndex((sg) => sg.id === sub.id);
                    if (idx === -1) return g;
                    const cloned = deepCloneGroup<R, G>(subs[idx]);
                    const newSubs = [...subs];
                    newSubs.splice(idx + 1, 0, cloned);
                    return { ...g, groups: newSubs };
                  });
                }}
                onToggleGroupEnabled={() => {
                  onUpdateTree(sub.id, (g) => ({
                    ...g,
                    enabled: g.enabled === false ? undefined : false,
                  }));
                }}
                onPromoteToRoot={onPromoteToRoot}
              />
            </div>
          ))}
        </SortableContext>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          onClick={handleAddRule}
          variant="ghost"
          size="sm"
          className="flex-1 text-muted-foreground"
        >
          <Plus className="mr-1 h-3 w-3" />
          Add Condition
        </Button>
        {!isStreamQuery && (
          <>
            <Button
              onClick={handleAddSubGroup}
              variant="ghost"
              size="sm"
              className="flex-1 text-muted-foreground"
            >
              <Layers className="mr-1 h-3 w-3" />
              Add Sub-group
            </Button>
            {config.createStreamQueryGroup && (
              <Button
                onClick={handleAddStreamQuery}
                variant="ghost"
                size="sm"
                className="flex-1 text-muted-foreground"
              >
                <AudioLines className="mr-1 h-3 w-3" />
                Stream Query
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
const GroupCard = memo(GroupCardImpl) as typeof GroupCardImpl;

// ─── SortableGroupCard ──────────────────────────────────────────────────────

function SortableGroupCardImpl<R extends BaseRule, G extends BaseGroup<R>>({
  group,
  parentGroupId,
  depth,
  distinctValues,
  config,
  fieldContext,
  onUpdateTree,
  onDuplicateGroup,
  onToggleGroupEnabled,
  onPromoteToRoot,
  dragOverGroupId,
}: {
  group: G;
  parentGroupId: string;
  depth: number;
  distinctValues?: Record<string, string[]>;
  config: BuilderConfig<R, G>;
  fieldContext: FieldContext;
  onUpdateTree: (groupId: string, updater: (g: G) => G | null) => void;
  onDuplicateGroup?: () => void;
  onToggleGroupEnabled?: () => void;
  onPromoteToRoot?: (groupId: string) => void;
  dragOverGroupId?: string | null;
}) {
  const sortableId = `sg:${parentGroupId}:${group.id}`;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <GroupCard
        group={group}
        depth={depth}
        distinctValues={distinctValues}
        config={config}
        fieldContext={fieldContext}
        onUpdateTree={onUpdateTree}
        dragHandleProps={{ ...attributes, ...listeners }}
        onDuplicateGroup={onDuplicateGroup}
        onToggleGroupEnabled={onToggleGroupEnabled}
        onPromoteToRoot={onPromoteToRoot}
        dragOverGroupId={dragOverGroupId}
      />
    </div>
  );
}
const SortableGroupCard = memo(SortableGroupCardImpl) as typeof SortableGroupCardImpl;

// ─── Collision detection ─────────────────────────────────────────────────────
// Prefer sortable items (rules/sub-groups) over group drop-zones so that
// within-group reordering works. Fall back to pointerWithin on drop-zones
// so that cross-group highlights only appear when the pointer is actually
// inside the target group card.
//
// For sub-group drags, ancestor sub-group sortable IDs are excluded from the
// sortable hit check. Ancestors (e.g. sg:A:B when dragging sg:C:D) have large
// rects that swallow collision hits, preventing the drop-zone fallback needed
// for cross-level moves. The active item's own drop zone is also excluded so
// it can't be dropped into itself.
const sortableFirstCollision: CollisionDetection = (args) => {
  const activeStr = String(args.active.id);
  const activeParsed = parseItemId(activeStr);

  // Build set of ancestor sortable IDs to exclude for sub-group drags.
  // For top-level groups (parentGroupId === "root"), there are no ancestors
  // to exclude, but we still need to exclude the dragged item's own sortable
  // ID and any descendant group IDs to prevent self-nesting.
  const ancestorIds = new Set<string>();
  if (activeParsed?.type === "subgroup") {
    const childToSortable = new Map<string, string>();
    for (const c of args.droppableContainers) {
      const id = String(c.id);
      if (id.startsWith("sg:")) {
        const p = parseItemId(id);
        if (p) childToSortable.set(p.itemId, id);
      }
    }
    // Walk up from the parent to exclude ancestor sortable containers
    let cur: string | undefined = activeParsed.parentGroupId;
    while (cur && cur !== "root") {
      const sid = childToSortable.get(cur);
      if (sid) {
        ancestorIds.add(sid);
        cur = parseItemId(sid)?.parentGroupId;
      } else {
        break;
      }
    }
  }

  const sortableOnly = {
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => {
      const id = String(c.id);
      if (id.startsWith("drop:")) return false;
      if (ancestorIds.has(id)) return false;
      return true;
    }),
  };
  const sortableHits = rectIntersection(sortableOnly);
  if (sortableHits.length > 0) {
    const bestHits = closestCenter(sortableOnly);

    // When the pointer is in the center zone (middle 40%) of a sub-group
    // card, return its drop zone instead to allow nesting inside it.
    // The top/bottom 30% remain as reorder zones.
    if (bestHits.length > 0 && args.pointerCoordinates) {
      const topId = String(bestHits[0].id);
      if (topId.startsWith("sg:")) {
        const container = args.droppableContainers.find(
          (c) => String(c.id) === topId,
        );
        const rect = container?.rect.current;
        if (rect) {
          // Use middle 40% of the card OR at least 30px, whichever is larger
          const centerSize = Math.max(30, rect.height * 0.4);
          const centerTop = rect.top + (rect.height - centerSize) / 2;
          const centerBottom = centerTop + centerSize;
          if (
            args.pointerCoordinates.y > centerTop &&
            args.pointerCoordinates.y < centerBottom
          ) {
            const parsed = parseItemId(topId);
            if (parsed) {
              return [{ id: `drop:${parsed.itemId}` }];
            }
          }
        }
      }
    }

    return bestHits;
  }

  // No sortable hits — check drop zones, excluding invalid targets
  const excludeDropIds = new Set<string>();
  if (activeParsed?.type === "subgroup") {
    // Can't drop a group into itself
    excludeDropIds.add(`drop:${activeParsed.itemId}`);
    // If already top-level, exclude drop:root (already at root)
    if (activeParsed.parentGroupId === "root") {
      excludeDropIds.add("drop:root");
    }
  } else if (activeParsed?.type === "rule") {
    // Rules can't be promoted to root level
    excludeDropIds.add("drop:root");
  }
  return pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (c) => !excludeDropIds.has(String(c.id)),
    ),
  });
};

// ─── BaseBuilder ────────────────────────────────────────────────────────────

export function BaseBuilder<R extends BaseRule, G extends BaseGroup<R>>({
  groups,
  onChange,
  distinctValues,
  config,
  fieldContext,
}: BaseBuilderProps<R, G>) {
  const dndId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const addGroup = useCallback(() => {
    onChange([...groups, config.createGroup()]);
  }, [groups, onChange, config]);

  const updateGroupCondition = useCallback((
    groupId: string,
    condition: RuleCondition,
  ) => {
    onChange(groups.map((g) => (g.id === groupId ? { ...g, condition } : g)));
  }, [groups, onChange]);

  const handleUpdateTree = useCallback((
    groupId: string,
    updater: (g: G) => G | null,
  ) => {
    onChange(updateGroupInTree(groups, groupId, updater));
  }, [groups, onChange]);

  const handlePromoteToRoot = useCallback((groupId: string) => {
    const found = findSubGroupInTree<R, G>(groups, groupId);
    if (!found) return;
    // Remove from parent (with auto-delete of empty unnamed parents)
    let updated = updateGroupInTree(groups, found.parentGroupId, (g) => {
      const filtered = (g.groups ?? []).filter((sg) => sg.id !== groupId);
      if (g.rules.length === 0 && filtered.length === 0 && !g.name) return null;
      return { ...g, groups: filtered };
    });
    // Append to root level
    updated = [...updated, found.group];
    onChange(updated);
  }, [groups, onChange]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) { setDragOverGroupId(null); return; }
    const activeStr = String(active.id);
    const overStr = String(over.id);
    const activeParsedLocal = parseItemId(activeStr);
    const activeGroupId = activeStr.startsWith("drop:") ? activeStr.slice(5) : activeParsedLocal?.parentGroupId ?? null;
    const overGroupId = overStr.startsWith("drop:") ? overStr.slice(5) : parseItemId(overStr)?.parentGroupId ?? null;
    // Only highlight when dragging to a different group (including "root")
    if (overGroupId && overGroupId !== activeGroupId) {
      setDragOverGroupId(overGroupId);
    } else {
      setDragOverGroupId(null);
    }
  }, []);

  // Helper: remove a group/subgroup from wherever it lives in the tree.
  // For top-level groups (parentGroupId === "root"), filters from the
  // top-level array directly. For nested sub-groups, uses updateGroupInTree.
  const removeGroupFromTree = useCallback((
    tree: G[],
    parentGroupId: string,
    itemId: string,
  ): G[] => {
    if (parentGroupId === "root") {
      return tree.filter((g) => g.id !== itemId);
    }
    return updateGroupInTree(tree, parentGroupId, (g) => {
      const filtered = (g.groups ?? []).filter((sg) => sg.id !== itemId);
      // Auto-delete unnamed empty parent groups
      if (g.rules.length === 0 && filtered.length === 0 && !g.name) {
        return null;
      }
      return { ...g, groups: filtered };
    });
  }, []);

  // Helper: find a group node by its item ID, checking both top-level and nested.
  const findGroupNode = useCallback((itemId: string): G | undefined => {
    const topLevel = groups.find((g) => g.id === itemId);
    if (topLevel) return topLevel;
    const found = findSubGroupInTree<R, G>(groups, itemId);
    return found?.group;
  }, [groups]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    setDragOverGroupId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeStr = String(active.id);
    const overStr = String(over.id);

    const activeParsed = parseItemId(activeStr);
    if (!activeParsed) return;

    // ── Dropped on a drop zone (id starts with "drop:") ──────────────
    if (overStr.startsWith("drop:")) {
      const targetGroupId = overStr.slice(5);
      if (targetGroupId === activeParsed.parentGroupId) return;

      if (activeParsed.type === "rule") {
        // Rule dropped on drop zone — only valid for non-root targets
        if (targetGroupId === "root") return;
        const found = findRuleInTree<R, G>(groups, activeParsed.itemId);
        if (!found) return;

        let updated = removeGroupFromTree(groups, activeParsed.parentGroupId, activeParsed.itemId);
        // For rules, we remove from the parent's rules array (not groups)
        // Re-do removal properly for rules:
        updated = activeParsed.parentGroupId === "root"
          ? groups // rules can't be at root level
          : updateGroupInTree(groups, activeParsed.parentGroupId, (g) => ({
              ...g,
              rules: g.rules.filter((r) => r.id !== activeParsed.itemId),
            }));
        updated = updateGroupInTree(updated, targetGroupId, (g) => ({
          ...g,
          rules: [...g.rules, found.rule],
        }));
        onChange(updated);
        return;
      }

      // Sub-group / top-level group dropped on a drop zone
      const draggedGroup = findGroupNode(activeParsed.itemId);
      if (!draggedGroup) return;

      if (targetGroupId === "root") {
        // Promote: sub-group → top-level group
        if (activeParsed.parentGroupId === "root") return; // already top-level
        let updated = removeGroupFromTree(groups, activeParsed.parentGroupId, activeParsed.itemId);
        updated = [...updated, draggedGroup];
        onChange(updated);
      } else {
        // Demote: top-level / cross-parent move → sub-group of target
        if (targetGroupId === activeParsed.itemId) return; // can't drop into self
        if (isDescendantOrSelf(draggedGroup, targetGroupId)) return;
        let updated = removeGroupFromTree(groups, activeParsed.parentGroupId, activeParsed.itemId);
        updated = updateGroupInTree(updated, targetGroupId, (g) => ({
          ...g,
          groups: [...(g.groups ?? []), draggedGroup],
        }));
        onChange(updated);
      }
      return;
    }

    // ── Dropped on another sortable item ──────────────────────────────
    const overParsed = parseItemId(overStr);
    if (!overParsed) return;

    if (activeParsed.type === "rule" && overParsed.type === "rule") {
      if (activeParsed.parentGroupId === overParsed.parentGroupId) {
        // Within-group reorder
        onChange(
          updateGroupInTree(groups, activeParsed.parentGroupId, (g) => {
            const oldIndex = g.rules.findIndex(
              (r) => r.id === activeParsed.itemId,
            );
            const newIndex = g.rules.findIndex(
              (r) => r.id === overParsed.itemId,
            );
            if (oldIndex === -1 || newIndex === -1) return g;
            return { ...g, rules: arrayMove(g.rules, oldIndex, newIndex) };
          }),
        );
      } else {
        // Cross-group rule move
        const found = findRuleInTree<R, G>(groups, activeParsed.itemId);
        if (!found) return;

        let updated = updateGroupInTree(
          groups,
          activeParsed.parentGroupId,
          (g) => ({
            ...g,
            rules: g.rules.filter((r) => r.id !== activeParsed.itemId),
          }),
        );
        updated = updateGroupInTree(
          updated,
          overParsed.parentGroupId,
          (g) => {
            const overIndex = g.rules.findIndex(
              (r) => r.id === overParsed.itemId,
            );
            const newRules = [...g.rules];
            newRules.splice(
              overIndex === -1 ? newRules.length : overIndex,
              0,
              found.rule,
            );
            return { ...g, rules: newRules };
          },
        );
        onChange(updated);
      }
    } else if (
      activeParsed.type === "subgroup" &&
      overParsed.type === "subgroup"
    ) {
      if (
        activeParsed.parentGroupId === overParsed.parentGroupId
      ) {
        if (activeParsed.parentGroupId === "root") {
          // Top-level group reorder
          const oldIndex = groups.findIndex(
            (g) => g.id === activeParsed.itemId,
          );
          const newIndex = groups.findIndex(
            (g) => g.id === overParsed.itemId,
          );
          if (oldIndex === -1 || newIndex === -1) return;
          onChange(arrayMove([...groups], oldIndex, newIndex));
        } else {
          // Within-parent sub-group reorder
          onChange(
            updateGroupInTree(groups, activeParsed.parentGroupId, (g) => {
              const subs = (g.groups ?? []) as G[];
              const oldIndex = subs.findIndex(
                (sg) => sg.id === activeParsed.itemId,
              );
              const newIndex = subs.findIndex(
                (sg) => sg.id === overParsed.itemId,
              );
              if (oldIndex === -1 || newIndex === -1) return g;
              return { ...g, groups: arrayMove(subs, oldIndex, newIndex) };
            }),
          );
        }
      } else {
        // Cross-parent group move (sub-group ↔ sub-group, or top-level ↔ sub-group)
        const draggedGroup = findGroupNode(activeParsed.itemId);
        if (!draggedGroup) return;
        if (isDescendantOrSelf(draggedGroup, overParsed.parentGroupId))
          return;

        let updated = removeGroupFromTree(groups, activeParsed.parentGroupId, activeParsed.itemId);

        if (overParsed.parentGroupId === "root") {
          // Moving into top-level: insert at position
          const overIndex = updated.findIndex(
            (g) => g.id === overParsed.itemId,
          );
          const newGroups = [...updated];
          newGroups.splice(
            overIndex === -1 ? newGroups.length : overIndex,
            0,
            draggedGroup,
          );
          onChange(newGroups);
        } else {
          // Moving into another parent group
          updated = updateGroupInTree(
            updated,
            overParsed.parentGroupId,
            (g) => {
              const subs = (g.groups ?? []) as G[];
              const overIndex = subs.findIndex(
                (sg) => sg.id === overParsed.itemId,
              );
              const newSubs = [...subs];
              newSubs.splice(
                overIndex === -1 ? newSubs.length : overIndex,
                0,
                draggedGroup,
              );
              return { ...g, groups: newSubs };
            },
          );
          onChange(updated);
        }
      }
    } else if (
      activeParsed.type === "subgroup" &&
      overParsed.type === "rule"
    ) {
      // Cross-type: group dropped near a rule in another group
      if (activeParsed.parentGroupId === overParsed.parentGroupId) return;
      const draggedGroup = findGroupNode(activeParsed.itemId);
      if (!draggedGroup) return;
      if (isDescendantOrSelf(draggedGroup, overParsed.parentGroupId))
        return;

      let updated = removeGroupFromTree(groups, activeParsed.parentGroupId, activeParsed.itemId);
      updated = updateGroupInTree(
        updated,
        overParsed.parentGroupId,
        (g) => ({
          ...g,
          groups: [...(g.groups ?? []), draggedGroup],
        }),
      );
      onChange(updated);
    } else if (
      activeParsed.type === "rule" &&
      overParsed.type === "subgroup"
    ) {
      // Cross-type: rule dropped near a group in another parent
      if (activeParsed.parentGroupId === overParsed.parentGroupId) return;
      const found = findRuleInTree<R, G>(groups, activeParsed.itemId);
      if (!found) return;

      let updated = updateGroupInTree(
        groups,
        activeParsed.parentGroupId,
        (g) => ({
          ...g,
          rules: g.rules.filter((r) => r.id !== activeParsed.itemId),
        }),
      );
      if (overParsed.parentGroupId === "root") {
        // Rule dropped near a top-level group — find target group and add
        const targetGroup = updated.find(
          (g) => g.id === overParsed.itemId,
        );
        if (targetGroup) {
          updated = updateGroupInTree(updated, targetGroup.id, (g) => ({
            ...g,
            rules: [...g.rules, found.rule],
          }));
        }
      } else {
        updated = updateGroupInTree(
          updated,
          overParsed.parentGroupId,
          (g) => ({
            ...g,
            rules: [...g.rules, found.rule],
          }),
        );
      }
      onChange(updated);
    }
  }, [groups, onChange, findGroupNode, removeGroupFromTree]);

  // Build overlay content for the actively dragged item
  const dragOverlayContent = (() => {
    if (!activeId) return null;
    const parsed = parseItemId(activeId);
    if (!parsed) return null;

    if (parsed.type === "rule") {
      const found = findRuleInTree<R, G>(groups, parsed.itemId);
      if (!found) return null;
      const fieldLabel =
        config.fields.find((f) => f.value === found.rule.field)?.label ??
        found.rule.field;
      const fieldType = config.fields.find((f) => f.value === found.rule.field)?.type;
      const opDef = config.operators.find((o) => o.value === found.rule.operator);
      const opLabel = (fieldType === "date" && opDef?.dateLabel) ? opDef.dateLabel : (opDef?.label ?? found.rule.operator);
      return (
        <div className="flex items-center gap-2 rounded-md border bg-background p-3 shadow-lg max-w-md">
          <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm truncate">
            {fieldLabel} {opLabel} {found.rule.value}
          </span>
        </div>
      );
    } else {
      // Check nested sub-groups first, then top-level groups
      let overlayGroup: G | undefined;
      const foundSub = findSubGroupInTree<R, G>(groups, parsed.itemId);
      if (foundSub) {
        overlayGroup = foundSub.group;
      } else {
        overlayGroup = groups.find((g) => g.id === parsed.itemId) as G | undefined;
      }
      if (!overlayGroup) return null;
      const ruleCount = countAllRules([overlayGroup]);
      const isTopLevel = parsed.parentGroupId === "root";
      return (
        <Card className="p-3 shadow-lg max-w-md">
          <div className="flex items-center gap-2">
            <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm">
              {isTopLevel ? (overlayGroup.name || "Group") : "Sub-group"} &middot;{" "}
              {ruleCount} condition{ruleCount !== 1 ? "s" : ""}
            </span>
          </div>
        </Card>
      );
    }
  })();

  const topLevelSortableIds = groups.map((g) => `sg:root:${g.id}`);

  const { setNodeRef: setRootDropRef } = useDroppable({ id: "drop:root" });

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={sortableFirstCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-3">
        <SortableContext
          items={topLevelSortableIds}
          strategy={verticalListSortingStrategy}
        >
          {groups.map((group, groupIndex) => (
            <div key={group.id}>
              {/* Connector between top-level groups */}
              {groupIndex > 0 && (
                <div className="flex justify-center py-2">
                  <Select
                    value={group.condition}
                    onValueChange={(v) =>
                      updateGroupCondition(group.id, v as RuleCondition)
                    }
                  >
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AND">AND</SelectItem>
                      <SelectItem value="OR">OR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <SortableGroupCard
                group={group}
                parentGroupId="root"
                depth={0}
                distinctValues={distinctValues}
                config={config}
                fieldContext={fieldContext}
                onUpdateTree={handleUpdateTree}
                dragOverGroupId={dragOverGroupId}
                onDuplicateGroup={() => {
                  const cloned = deepCloneGroup<R, G>(group);
                  const newGroups = [...groups];
                  newGroups.splice(groupIndex + 1, 0, cloned);
                  onChange(newGroups);
                }}
                onToggleGroupEnabled={() => {
                  onChange(
                    groups.map((g) =>
                      g.id === group.id
                        ? {
                            ...g,
                            enabled:
                              g.enabled === false ? undefined : false,
                          }
                        : g,
                    ),
                  );
                }}
                onPromoteToRoot={handlePromoteToRoot}
              />
            </div>
          ))}
        </SortableContext>

        {/* Root drop zone — visible during drag for promoting sub-groups */}
        <div
          ref={setRootDropRef}
          className={`border-2 border-dashed rounded-lg p-3 text-center text-sm text-muted-foreground transition-colors ${
            activeId
              ? dragOverGroupId === "root"
                ? "border-primary bg-primary/5"
                : "border-muted"
              : "hidden"
          }`}
        >
          Drop here to create a new group
        </div>

        <Button onClick={addGroup} variant="outline" className="w-full">
          <Plus className="mr-2 h-4 w-4" />
          Add Group
        </Button>
      </div>

      <DragOverlay dropAnimation={null}>{dragOverlayContent}</DragOverlay>
    </DndContext>
  );
}
