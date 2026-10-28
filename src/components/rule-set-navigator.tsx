"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ColorChip } from "@/components/color-chip";
import { countAllRules } from "@/components/rule-builder";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import type { SavedRuleSet } from "@/hooks/use-rule-editor-data";

/** Past this many rule sets the list offers a name filter. */
const SEARCH_THRESHOLD = 6;

function countRules(rules: LifecycleRule[] | LifecycleRuleGroup[]): number {
  if (rules.length === 0) return 0;
  if ("rules" in rules[0]) {
    return countAllRules(rules as LifecycleRuleGroup[]);
  }
  return rules.length;
}

/** Tinted chip for rule-set capability flags in the saved list. */
function FeatureChip({
  tone,
  children,
}: {
  tone: "green" | "amber" | "sky" | "purple" | "cyan" | "muted";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    green: "border-green/30 bg-green-dim text-green",
    amber: "border-amber/30 bg-amber-dim text-amber",
    sky: "border-sky/30 bg-sky-dim text-sky",
    purple: "border-purple-400/30 bg-purple-400/15 text-purple-400",
    cyan: "border-cyan-400/30 bg-cyan-400/15 text-cyan-400",
    muted: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <ColorChip className={`text-[10px] font-medium ${tones[tone]}`}>{children}</ColorChip>
  );
}

export interface RuleSetNavigatorProps {
  ruleSets: SavedRuleSet[];
  activeId: string | null;
  /** The scope chip's labels, for library types with a scope toggle. */
  scopeLabels?: { enabled: string; disabled: string };
  onSelect: (ruleSet: SavedRuleSet) => void;
  onToggleEnabled: (id: string, currentEnabled: boolean) => void;
  onDelete: (ruleSet: SavedRuleSet) => void;
}

function RuleSetChips({
  ruleSet,
  scopeLabels,
}: {
  ruleSet: SavedRuleSet;
  scopeLabels?: RuleSetNavigatorProps["scopeLabels"];
}) {
  const ruleCount = countRules(ruleSet.rules);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <span className="mr-1 font-mono text-[10.5px] text-faint">
        {ruleCount} rule{ruleCount !== 1 && "s"}
      </span>
      {!ruleSet.enabled && <FeatureChip tone="muted">Disabled</FeatureChip>}
      {ruleSet.enabled && ruleSet.actionEnabled && <FeatureChip tone="amber">Action</FeatureChip>}
      {ruleSet.enabled && !!ruleSet.collectionId && <FeatureChip tone="sky">Collection</FeatureChip>}
      {ruleSet.enabled && (ruleSet.addArrTags?.length > 0 || ruleSet.removeArrTags?.length > 0) && (
        <FeatureChip tone="purple">Tags</FeatureChip>
      )}
      {scopeLabels && (
        <FeatureChip tone="muted">
          {ruleSet.seriesScope !== false ? scopeLabels.enabled : scopeLabels.disabled}
        </FeatureChip>
      )}
      {ruleSet.serverIds?.length > 0 && (
        <FeatureChip tone="cyan">
          {ruleSet.serverIds.length} server{ruleSet.serverIds.length !== 1 ? "s" : ""}
        </FeatureChip>
      )}
    </div>
  );
}

/**
 * The searchable list both layouts render: the side rail on wide screens and
 * the bottom sheet everywhere else.
 */
