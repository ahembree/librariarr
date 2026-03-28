"use client";

import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, SlidersHorizontal, ChevronRight, ChevronDown, Play, Calendar, Star, Hash, Plus, Trash2, AudioLines, Search, MonitorPlay, Volume2, Layers, BookOpen, Tv, File, type LucideIcon } from "lucide-react";
import { useIsMobile } from "@/hooks/use-is-mobile";

export interface MediaFilterValues {
  [key: string]: string;
}

interface MediaFiltersProps {
  onFilterChange: (filters: MediaFilterValues) => void;
  externalFilters?: MediaFilterValues;
  mediaType?: "MOVIE" | "SERIES" | "MUSIC";
  prefix?: React.ReactNode;
}

// Content rating sort order (most restrictive first)
const CONTENT_RATING_ORDER = [
  "NC-17", "TV-MA", "R", "Unrated",
  "TV-14", "PG-13",
  "TV-PG", "PG",
  "TV-G", "TV-Y7", "TV-Y", "G",
  "NR", "Not Rated",
];

function sortContentRatings(ratings: string[]): string[] {
  return [...ratings].sort((a, b) => {
    const ai = CONTENT_RATING_ORDER.indexOf(a);
    const bi = CONTENT_RATING_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

const CHANNEL_LABELS: Record<number, string> = {
  1: "Mono",
  2: "Stereo",
  3: "2.1",
  6: "5.1",
  8: "7.1",
};

function formatChannels(ch: number): string {
  return CHANNEL_LABELS[ch] ?? `${ch}ch`;
}

const MB = 1024 * 1024;

// Human-readable labels for filter keys
const FILTER_LABELS: Record<string, string> = {
  resolution: "Resolution",
  videoCodec: "Video Codec",
  dynamicRange: "Dynamic Range",
  videoBitDepth: "Bit Depth",
  videoProfile: "Video Profile",
  videoFrameRate: "Frame Rate",
  aspectRatio: "Aspect Ratio",
  scanType: "Scan Type",
  audioCodec: "Audio Codec",
  audioProfile: "Audio Profile",
  audioChannels: "Channels",
  audioSamplingRate: "Sample Rate",
  contentRating: "Rating",
  studio: "Studio",
  genre: "Genre",
  year: "Year",
  container: "Container",
  audioLanguage: "Audio Language",
  subtitleLanguage: "Subtitle Language",
  streamAudioCodec: "Stream Audio Codec",
  videoBitrate: "Video Bitrate",
  audioBitrate: "Audio Bitrate",
  audienceRating: "Audience Rating",
  isWatchlisted: "Watchlisted",
};

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Video: MonitorPlay,
  Audio: Volume2,
  "Stream Counts": Layers,
  Content: BookOpen,
  Series: Tv,
  File: File,
  Dates: Calendar,
};

function CategoryTrigger({ name, isOpen }: { name: string; isOpen: boolean }) {
  const Icon = CATEGORY_ICONS[name];
  return (
    <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />}
      <span className="flex-1 text-left text-[11px] font-semibold text-muted-foreground tracking-wide uppercase">
        {name}
      </span>
      <ChevronDown className={`h-3 w-3 text-muted-foreground/50 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
    </CollapsibleTrigger>
  );
}

type ComparisonOp = "eq" | "gt" | "lt" | "gte" | "lte";

const OP_LABELS: Record<ComparisonOp, string> = {
  eq: "=",
  gt: ">",
  lt: "<",
  gte: "\u2265",
  lte: "\u2264",
};

const OP_DESCRIPTIONS: Record<ComparisonOp, string> = {
  eq: "Equal to",
  gt: "Greater than",
  lt: "Less than",
  gte: "Greater or equal",
  lte: "Less or equal",
};

type DateMode = "date" | "days";

interface DistinctData {
  resolution?: string[];
  videoCodec?: string[];
  audioCodec?: string[];
  container?: string[];
  dynamicRange?: string[];
  audioProfile?: string[];
  contentRating?: string[];
  studio?: string[];
  genre?: string[];
  year?: number[];
  videoBitDepth?: number[];
  videoProfile?: string[];
  videoFrameRate?: string[];
  aspectRatio?: string[];
  scanType?: string[];
  audioChannels?: number[];
  audioSamplingRate?: number[];
  audioBitrate?: number[];
  fileSizeMin?: string | null;
  fileSizeMax?: string | null;
  durationMin?: number | null;
  durationMax?: number | null;
  playCountMin?: number | null;
  playCountMax?: number | null;
  ratingMin?: number | null;
  ratingMax?: number | null;
  audienceRatingMin?: number | null;
  audienceRatingMax?: number | null;
  lastPlayedAtMin?: string | null;
  lastPlayedAtMax?: string | null;
  addedAtMin?: string | null;
  addedAtMax?: string | null;
  // Stream-level distinct values
  audioLanguage?: string[];
  subtitleLanguage?: string[];
  streamAudioCodec?: string[];
  audioStreamCountMin?: number | null;
  audioStreamCountMax?: number | null;
  subtitleStreamCountMin?: number | null;
  subtitleStreamCountMax?: number | null;
}

// A single filter option within a category
interface FilterOption {
  key: string;
  label: string;
  values: { value: string; label: string }[];
}

// A category grouping filter options
interface FilterCategory {
  name: string;
  options: FilterOption[];
}

// Multi-select combobox for selecting values within a filter option
function FilterCombobox({
  option,
  selectedValues,
  onSelect,
}: {
  option: FilterOption;
  selectedValues: string[];
  onSelect: (key: string, values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const showSearch = option.values.length > 10;
  const count = selectedValues.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left"
        >
          <span className="flex items-center gap-2">
            {count > 0 && (
              <div className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-primary text-primary-foreground shrink-0">
                <span className="text-[9px] font-bold">{count}</span>
              </div>
            )}
            {count === 0 && <span className="w-3.5 shrink-0" />}
            {option.label}
          </span>
          <span className="flex items-center gap-1.5">
            {count > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal max-w-32 truncate">
                {count <= 2
                  ? selectedValues.map((v) => option.values.find((ov) => ov.value === v)?.label ?? v).join(", ")
                  : `${count} selected`}
              </Badge>
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={isMobile ? "bottom" : "right"}
        align="start"
        className="w-56 max-w-[calc(100vw-2rem)] p-0"
        sideOffset={isMobile ? 8 : 2}
      >
        <Command>
          {showSearch && <CommandInput placeholder={`Search ${option.label.toLowerCase()}...`} />}
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {option.values.map((v) => {
                const isSelected = selectedValues.includes(v.value);
                return (
                  <CommandItem
                    key={v.value}
                    value={v.label}
                    onSelect={() => {
                      const newValues = isSelected
                        ? selectedValues.filter((s) => s !== v.value)
                        : [...selectedValues, v.value];
                      onSelect(option.key, newValues);
                    }}
                  >
                    <div className={`mr-2 flex h-4 w-4 items-center justify-center rounded-sm border ${isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50"}`}>
                      {isSelected && <span className="text-xs">&#10003;</span>}
                    </div>
                    {v.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          {count > 0 && (
            <div className="border-t p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                onClick={() => onSelect(option.key, [])}
              >
                Clear all
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface ComparisonCondition {
  op: ComparisonOp;
  value: string;
}

type LogicMode = "and" | "or";

function parseConditions(encoded: string | undefined): ComparisonCondition[] {
  if (!encoded) return [];
  return encoded.split("|").map((part) => {
    const idx = part.indexOf(":");
    if (idx === -1) return { op: "eq" as ComparisonOp, value: part };
    return { op: part.slice(0, idx) as ComparisonOp, value: part.slice(idx + 1) };
  }).filter((c) => c.value !== "");
}

function encodeConditions(conditions: ComparisonCondition[]): string {
  return conditions.map((c) => `${c.op}:${c.value}`).join("|");
}

function formatConditionsLabel(conditions: ComparisonCondition[], logic: LogicMode): string {
  if (conditions.length === 0) return "";
  if (conditions.length === 1) return `${OP_LABELS[conditions[0].op]} ${conditions[0].value}`;
  const sep = logic === "and" ? " & " : " | ";
  return conditions.map((c) => `${OP_LABELS[c.op]} ${c.value}`).join(sep);
}

// Comparison filter popover with multiple conditions and AND/OR logic
function ComparisonPopover({
  label,
  icon: Icon,
  conditionsKey,
  logicKey,
  conditions: externalConditions,
  logic: externalLogic,
  onApply,
  onClear,
  step,
  placeholder,
  inline,
}: {
  label: string;
  icon: React.ElementType;
  conditionsKey: string;
  logicKey: string;
  conditions: ComparisonCondition[];
  logic: LogicMode;
  onApply: (conditionsKey: string, logicKey: string, conditions: ComparisonCondition[], logic: LogicMode) => void;
  onClear: (conditionsKey: string, logicKey: string) => void;
  step?: string;
  placeholder?: string;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const [localConditions, setLocalConditions] = useState<ComparisonCondition[]>([{ op: "eq", value: "" }]);
  const [localLogic, setLocalLogic] = useState<LogicMode>("and");
  const [prevExternal, setPrevExternal] = useState({ conditions: externalConditions, logic: externalLogic });

  if (externalConditions !== prevExternal.conditions || externalLogic !== prevExternal.logic) {
    setPrevExternal({ conditions: externalConditions, logic: externalLogic });
    if (externalConditions.length > 0) {
      setLocalConditions(externalConditions.map((c) => ({ ...c })));
      setLocalLogic(externalLogic);
    } else {
      setLocalConditions([{ op: "eq", value: "" }]);
      setLocalLogic("and");
    }
  }

  const isActive = externalConditions.length > 0;

  const updateCondition = (index: number, field: "op" | "value", val: string) => {
    setLocalConditions((prev) => {
      const next = [...prev];
      if (field === "op") next[index] = { ...next[index], op: val as ComparisonOp };
      else next[index] = { ...next[index], value: val };
      return next;
    });
  };

  const addCondition = () => {
    setLocalConditions((prev) => [...prev, { op: "eq", value: "" }]);
  };

  const removeCondition = (index: number) => {
    setLocalConditions((prev) => {
      if (prev.length <= 1) return [{ op: "eq", value: "" }];
      return prev.filter((_, i) => i !== index);
    });
  };

  const hasValidConditions = localConditions.some((c) => c.value !== "");

  const handleApply = () => {
    const valid = localConditions.filter((c) => c.value !== "");
    if (valid.length > 0) {
      onApply(conditionsKey, logicKey, valid, localLogic);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {inline ? (
          <button className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left">
            <span className="flex items-center gap-2">
              {isActive ? (
                <div className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-primary text-primary-foreground shrink-0">
                  <span className="text-[9px] font-bold">&#10003;</span>
                </div>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {label}
            </span>
            <span className="flex items-center gap-1.5">
              {isActive && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal max-w-32 truncate">
                  {formatConditionsLabel(externalConditions, externalLogic)}
                </Badge>
              )}
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </button>
        ) : (
          <Button variant="outline" size="default" className="gap-2">
            <Icon className="h-4 w-4" />
            {label}
            {isActive && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0 font-normal max-w-48 truncate">
                {formatConditionsLabel(externalConditions, externalLogic)}
              </Badge>
            )}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" side={inline && !isMobile ? "right" : "bottom"} className="w-80 max-w-[calc(100vw-2rem)] space-y-3" sideOffset={inline && !isMobile ? 2 : 8}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{label}</p>
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => {
                onClear(conditionsKey, logicKey);
                setLocalConditions([{ op: "eq", value: "" }]);
                setLocalLogic("and");
                setOpen(false);
              }}
            >
              Reset
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {localConditions.map((cond, i) => (
            <div key={i}>
              {/* AND/OR toggle between conditions */}
              {i > 0 && (
                <div className="flex justify-center my-1.5">
                  <div className="flex gap-0.5 p-0.5 rounded-md bg-muted text-[10px]">
                    <button
                      className={`px-2 py-0.5 rounded-sm transition-colors ${localLogic === "and" ? "bg-background shadow-sm font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setLocalLogic("and")}
                    >
                      AND
                    </button>
                    <button
                      className={`px-2 py-0.5 rounded-sm transition-colors ${localLogic === "or" ? "bg-background shadow-sm font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setLocalLogic("or")}
                    >
                      OR
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Select value={cond.op} onValueChange={(v) => updateCondition(i, "op", v)}>
                  <SelectTrigger className="w-20 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(OP_LABELS) as ComparisonOp[]).map((o) => (
                      <SelectItem key={o} value={o}>
                        <span className="font-mono mr-1">{OP_LABELS[o]}</span>
                        <span className="text-muted-foreground text-xs">{OP_DESCRIPTIONS[o]}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  step={step}
                  value={cond.value}
                  onChange={(e) => updateCondition(i, "value", e.target.value)}
                  placeholder={placeholder ?? "Value"}
                  className="h-8 text-xs flex-1"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleApply();
                  }}
                />
                {localConditions.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => removeCondition(i)}
                    aria-label="Remove filter condition"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs gap-1"
          onClick={addCondition}
        >
          <Plus className="h-3.5 w-3.5" />
          Add condition
        </Button>

        <Button
          size="sm"
          className="w-full text-xs"
          disabled={!hasValidConditions}
          onClick={handleApply}
        >
          Apply
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// Date filter popover with "before/after date" or "last X days" modes
function DateFilterPopover({
  label,
  minKey,
  maxKey,
  daysKey,
  filters,
  onApplyDate: onApply,
  onClear,
  inline,
}: {
  label: string;
  minKey: string;
  maxKey: string;
  daysKey: string;
  filters: MediaFilterValues;
  onApplyDate: (updates: Record<string, string>, clearKeys: string[]) => void;
  onClear: (keys: string[]) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<DateMode>(filters[daysKey] ? "days" : "date");
  const [localMin, setLocalMin] = useState(filters[minKey] ?? "");
  const [localMax, setLocalMax] = useState(filters[maxKey] ?? "");
  const [localDays, setLocalDays] = useState(filters[daysKey] ?? "");
  const [prevFilters, setPrevFilters] = useState(filters);

  if (filters !== prevFilters) {
    setPrevFilters(filters);
    if (filters[daysKey]) {
      setMode("days");
      setLocalDays(filters[daysKey]);
    } else {
      setMode("date");
      setLocalMin(filters[minKey] ?? "");
      setLocalMax(filters[maxKey] ?? "");
    }
  }

  const isActive = !!(filters[minKey] || filters[maxKey] || filters[daysKey]);

  const chipLabel = useMemo(() => {
    if (filters[daysKey]) return `Last ${filters[daysKey]} days`;
    const min = filters[minKey];
    const max = filters[maxKey];
    if (min && max) return `${min} \u2013 ${max}`;
    if (min) return `After ${min}`;
    if (max) return `Before ${max}`;
    return "";
  }, [filters, minKey, maxKey, daysKey]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {inline ? (
          <button className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left">
            <span className="flex items-center gap-2">
              {isActive ? (
                <div className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-primary text-primary-foreground shrink-0">
                  <span className="text-[9px] font-bold">&#10003;</span>
                </div>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {label}
            </span>
            <span className="flex items-center gap-1.5">
              {isActive && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal max-w-32 truncate">
                  {chipLabel}
                </Badge>
              )}
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </button>
        ) : (
          <Button variant="outline" size="default" className="gap-2">
            <Calendar className="h-4 w-4" />
            {label}
            {isActive && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0 font-normal">
                {chipLabel}
              </Badge>
            )}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" side={inline && !isMobile ? "right" : "bottom"} className="w-80 max-w-[calc(100vw-2rem)] space-y-3" sideOffset={inline && !isMobile ? 2 : 8}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{label}</p>
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => {
                onClear([minKey, maxKey, daysKey]);
                setLocalMin("");
                setLocalMax("");
                setLocalDays("");
                setOpen(false);
              }}
            >
              Reset
            </Button>
          )}
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 p-0.5 rounded-md bg-muted">
          <button
            className={`flex-1 text-xs py-1.5 rounded-sm transition-colors ${mode === "date" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("date")}
          >
            Date Range
          </button>
          <button
            className={`flex-1 text-xs py-1.5 rounded-sm transition-colors ${mode === "days" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("days")}
          >
            Last X Days
          </button>
        </div>

        {mode === "date" ? (
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground">After</label>
              <Input
                type="date"
                value={localMin}
                onChange={(e) => setLocalMin(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Before</label>
              <Input
                type="date"
                value={localMax}
                onChange={(e) => setLocalMax(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <Button
              size="sm"
              className="w-full text-xs"
              disabled={!localMin && !localMax}
              onClick={() => {
                const updates: Record<string, string> = {};
                if (localMin) updates[minKey] = localMin;
                if (localMax) updates[maxKey] = localMax;
                onApply(updates, [daysKey]);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground">Show items from the last</label>
              <div className="flex items-center gap-2 mt-1">
                <Input
                  type="number"
                  min={1}
                  value={localDays}
                  onChange={(e) => setLocalDays(e.target.value)}
                  placeholder="30"
                  className="h-8 text-xs w-24"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && localDays) {
                      onApply({ [daysKey]: localDays }, [minKey, maxKey]);
                      setOpen(false);
                    }
                  }}
                />
                <span className="text-xs text-muted-foreground">days</span>
              </div>
            </div>
            <Button
              size="sm"
              className="w-full text-xs"
              disabled={!localDays}
              onClick={() => {
                if (localDays) {
                  onApply({ [daysKey]: localDays }, [minKey, maxKey]);
                  setOpen(false);
                }
              }}
            >
              Apply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Inline slider popover for use inside the Filters popover
function InlineSliderPopover({
  label,
  range,
  onRangeChange,
  onApply,
  onReset,
  min,
  max,
  step,
  formatValue,
  unit,
}: {
  label: string;
  range: [number, number] | null;
  onRangeChange: (range: [number, number]) => void;
  onApply: (range: [number, number]) => void;
  onReset: () => void;
  min: number;
  max: number;
  step: number;
  formatValue: (v: number) => string;
  unit: string;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const isActive = range !== null;
  const effectiveMax = Math.max(max, min + step);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left">
          <span className="flex items-center gap-2">
            {isActive ? (
              <div className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-primary text-primary-foreground shrink-0">
                <span className="text-[9px] font-bold">&#10003;</span>
              </div>
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            {label}
          </span>
          <span className="flex items-center gap-1.5">
            {isActive && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal max-w-32 truncate">
                {formatValue(range[0])} &ndash; {formatValue(range[1])} {unit}
              </Badge>
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side={isMobile ? "bottom" : "right"} align="start" className="w-72 max-w-[calc(100vw-2rem)] space-y-4" sideOffset={isMobile ? 8 : 2}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{label} ({unit})</p>
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
            >
              Reset
            </Button>
          )}
        </div>
        <Slider
          min={min}
          max={effectiveMax}
          step={step}
          value={range ?? [min, effectiveMax]}
          onValueChange={(v) => onRangeChange([v[0], v[1]])}
          onValueCommit={(v) => {
            onApply([v[0], v[1]]);
          }}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{formatValue(range?.[0] ?? min)} {unit}</span>
          <span>{formatValue(range?.[1] ?? effectiveMax)} {unit}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MediaFilters({ onFilterChange, externalFilters, mediaType, prefix }: MediaFiltersProps) {
  const [filters, setFilters] = useState<MediaFilterValues>({});
  const [searchInput, setSearchInput] = useState("");
  const [distinctData, setDistinctData] = useState<DistinctData>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterSearch, setFilterSearch] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const toggleCategory = useCallback((name: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const filterSearchLower = filterSearch.toLowerCase();
  const isSearching = filterSearchLower.length > 0;

  // Check if a label matches the current filter search
  const matchesFilterSearch = useCallback(
    (label: string) => !isSearching || label.toLowerCase().includes(filterSearchLower),
    [isSearching, filterSearchLower],
  );

  // Reset filter search when popover closes
  useEffect(() => {
    if (!filtersOpen) setFilterSearch("");
  }, [filtersOpen]);

  // Range slider states (file size, duration)
  const [fileSizeRange, setFileSizeRange] = useState<[number, number] | null>(null);
  const [durationRange, setDurationRange] = useState<[number, number] | null>(null);

  // Sync external filter changes (e.g. from quality chart click, restored filters)
  const isExternalUpdate = useRef(false);
  const searchMounted = useRef(false);
  useEffect(() => {
    if (externalFilters) {
      isExternalUpdate.current = true;
      setFilters((prev) => ({ ...prev, ...externalFilters }));
      if (externalFilters.search) {
        setSearchInput(externalFilters.search);
      }
    }
  }, [externalFilters]);

  useEffect(() => {
    if (isExternalUpdate.current) {
      isExternalUpdate.current = false;
      onFilterChange(filters);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    fetch("/api/media/distinct-values")
      .then((r) => r.json())
      .then((data: DistinctData) => {
        setDistinctData(data);
      })
      .catch((e) => console.error("Failed to fetch distinct values", e));
  }, []);

  const updateFilter = useCallback(
    (key: string, value: string | undefined) => {
      const newFilters = { ...filters };
      if (value && value !== "all") {
        newFilters[key] = value;
      } else {
        delete newFilters[key];
      }
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  // Multi-select: set pipe-separated values or clear
  const updateMultiFilter = useCallback(
    (key: string, values: string[]) => {
      const newFilters = { ...filters };
      if (values.length > 0) {
        newFilters[key] = values.join("|");
      } else {
        delete newFilters[key];
      }
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  const handleSearch = useCallback(() => {
    updateFilter("search", searchInput || undefined);
  }, [searchInput, updateFilter]);

  // Auto-search with debounce as user types (skip mount to avoid triggering a
  // redundant re-fetch — searchInput starts empty so there's nothing to apply)
  useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return;
    }
    const timeout = setTimeout(() => {
      updateFilter("search", searchInput || undefined);
    }, 300);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Computed slider bounds
  const fileSizeMinMB = distinctData.fileSizeMin ? Number(distinctData.fileSizeMin) / MB : 0;
  const fileSizeMaxMB = distinctData.fileSizeMax ? Math.ceil(Number(distinctData.fileSizeMax) / MB) : 100000;
  const durationMinMin = distinctData.durationMin ? Math.floor(distinctData.durationMin / 60000) : 0;
  const durationMaxMin = distinctData.durationMax ? Math.ceil(distinctData.durationMax / 60000) : 300;

  // Apply range filter helpers (for sliders: file size, duration)
  const applyRangeFilter = useCallback(
    (minKey: string, maxKey: string, range: [number, number], minBound: number, maxBound: number, transform?: (v: number) => string) => {
      const newFilters = { ...filters };
      const toStr = transform ?? ((v: number) => v.toString());
      if (range[0] > minBound) {
        newFilters[minKey] = toStr(range[0]);
      } else {
        delete newFilters[minKey];
      }
      if (range[1] < maxBound) {
        newFilters[maxKey] = toStr(range[1]);
      } else {
        delete newFilters[maxKey];
      }
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  const applyFileSizeFilter = useCallback(
    (range: [number, number]) => {
      applyRangeFilter("fileSizeMin", "fileSizeMax", range, fileSizeMinMB, fileSizeMaxMB, (v) => Math.round(v * MB).toString());
    },
    [applyRangeFilter, fileSizeMinMB, fileSizeMaxMB]
  );

  const applyDurationFilter = useCallback(
    (range: [number, number]) => {
      applyRangeFilter("durationMin", "durationMax", range, durationMinMin, durationMaxMin, (v) => Math.round(v * 60000).toString());
    },
    [applyRangeFilter, durationMinMin, durationMaxMin]
  );

  // Comparison filter apply/clear (multi-condition)
  const applyConditions = useCallback(
    (conditionsKey: string, logicKey: string, conditions: ComparisonCondition[], logic: LogicMode) => {
      const newFilters = { ...filters };
      if (conditions.length > 0) {
        newFilters[conditionsKey] = encodeConditions(conditions);
        newFilters[logicKey] = logic;
      } else {
        delete newFilters[conditionsKey];
        delete newFilters[logicKey];
      }
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  const clearConditions = useCallback(
    (conditionsKey: string, logicKey: string) => {
      const newFilters = { ...filters };
      delete newFilters[conditionsKey];
      delete newFilters[logicKey];
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  // Date filter apply/clear
  const applyDateUpdates = useCallback(
    (updates: Record<string, string>, clearKeys: string[]) => {
      const newFilters = { ...filters };
      for (const key of clearKeys) delete newFilters[key];
      for (const [k, v] of Object.entries(updates)) newFilters[k] = v;
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  const clearDateKeys = useCallback(
    (keys: string[]) => {
      const newFilters = { ...filters };
      for (const k of keys) delete newFilters[k];
      setFilters(newFilters);
      onFilterChange(newFilters);
    },
    [filters, onFilterChange]
  );

  const clearFilters = () => {
    setFilters({});
    setSearchInput("");
    setFileSizeRange(null);
    setDurationRange(null);
    onFilterChange({});
  };

  // Keys that are handled by popovers (not chip dropdowns)
  const RANGE_KEYS = new Set([
    "search", "fileSizeMin", "fileSizeMax", "durationMin", "durationMax",
    "yearConditions", "yearLogic",
    "playCountConditions", "playCountLogic",
    "ratingConditions", "ratingLogic",
    "audienceRatingConditions", "audienceRatingLogic",
    "videoBitrateConditions", "videoBitrateLogic",
    "audioBitrateConditions", "audioBitrateLogic",
    "lastPlayedAtMin", "lastPlayedAtMax", "lastPlayedAtDays",
    "addedAtMin", "addedAtMax", "addedAtDays",
    "originallyAvailableAtMin", "originallyAvailableAtMax", "originallyAvailableAtDays",
    "audioStreamCountConditions", "audioStreamCountLogic",
    "subtitleStreamCountConditions", "subtitleStreamCountLogic",
    "isWatchlisted",
    "episodeCountConditions", "episodeCountLogic",
    "watchedEpisodeCountConditions", "watchedEpisodeCountLogic",
    "watchedEpisodePercentageConditions", "watchedEpisodePercentageLogic",
    "lastEpisodeAiredAtMin", "lastEpisodeAiredAtMax", "lastEpisodeAiredAtDays",
  ]);

  // Build categorized filter options from distinct data
  const categories = useMemo<FilterCategory[]>(() => {
    const cats: FilterCategory[] = [];

    // Video category (hidden for music)
    if (mediaType !== "MUSIC") {
      const videoOptions: FilterOption[] = [];
      if (distinctData.resolution?.length) {
        videoOptions.push({
          key: "resolution",
          label: "Resolution",
          values: distinctData.resolution.map((r) => ({ value: r, label: r })),
        });
      }
      if (distinctData.videoCodec?.length) {
        videoOptions.push({
          key: "videoCodec",
          label: "Video Codec",
          values: distinctData.videoCodec.map((c) => ({ value: c, label: c })),
        });
      }
      if (distinctData.dynamicRange?.length) {
        videoOptions.push({
          key: "dynamicRange",
          label: "Dynamic Range",
          values: distinctData.dynamicRange.map((r) => ({ value: r, label: r })),
        });
      }
      if (distinctData.videoBitDepth?.length) {
        videoOptions.push({
          key: "videoBitDepth",
          label: "Video Bit Depth",
          values: distinctData.videoBitDepth.map((d) => ({
            value: d.toString(),
            label: `${d}-bit`,
          })),
        });
      }
      if (distinctData.videoProfile?.length) {
        videoOptions.push({
          key: "videoProfile",
          label: "Video Profile",
          values: distinctData.videoProfile.map((p) => ({ value: p, label: p })),
        });
      }
      if (distinctData.videoFrameRate?.length) {
        videoOptions.push({
          key: "videoFrameRate",
          label: "Frame Rate",
          values: distinctData.videoFrameRate.map((f) => ({ value: f, label: f })),
        });
      }
      if (distinctData.aspectRatio?.length) {
        videoOptions.push({
          key: "aspectRatio",
          label: "Aspect Ratio",
          values: distinctData.aspectRatio.map((a) => ({ value: a, label: a })),
        });
      }
      if (distinctData.scanType?.length) {
        videoOptions.push({
          key: "scanType",
          label: "Scan Type",
          values: distinctData.scanType.map((s) => ({ value: s, label: s })),
        });
      }
      if (videoOptions.length > 0) {
        cats.push({ name: "Video", options: videoOptions });
      }
    }

    // Audio category
    const audioOptions: FilterOption[] = [];
    if (distinctData.audioCodec?.length) {
      audioOptions.push({
        key: "audioCodec",
        label: "Audio Codec",
        values: distinctData.audioCodec.map((c) => ({ value: c, label: c })),
      });
    }
    if (distinctData.audioProfile?.length) {
      audioOptions.push({
        key: "audioProfile",
        label: "Audio Profile",
        values: distinctData.audioProfile.map((p) => ({ value: p, label: p })),
      });
    }
    if (distinctData.audioChannels?.length) {
      audioOptions.push({
        key: "audioChannels",
        label: "Audio Channels",
        values: distinctData.audioChannels.map((ch) => ({
          value: ch.toString(),
          label: formatChannels(ch),
        })),
      });
    }
    if (distinctData.audioSamplingRate?.length) {
      audioOptions.push({
        key: "audioSamplingRate",
        label: "Sample Rate",
        values: distinctData.audioSamplingRate.map((r) => ({
          value: r.toString(),
          label: `${(r / 1000).toFixed(r % 1000 === 0 ? 0 : 1)} kHz`,
        })),
      });
    }
    if (audioOptions.length > 0) {
      cats.push({ name: "Audio", options: audioOptions });
    }

    // Streams category (language, codec from MediaStream)
    const streamOptions: FilterOption[] = [];
    if (distinctData.audioLanguage?.length) {
      streamOptions.push({
        key: "audioLanguage",
        label: "Audio Language",
        values: distinctData.audioLanguage.map((l) => ({ value: l, label: l })),
      });
    }
    if (distinctData.subtitleLanguage?.length) {
      streamOptions.push({
        key: "subtitleLanguage",
        label: "Subtitle Language",
        values: distinctData.subtitleLanguage.map((l) => ({ value: l, label: l })),
      });
    }
    if (distinctData.streamAudioCodec?.length) {
      streamOptions.push({
        key: "streamAudioCodec",
        label: "Stream Audio Codec",
        values: distinctData.streamAudioCodec.map((c) => ({ value: c, label: c.toUpperCase() })),
      });
    }
    if (streamOptions.length > 0) {
      cats.push({ name: "Streams", options: streamOptions });
    }

    return cats;
  }, [distinctData, mediaType]);

  // Compute active filter chips (exclude range/date/search keys)
  const chipFilterKeys = useMemo(() => {
    return Object.keys(filters).filter((k) => !RANGE_KEYS.has(k));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Find a display label for a filter value (supports multi-select pipe-separated values)
  const getChipLabel = useCallback(
    (key: string, value: string) => {
      const values = value.split("|");
      const labels: string[] = [];
      for (const cat of categories) {
        for (const opt of cat.options) {
          if (opt.key === key) {
            for (const v of values) {
              const found = opt.values.find((ov) => ov.value === v);
              labels.push(found?.label ?? v);
            }
            break;
          }
        }
      }
      if (labels.length === 0) return value;
      if (labels.length <= 2) return labels.join(", ");
      return `${labels.length} selected`;
    },
    [categories]
  );

  // Get selected values array for a multi-select filter
  const getSelectedValues = useCallback(
    (key: string): string[] => {
      const val = filters[key];
      if (!val) return [];
      return val.split("|").filter(Boolean);
    },
    [filters]
  );

  const hasFilters =
    Object.keys(filters).length > 0 || searchInput.length > 0;

  // Parse comparison conditions from filter state
  const yearConditions = parseConditions(filters.yearConditions);
  const yearLogic = (filters.yearLogic as LogicMode) ?? "and";
  const playCountConditions = parseConditions(filters.playCountConditions);
  const playCountLogic = (filters.playCountLogic as LogicMode) ?? "and";
  const ratingConditions = parseConditions(filters.ratingConditions);
  const ratingLogic = (filters.ratingLogic as LogicMode) ?? "and";
  const audienceRatingConditions = parseConditions(filters.audienceRatingConditions);
  const audienceRatingLogic = (filters.audienceRatingLogic as LogicMode) ?? "and";
  const videoBitrateConditions = parseConditions(filters.videoBitrateConditions);
  const videoBitrateLogic = (filters.videoBitrateLogic as LogicMode) ?? "and";
  const audioBitrateConditions = parseConditions(filters.audioBitrateConditions);
  const audioBitrateLogic = (filters.audioBitrateLogic as LogicMode) ?? "and";
  const audioStreamCountConditions = parseConditions(filters.audioStreamCountConditions);
  const audioStreamCountLogic = (filters.audioStreamCountLogic as LogicMode) ?? "and";
  const subtitleStreamCountConditions = parseConditions(filters.subtitleStreamCountConditions);
  const subtitleStreamCountLogic = (filters.subtitleStreamCountLogic as LogicMode) ?? "and";
  // Series aggregate conditions
  const episodeCountConditions = parseConditions(filters.episodeCountConditions);
  const episodeCountLogic = (filters.episodeCountLogic as LogicMode) ?? "and";
  const watchedEpisodeCountConditions = parseConditions(filters.watchedEpisodeCountConditions);
  const watchedEpisodeCountLogic = (filters.watchedEpisodeCountLogic as LogicMode) ?? "and";
  const watchedEpisodePercentageConditions = parseConditions(filters.watchedEpisodePercentageConditions);
  const watchedEpisodePercentageLogic = (filters.watchedEpisodePercentageLogic as LogicMode) ?? "and";

  // Check if comparison/date filters are active
  const hasYear = yearConditions.length > 0;
  const hasPlayCount = playCountConditions.length > 0;
  const hasRating = ratingConditions.length > 0;
  const hasAudienceRating = audienceRatingConditions.length > 0;
  const hasVideoBitrate = videoBitrateConditions.length > 0;
  const hasAudioBitrate = audioBitrateConditions.length > 0;
  const hasAudioStreamCount = audioStreamCountConditions.length > 0;
  const hasSubtitleStreamCount = subtitleStreamCountConditions.length > 0;
  const hasLastPlayed = !!(filters.lastPlayedAtMin || filters.lastPlayedAtMax || filters.lastPlayedAtDays);
  const hasAddedAt = !!(filters.addedAtMin || filters.addedAtMax || filters.addedAtDays);
  const hasReleaseDate = !!(filters.originallyAvailableAtMin || filters.originallyAvailableAtMax || filters.originallyAvailableAtDays);
  const hasEpisodeCount = episodeCountConditions.length > 0;
  const hasWatchedEpisodeCount = watchedEpisodeCountConditions.length > 0;
  const hasWatchedEpisodePercentage = watchedEpisodePercentageConditions.length > 0;
  const hasLastEpisodeAiredAt = !!(filters.lastEpisodeAiredAtMin || filters.lastEpisodeAiredAtMax || filters.lastEpisodeAiredAtDays);
  const hasIsWatchlisted = !!filters.isWatchlisted;

  // Count all active filters inside the Filters popover
  const activeFilterCount = chipFilterKeys.length
    + (fileSizeRange ? 1 : 0)
    + (durationRange ? 1 : 0)
    + (hasYear ? 1 : 0)
    + (hasPlayCount ? 1 : 0)
    + (hasRating ? 1 : 0)
    + (hasAudienceRating ? 1 : 0)
    + (hasVideoBitrate ? 1 : 0)
    + (hasAudioBitrate ? 1 : 0)
    + (hasAudioStreamCount ? 1 : 0)
    + (hasSubtitleStreamCount ? 1 : 0)
    + (hasLastPlayed ? 1 : 0)
    + (hasAddedAt ? 1 : 0)
    + (hasReleaseDate ? 1 : 0)
    + (hasEpisodeCount ? 1 : 0)
    + (hasWatchedEpisodeCount ? 1 : 0)
    + (hasWatchedEpisodePercentage ? 1 : 0)
    + (hasLastEpisodeAiredAt ? 1 : 0)
    + (hasIsWatchlisted ? 1 : 0);

  return (
    <div className="mb-6">
      {/* Search + Filters + Comparison Popovers + Chips */}
      <div className="flex flex-wrap items-center gap-2">
        {prefix}
        <div className="w-full sm:w-auto">
          <Input
            placeholder="Search titles..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="w-full sm:w-64"
          />
        </div>

        {/* Filters dropdown button */}
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="default" className="gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {activeFilterCount > 0 && (
                <Badge variant="default" className="ml-1 h-5 w-5 rounded-full p-0 text-[10px] flex items-center justify-center">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)] p-0" sideOffset={8}>
            <div className="p-3 pb-2 space-y-2.5">
              <div>
                <p className="text-[13px] font-semibold tracking-tight">Filters</p>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                  Narrow down your library
                </p>
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search filters..."
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </div>
            <Separator />
            <div className="py-1 max-h-[70vh] overflow-y-auto">
              {categories.map((cat, catIdx) => {
                const catItems = cat.options.filter((opt) => matchesFilterSearch(opt.label));
                // Extra inline items for this category
                const hasVideoBitrate = cat.name === "Video" && matchesFilterSearch("Video Bitrate");
                const hasAudioBitrate = cat.name === "Audio" && matchesFilterSearch("Audio Bitrate");
                const visibleCount = catItems.length + (hasVideoBitrate ? 1 : 0) + (hasAudioBitrate ? 1 : 0);
                if (visibleCount === 0 && isSearching) return null;
                const isOpen = isSearching || expandedCategories.has(cat.name);
                return (
                  <div key={cat.name}>
                    {catIdx > 0 && <Separator className="my-1" />}
                    <Collapsible open={isOpen} onOpenChange={() => toggleCategory(cat.name)}>
                      <CategoryTrigger name={cat.name} isOpen={isOpen} />
                      <CollapsibleContent>
                        {catItems.map((opt) => (
                          <FilterCombobox
                            key={opt.key}
                            option={opt}
                            selectedValues={getSelectedValues(opt.key)}
                            onSelect={updateMultiFilter}
                          />
                        ))}
                        {cat.name === "Video" && hasVideoBitrate && (
                          <ComparisonPopover
                            label="Video Bitrate (kbps)"
                            icon={Hash}
                            conditionsKey="videoBitrateConditions"
                            logicKey="videoBitrateLogic"
                            conditions={videoBitrateConditions}
                            logic={videoBitrateLogic}
                            onApply={applyConditions}
                            onClear={clearConditions}
                            step="1"
                            placeholder="5000"
                            inline
                          />
                        )}
                        {cat.name === "Audio" && hasAudioBitrate && (
                          <ComparisonPopover
                            label="Audio Bitrate (kbps)"
                            icon={AudioLines}
                            conditionsKey="audioBitrateConditions"
                            logicKey="audioBitrateLogic"
                            conditions={audioBitrateConditions}
                            logic={audioBitrateLogic}
                            onApply={applyConditions}
                            onClear={clearConditions}
                            step="1"
                            placeholder="320"
                            inline
                          />
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                );
              })}

              {/* Stream count filters */}
              {(distinctData.audioStreamCountMax != null || distinctData.subtitleStreamCountMax != null) && (() => {
                const hasAudioTracks = distinctData.audioStreamCountMax != null && matchesFilterSearch("Audio Tracks");
                const hasSubTracks = distinctData.subtitleStreamCountMax != null && matchesFilterSearch("Subtitle Tracks");
                if (!hasAudioTracks && !hasSubTracks && isSearching) return null;
                const isOpen = isSearching || expandedCategories.has("Stream Counts");
                return (
                  <>
                    <Separator className="my-1" />
                    <Collapsible open={isOpen} onOpenChange={() => toggleCategory("Stream Counts")}>
                      <CategoryTrigger name="Stream Counts" isOpen={isOpen} />
                      <CollapsibleContent>
                        {hasAudioTracks && (
                          <ComparisonPopover
                            label="Audio Tracks"
                            icon={AudioLines}
                            conditionsKey="audioStreamCountConditions"
                            logicKey="audioStreamCountLogic"
                            conditions={audioStreamCountConditions}
                            logic={audioStreamCountLogic}
                            onApply={applyConditions}
                            onClear={clearConditions}
                            step="1"
                            placeholder="1"
                            inline
                          />
                        )}
                        {hasSubTracks && (
                          <ComparisonPopover
                            label="Subtitle Tracks"
                            icon={AudioLines}
                            conditionsKey="subtitleStreamCountConditions"
                            logicKey="subtitleStreamCountLogic"
                            conditions={subtitleStreamCountConditions}
                            logic={subtitleStreamCountLogic}
                            onApply={applyConditions}
                            onClear={clearConditions}
                            step="1"
                            placeholder="1"
                            inline
                          />
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  </>
                );
              })()}

              {/* Content filters */}
              {(() => {
                const contentItems: React.ReactNode[] = [];
                if (distinctData.contentRating?.length && matchesFilterSearch("Content Rating")) {
                  contentItems.push(
                    <FilterCombobox key="contentRating" option={{ key: "contentRating", label: "Content Rating", values: sortContentRatings(distinctData.contentRating).map((r) => ({ value: r, label: r })) }} selectedValues={getSelectedValues("contentRating")} onSelect={updateMultiFilter} />
                  );
                }
                if (distinctData.studio?.length && matchesFilterSearch("Studio")) {
                  contentItems.push(
                    <FilterCombobox key="studio" option={{ key: "studio", label: "Studio", values: distinctData.studio.map((s) => ({ value: s, label: s })) }} selectedValues={getSelectedValues("studio")} onSelect={updateMultiFilter} />
                  );
                }
                if (distinctData.genre?.length && matchesFilterSearch("Genre")) {
                  contentItems.push(
                    <FilterCombobox key="genre" option={{ key: "genre", label: "Genre", values: distinctData.genre.map((g) => ({ value: g, label: g.charAt(0).toUpperCase() + g.slice(1).toLowerCase() })) }} selectedValues={getSelectedValues("genre")} onSelect={updateMultiFilter} />
                  );
                }
                if (matchesFilterSearch("Duration")) {
                  contentItems.push(
                    <InlineSliderPopover key="duration" label="Duration" range={durationRange} onRangeChange={setDurationRange} onApply={applyDurationFilter} onReset={() => { setDurationRange(null); const nf = { ...filters }; delete nf.durationMin; delete nf.durationMax; setFilters(nf); onFilterChange(nf); }} min={durationMinMin} max={durationMaxMin} step={1} formatValue={(v) => v.toString()} unit="min" />
                  );
                }
                if (matchesFilterSearch("Play Count")) {
                  contentItems.push(<ComparisonPopover key="playCount" label="Play Count" icon={Play} conditionsKey="playCountConditions" logicKey="playCountLogic" conditions={playCountConditions} logic={playCountLogic} onApply={applyConditions} onClear={clearConditions} step="1" placeholder="0" inline />);
                }
                if (matchesFilterSearch("Rating")) {
                  contentItems.push(<ComparisonPopover key="rating" label="Rating" icon={Star} conditionsKey="ratingConditions" logicKey="ratingLogic" conditions={ratingConditions} logic={ratingLogic} onApply={applyConditions} onClear={clearConditions} step="0.1" placeholder="7.0" inline />);
                }
                if (matchesFilterSearch("Audience Rating")) {
                  contentItems.push(<ComparisonPopover key="audienceRating" label="Audience Rating" icon={Star} conditionsKey="audienceRatingConditions" logicKey="audienceRatingLogic" conditions={audienceRatingConditions} logic={audienceRatingLogic} onApply={applyConditions} onClear={clearConditions} step="0.1" placeholder="7.0" inline />);
                }
                if (matchesFilterSearch("Watchlisted")) {
                  contentItems.push(
                    <FilterCombobox key="isWatchlisted" option={{ key: "isWatchlisted", label: "Watchlisted", values: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] }} selectedValues={filters.isWatchlisted ? [filters.isWatchlisted] : []} onSelect={(key, values) => updateFilter(key, values.length > 0 ? values[values.length - 1] : undefined)} />
                  );
                }
                if (contentItems.length === 0 && isSearching) return null;
                const isOpen = isSearching || expandedCategories.has("Content");
                return (
                  <>
                    <Separator className="my-1" />
                    <Collapsible open={isOpen} onOpenChange={() => toggleCategory("Content")}>
                      <CategoryTrigger name="Content" isOpen={isOpen} />
                      <CollapsibleContent>{contentItems}</CollapsibleContent>
                    </Collapsible>
                  </>
                );
              })()}

              {/* Series aggregate filters */}
              {mediaType === "SERIES" && (() => {
                const seriesItems: React.ReactNode[] = [];
                if (matchesFilterSearch("Episode Count")) seriesItems.push(<ComparisonPopover key="episodeCount" label="Episode Count" icon={Hash} conditionsKey="episodeCountConditions" logicKey="episodeCountLogic" conditions={episodeCountConditions} logic={episodeCountLogic} onApply={applyConditions} onClear={clearConditions} step="1" placeholder="10" inline />);
                if (matchesFilterSearch("Watched Episodes")) seriesItems.push(<ComparisonPopover key="watchedEpisodes" label="Watched Episodes" icon={Play} conditionsKey="watchedEpisodeCountConditions" logicKey="watchedEpisodeCountLogic" conditions={watchedEpisodeCountConditions} logic={watchedEpisodeCountLogic} onApply={applyConditions} onClear={clearConditions} step="1" placeholder="5" inline />);
                if (matchesFilterSearch("Watched %")) seriesItems.push(<ComparisonPopover key="watchedPct" label="Watched %" icon={Hash} conditionsKey="watchedEpisodePercentageConditions" logicKey="watchedEpisodePercentageLogic" conditions={watchedEpisodePercentageConditions} logic={watchedEpisodePercentageLogic} onApply={applyConditions} onClear={clearConditions} step="1" placeholder="50" inline />);
                if (matchesFilterSearch("Last Episode Aired")) seriesItems.push(<DateFilterPopover key="lastEpisodeAired" label="Last Episode Aired" minKey="lastEpisodeAiredAtMin" maxKey="lastEpisodeAiredAtMax" daysKey="lastEpisodeAiredAtDays" filters={filters} onApplyDate={applyDateUpdates} onClear={clearDateKeys} inline />);
                if (seriesItems.length === 0 && isSearching) return null;
                const isOpen = isSearching || expandedCategories.has("Series");
                return (
                  <>
                    <Separator className="my-1" />
                    <Collapsible open={isOpen} onOpenChange={() => toggleCategory("Series")}>
                      <CategoryTrigger name="Series" isOpen={isOpen} />
                      <CollapsibleContent>{seriesItems}</CollapsibleContent>
                    </Collapsible>
                  </>
                );
              })()}

              {/* File filters */}
              {(() => {
                const fileItems: React.ReactNode[] = [];
                if (distinctData.container?.length && matchesFilterSearch("Container")) {
                  fileItems.push(
                    <FilterCombobox key="container" option={{ key: "container", label: "Container", values: distinctData.container.map((c) => ({ value: c, label: c.toUpperCase() })) }} selectedValues={getSelectedValues("container")} onSelect={updateMultiFilter} />
                  );
                }
                if (matchesFilterSearch("File Size")) {
                  fileItems.push(
                    <InlineSliderPopover key="fileSize" label="File Size" range={fileSizeRange} onRangeChange={setFileSizeRange} onApply={applyFileSizeFilter} onReset={() => { setFileSizeRange(null); const nf = { ...filters }; delete nf.fileSizeMin; delete nf.fileSizeMax; setFilters(nf); onFilterChange(nf); }} min={Math.floor(fileSizeMinMB)} max={Math.ceil(fileSizeMaxMB)} step={1} formatValue={(v) => Math.round(v).toString()} unit="MB" />
                  );
                }
                if (fileItems.length === 0 && isSearching) return null;
                const isOpen = isSearching || expandedCategories.has("File");
                return (
                  <>
                    <Separator className="my-1" />
                    <Collapsible open={isOpen} onOpenChange={() => toggleCategory("File")}>
                      <CategoryTrigger name="File" isOpen={isOpen} />
                      <CollapsibleContent>{fileItems}</CollapsibleContent>
                    </Collapsible>
                  </>
                );
              })()}

              {/* Date filters */}
              {(() => {
                const dateItems: React.ReactNode[] = [];
                if (distinctData.year && distinctData.year.length > 0 && matchesFilterSearch("Year")) {
                  dateItems.push(<ComparisonPopover key="year" label="Year" icon={Hash} conditionsKey="yearConditions" logicKey="yearLogic" conditions={yearConditions} logic={yearLogic} onApply={applyConditions} onClear={clearConditions} step="1" placeholder="2024" inline />);
                }
                if (matchesFilterSearch("Last Played")) dateItems.push(<DateFilterPopover key="lastPlayed" label="Last Played" minKey="lastPlayedAtMin" maxKey="lastPlayedAtMax" daysKey="lastPlayedAtDays" filters={filters} onApplyDate={applyDateUpdates} onClear={clearDateKeys} inline />);
                if (matchesFilterSearch("Date Added")) dateItems.push(<DateFilterPopover key="dateAdded" label="Date Added" minKey="addedAtMin" maxKey="addedAtMax" daysKey="addedAtDays" filters={filters} onApplyDate={applyDateUpdates} onClear={clearDateKeys} inline />);
                if (matchesFilterSearch("Release Date")) dateItems.push(<DateFilterPopover key="releaseDate" label="Release Date" minKey="originallyAvailableAtMin" maxKey="originallyAvailableAtMax" daysKey="originallyAvailableAtDays" filters={filters} onApplyDate={applyDateUpdates} onClear={clearDateKeys} inline />);
                if (dateItems.length === 0 && isSearching) return null;
                const isOpen = isSearching || expandedCategories.has("Dates");
                return (
                  <>
                    <Separator className="my-1" />
                    <Collapsible open={isOpen} onOpenChange={() => toggleCategory("Dates")}>
                      <CategoryTrigger name="Dates" isOpen={isOpen} />
                      <CollapsibleContent>{dateItems}</CollapsibleContent>
                    </Collapsible>
                  </>
                );
              })()}

              {/* No results message */}
              {isSearching && (() => {
                const dynamicCats = categories.some((cat) => cat.options.some((opt) => matchesFilterSearch(opt.label)));
                if (dynamicCats) return null;
                return (
                  <div className="px-3 py-6 text-center">
                    <Search className="mx-auto h-5 w-5 text-muted-foreground/30 mb-2" />
                    <p className="text-[11px] text-muted-foreground/70">
                      No filters matching &ldquo;{filterSearch}&rdquo;
                    </p>
                  </div>
                );
              })()}
            </div>
            {activeFilterCount > 0 && (
              <>
                <Separator />
                <div className="p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => {
                      clearFilters();
                      setFiltersOpen(false);
                    }}
                  >
                    Clear all filters
                  </Button>
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>

        {/* Active filter chips */}
        {chipFilterKeys.map((key) => (
          <Badge
            key={key}
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => updateFilter(key, undefined)}
          >
            <span className="text-muted-foreground">{FILTER_LABELS[key] ?? key}:</span>
            {getChipLabel(key, filters[key])}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        ))}

        {/* Comparison chips */}
        {hasYear && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("yearConditions", "yearLogic")}
          >
            <span className="text-muted-foreground">Year:</span>
            {formatConditionsLabel(yearConditions, yearLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasPlayCount && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("playCountConditions", "playCountLogic")}
          >
            <span className="text-muted-foreground">Plays:</span>
            {formatConditionsLabel(playCountConditions, playCountLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasRating && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("ratingConditions", "ratingLogic")}
          >
            <span className="text-muted-foreground">Rating:</span>
            {formatConditionsLabel(ratingConditions, ratingLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasAudienceRating && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("audienceRatingConditions", "audienceRatingLogic")}
          >
            <span className="text-muted-foreground">Audience Rating:</span>
            {formatConditionsLabel(audienceRatingConditions, audienceRatingLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasVideoBitrate && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("videoBitrateConditions", "videoBitrateLogic")}
          >
            <span className="text-muted-foreground">Video Bitrate:</span>
            {formatConditionsLabel(videoBitrateConditions, videoBitrateLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasAudioBitrate && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("audioBitrateConditions", "audioBitrateLogic")}
          >
            <span className="text-muted-foreground">Audio Bitrate:</span>
            {formatConditionsLabel(audioBitrateConditions, audioBitrateLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasAudioStreamCount && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("audioStreamCountConditions", "audioStreamCountLogic")}
          >
            <span className="text-muted-foreground">Audio Tracks:</span>
            {formatConditionsLabel(audioStreamCountConditions, audioStreamCountLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasSubtitleStreamCount && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("subtitleStreamCountConditions", "subtitleStreamCountLogic")}
          >
            <span className="text-muted-foreground">Subtitle Tracks:</span>
            {formatConditionsLabel(subtitleStreamCountConditions, subtitleStreamCountLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasIsWatchlisted && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => updateFilter("isWatchlisted", undefined)}
          >
            <span className="text-muted-foreground">Watchlisted:</span>
            {filters.isWatchlisted === "true" ? "Yes" : "No"}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasEpisodeCount && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("episodeCountConditions", "episodeCountLogic")}
          >
            <span className="text-muted-foreground">Episodes:</span>
            {formatConditionsLabel(episodeCountConditions, episodeCountLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasWatchedEpisodeCount && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("watchedEpisodeCountConditions", "watchedEpisodeCountLogic")}
          >
            <span className="text-muted-foreground">Watched Episodes:</span>
            {formatConditionsLabel(watchedEpisodeCountConditions, watchedEpisodeCountLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasWatchedEpisodePercentage && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearConditions("watchedEpisodePercentageConditions", "watchedEpisodePercentageLogic")}
          >
            <span className="text-muted-foreground">Watched %:</span>
            {formatConditionsLabel(watchedEpisodePercentageConditions, watchedEpisodePercentageLogic)}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasLastEpisodeAiredAt && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearDateKeys(["lastEpisodeAiredAtMin", "lastEpisodeAiredAtMax", "lastEpisodeAiredAtDays"])}
          >
            <span className="text-muted-foreground">Last Aired:</span>
            {filters.lastEpisodeAiredAtDays
              ? `Last ${filters.lastEpisodeAiredAtDays} days`
              : filters.lastEpisodeAiredAtMin && filters.lastEpisodeAiredAtMax
                ? `${filters.lastEpisodeAiredAtMin} \u2013 ${filters.lastEpisodeAiredAtMax}`
                : filters.lastEpisodeAiredAtMin
                  ? `After ${filters.lastEpisodeAiredAtMin}`
                  : `Before ${filters.lastEpisodeAiredAtMax}`}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}

        {/* Date chips */}
        {hasLastPlayed && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearDateKeys(["lastPlayedAtMin", "lastPlayedAtMax", "lastPlayedAtDays"])}
          >
            <span className="text-muted-foreground">Last Played:</span>
            {filters.lastPlayedAtDays
              ? `Last ${filters.lastPlayedAtDays} days`
              : filters.lastPlayedAtMin && filters.lastPlayedAtMax
                ? `${filters.lastPlayedAtMin} \u2013 ${filters.lastPlayedAtMax}`
                : filters.lastPlayedAtMin
                  ? `After ${filters.lastPlayedAtMin}`
                  : `Before ${filters.lastPlayedAtMax}`}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasAddedAt && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearDateKeys(["addedAtMin", "addedAtMax", "addedAtDays"])}
          >
            <span className="text-muted-foreground">Added:</span>
            {filters.addedAtDays
              ? `Last ${filters.addedAtDays} days`
              : filters.addedAtMin && filters.addedAtMax
                ? `${filters.addedAtMin} \u2013 ${filters.addedAtMax}`
                : filters.addedAtMin
                  ? `After ${filters.addedAtMin}`
                  : `Before ${filters.addedAtMax}`}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}
        {hasReleaseDate && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => clearDateKeys(["originallyAvailableAtMin", "originallyAvailableAtMax", "originallyAvailableAtDays"])}
          >
            <span className="text-muted-foreground">Released:</span>
            {filters.originallyAvailableAtDays
              ? `Last ${filters.originallyAvailableAtDays} days`
              : filters.originallyAvailableAtMin && filters.originallyAvailableAtMax
                ? `${filters.originallyAvailableAtMin} \u2013 ${filters.originallyAvailableAtMax}`
                : filters.originallyAvailableAtMin
                  ? `After ${filters.originallyAvailableAtMin}`
                  : `Before ${filters.originallyAvailableAtMax}`}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}

        {/* Search chip */}
        {filters.search && (
          <Badge
            variant="secondary"
            className="gap-1 pl-2.5 pr-1.5 py-1 text-xs cursor-pointer hover:bg-secondary/80"
            onClick={() => {
              setSearchInput("");
              updateFilter("search", undefined);
            }}
          >
            <span className="text-muted-foreground">Search:</span>
            {filters.search}
            <X className="h-3 w-3 ml-0.5" />
          </Badge>
        )}

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

    </div>
  );
}