function RuleSetList({
  ruleSets,
  activeId,
  scopeLabels,
  onSelect,
  onToggleEnabled,
  onDelete,
}: RuleSetNavigatorProps) {
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const showSearch = ruleSets.length >= SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ruleSets;
    return ruleSets.filter((rs) => rs.name.toLowerCase().includes(q));
  }, [ruleSets, query]);

  // Keep the rule set being edited in view within the list (a switch made
  // from the bar's previous/next steps, or the sheet opening), scrolling only
  // the list itself, never the page.
  useEffect(() => {
    const box = scrollRef.current;
    const row = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !row) return;
    const top = row.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = top + row.offsetHeight - box.clientHeight;
    }
  }, [activeId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSearch && (
        <div className="relative mb-2 shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter rule sets…"
            aria-label="Filter rule sets"
            className="h-8 pl-8 pr-8 text-sm"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div ref={scrollRef} className="relative -mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No rule sets match “{query}”.</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5" role="list">
            {filtered.map((ruleSet) => {
              const active = activeId === ruleSet.id;
              return (
                <li key={ruleSet.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(ruleSet)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(ruleSet);
                      }
                    }}
                    className={`group flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active ? "border-primary bg-primary/5" : "cursor-pointer hover:bg-muted/50"
                    }`}
                  >
                    <Switch
                      checked={ruleSet.enabled}
                      onCheckedChange={() => onToggleEnabled(ruleSet.id, ruleSet.enabled)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={`${ruleSet.enabled ? "Disable" : "Enable"} rule set ${ruleSet.name}`}
                      className="mt-0.5 shrink-0"
                    />
                    <div className={`min-w-0 flex-1 ${!ruleSet.enabled ? "opacity-60" : ""}`}>
                      <p className="truncate text-sm font-medium" title={ruleSet.name}>
                        {ruleSet.name}
                      </p>
                      <RuleSetChips ruleSet={ruleSet} scopeLabels={scopeLabels} />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="-mr-1 -mt-1 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete rule set ${ruleSet.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(ruleSet);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Wide screens: the saved rule sets as a rail beside the editor, pinned while
 * the editor scrolls, so switching never means scrolling back to the top.
 */
export function RuleSetRail(props: RuleSetNavigatorProps) {
  // Sized to the box that scrolls the page rather than the viewport: the
  // shell's header and any banner sit above it, so a viewport-tall rail ran
  // past the bottom of the screen.
  const asideRef = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    let scroller = asideRef.current?.parentElement ?? null;
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const box = scroller;
    const update = () => setMaxHeight(box.clientHeight - 32);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return (
    <aside
      ref={asideRef}
      style={maxHeight !== null ? { maxHeight } : undefined}
      className="hidden xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100dvh-2rem)] xl:w-72 xl:shrink-0 xl:self-start 2xl:w-80"
      aria-label="Saved rule sets"
    >
      <div className="flex min-h-0 w-full flex-col rounded-xl border bg-card p-3">
        <div className="mb-2 flex shrink-0 items-center gap-2 px-1 text-sm font-semibold">
          <FileText className="h-4 w-4" />
          Saved Rule Sets
          <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">{props.ruleSets.length}</span>
        </div>
        <RuleSetList {...props} />
      </div>
    </aside>
  );
}

/**
 * Narrower screens: a bar pinned to the top of the editor naming the rule set
 * being edited, with previous/next steps and a bottom sheet holding the full
 * list. It takes one line where the list took a screen or more.
 */
export function RuleSetSwitcherBar(props: RuleSetNavigatorProps) {
  const { ruleSets, activeId, onSelect } = props;
  const [open, setOpen] = useState(false);
  const index = activeId ? ruleSets.findIndex((rs) => rs.id === activeId) : -1;
  const active = index >= 0 ? ruleSets[index] : null;
  const prev = index > 0 ? ruleSets[index - 1] : null;
  const next = index >= 0 ? ruleSets[index + 1] ?? null : ruleSets[0] ?? null;

  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-white/5 bg-background/85 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 xl:hidden">
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            aria-label="Previous rule set"
            disabled={!prev}
            onClick={() => prev && onSelect(prev)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-[10.5px] uppercase tracking-wide text-muted-foreground">
                {active ? `Rule set ${index + 1} of ${ruleSets.length}` : `${ruleSets.length} saved rule set${ruleSets.length !== 1 ? "s" : ""}`}
              </span>
              <span className="block truncate text-sm font-medium">
                {active ? active.name : "New rule set"}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            aria-label="Next rule set"
            disabled={!next}
            onClick={() => next && onSelect(next)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="pb-safe mx-auto flex max-h-[85dvh] w-full flex-col gap-3 rounded-t-2xl px-4 pt-4 sm:max-w-xl sm:border-x"
        >
          <SheetHeader className="p-0 pr-8">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Saved Rule Sets
            </SheetTitle>
            <SheetDescription>
              {active ? (
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3.5 w-3.5 text-primary" />
                  Editing {active.name}
                </span>
              ) : (
                "Pick a rule set to edit."
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col pb-4">
            <RuleSetList
              {...props}
              onSelect={(rs) => {
                setOpen(false);
                onSelect(rs);
              }}
              onDelete={(rs) => {
                setOpen(false);
                props.onDelete(rs);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
