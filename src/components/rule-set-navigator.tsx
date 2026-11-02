"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Pin, PinOff, Search, Trash2, X } from "lucide-react";
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
import { useLocalStorage } from "@/hooks/use-local-storage";
import { avatarColor } from "@/lib/avatar";
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
 * The searchable list in the switcher bar's bottom sheet.
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
 * A rule set's monogram: the first and last words' initials ("Old 720p
 * movies" → OM), or the first initial and a short trailing number ("Old
 * movies 12" → O12).
 */
function monogram(name: string): string {
  // Split by code point, so a name led by an emoji keeps it whole rather
  // than showing half of a surrogate pair.
  const words = name.trim().split(/\s+/).filter(Boolean).map((w) => Array.from(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).join("").toUpperCase();
  const last = words[words.length - 1];
  // A trailing number is what tells "Old movies 2" from "Old movies 12".
  if (/^\d{1,2}$/.test(last.join(""))) return (words[0][0] + last.join("")).toUpperCase();
  return (words[0][0] + last[0]).toUpperCase();
}

const RAIL_PINNED_KEY = "lifecycle-rule-rail-pinned";
/** Hover-intent delays: the rail neither flickers open as the pointer
 * crosses it on its way to the editor nor snaps shut on a brief overshoot. */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 220;

/**
 * Wide screens with a pointer: the saved rule sets as a slim strip of
 * monograms beside the editor, pinned while the editor scrolls. Hovering (or
 * tabbing into) it opens the full list over the editor, so the editor keeps
 * its width; the pin keeps the list open beside it instead.
 */
export function RuleSetRail(props: RuleSetNavigatorProps) {
  const { ruleSets, activeId, scopeLabels, onSelect, onToggleEnabled, onDelete } = props;
  const [pinnedValue, setPinnedValue] = useLocalStorage<"0" | "1">(RAIL_PINNED_KEY, "0");
  const pinned = pinnedValue === "1";
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const showSearch = ruleSets.length >= SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ruleSets;
    return ruleSets.filter((rs) => rs.name.toLowerCase().includes(q));
  }, [ruleSets, query]);

  const schedule = (next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(next), delay);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // The panel is as tall as its list, capped at the space it has on screen:
  // from where it sits (or its pinned offset, once stuck) to the bottom of
  // the box that scrolls the page, and never past the editor beside it — so
  // it neither runs below the visible area nor makes a short page longer.
  // Re-measured as the page scrolls, since that space grows until it sticks.
  const asideRef = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const aside = asideRef.current;
    let scroller = aside?.parentElement ?? null;
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (!aside || !scroller) return;
    const box = scroller;
    const STICKY_TOP = 16;
    const GAP_BELOW = 16;
    let frame = 0;
    const update = () => {
      frame = 0;
      const boxRect = box.getBoundingClientRect();
      const asideRect = aside.getBoundingClientRect();
      const top = Math.max(asideRect.top, boxRect.top + STICKY_TOP);
      const bottom = Math.min(boxRect.bottom - GAP_BELOW, asideRect.bottom);
      setHeight(Math.max(0, Math.round(bottom - top)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(box);
    observer.observe(aside);
    box.addEventListener("scroll", schedule, { passive: true });
    return () => {
      observer.disconnect();
      box.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Keep the rule set being edited in view within the strip.
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Content past the monogram column fades with the panel's width, so the
  // collapsed strip shows monograms alone.
  const reveal = `transition-opacity duration-150 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`;

  return (
    <aside
      ref={asideRef}
      aria-label="Saved rule sets"
      className={`relative hidden shrink-0 transition-[width] duration-200 ease-out rail:z-30 rail:block rail:self-stretch ${
        pinned ? "w-80" : "w-14"
      }`}
    >
      <div
        className="sticky top-4"
        style={{ height: height ?? 0 }}
      >
      <div
        className={`absolute left-0 top-0 z-30 flex max-h-full flex-col overflow-hidden rounded-xl border bg-card transition-[width,box-shadow] duration-200 ease-out ${
          open ? "w-80" : "w-14"
        } ${open && !pinned ? "shadow-2xl shadow-black/60" : ""}`}
        onMouseEnter={() => schedule(true, OPEN_DELAY_MS)}
        onMouseLeave={() => schedule(false, CLOSE_DELAY_MS)}
        onFocus={() => {
          if (timer.current) clearTimeout(timer.current);
          setHovered(true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !pinned) {
            setHovered(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }
        }}
      >
        {/* Fixed width, so nothing reflows while the panel animates. */}
        <div className="flex min-h-0 w-80 flex-col p-2">
          <div className="flex h-10 shrink-0 items-center gap-2">
            <div className="flex w-10 shrink-0 justify-center">
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className={`flex min-w-0 flex-1 items-center gap-2 ${reveal}`}>
              <span className="text-sm font-semibold">Rule Sets</span>
              <span className="font-mono text-xs text-muted-foreground">{ruleSets.length}</span>
              <Button
                variant="ghost"
                size="icon"
                className={`ml-auto h-8 w-8 ${pinned ? "text-primary" : "text-muted-foreground"}`}
                aria-label={pinned ? "Unpin rule set list" : "Pin rule set list open"}
                aria-pressed={pinned}
                title={pinned ? "Unpin" : "Keep open"}
                tabIndex={open ? 0 : -1}
                onClick={() => setPinnedValue(pinned ? "0" : "1")}
              >
                {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {showSearch && (
            <div className="mb-1 flex h-10 shrink-0 items-center gap-2">
              <button
                type="button"
                aria-label="Filter rule sets"
                tabIndex={open ? -1 : 0}
                onClick={() => searchRef.current?.focus()}
                className={`flex h-9 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 ${
                  query ? "text-primary" : ""
                }`}
              >
                <Search className="h-4 w-4" />
              </button>
              <div className={`relative min-w-0 flex-1 ${reveal}`}>
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name…"
                  aria-label="Filter rule sets by name"
                  tabIndex={open ? 0 : -1}
                  className="h-8 pr-8 text-sm"
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
            </div>
          )}

          <div className="mx-0 mb-1 h-px shrink-0 bg-border" />

          <div
            ref={scrollRef}
            className={`relative min-h-0 overscroll-contain ${open ? "overflow-y-auto" : "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"}`}
          >
            {filtered.length === 0 ? (
              <p className={`py-6 pl-12 pr-2 text-sm text-muted-foreground ${reveal}`}>No rule sets match “{query}”.</p>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5" role="list">
                {filtered.map((ruleSet) => {
                  const active = activeId === ruleSet.id;
                  return (
                    <li key={ruleSet.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-current={active ? "true" : undefined}
                        aria-label={`Edit rule set ${ruleSet.name}`}
                        onClick={() => onSelect(ruleSet)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelect(ruleSet);
                          }
                        }}
                        className={`group/row flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                          // Row highlights span the open list's width; in the
                          // collapsed strip they would be clipped mid-row, so
                          // the monogram's ring marks the selection there.
                          !open ? "" : active ? "bg-primary/10" : "hover:bg-muted/50"
                        }`}
                      >
                        <div className="flex w-10 shrink-0 justify-center">
                          <span
                            className={`relative flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-semibold ring-1 ${avatarColor(ruleSet.name)} ${
                              active ? `ring-2 ring-primary! ${open ? "" : "ring-offset-2 ring-offset-card"}` : open ? "" : "transition-transform group-hover/row:scale-105"
                            } ${!ruleSet.enabled ? "opacity-40 grayscale" : ""}`}
                          >
                            {monogram(ruleSet.name)}
                            {ruleSet.enabled && ruleSet.actionEnabled && (
                              <span
                                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber ring-2 ring-card"
                                aria-hidden="true"
                              />
                            )}
                          </span>
                        </div>
                        <div className={`flex min-w-0 flex-1 items-center gap-2 ${reveal}`}>
                          <div className={`min-w-0 flex-1 ${!ruleSet.enabled ? "opacity-60" : ""}`}>
                            <p className={`truncate text-sm ${active ? "font-semibold text-foreground" : "font-medium"}`} title={ruleSet.name}>
                              {ruleSet.name}
                            </p>
                            <RuleSetChips ruleSet={ruleSet} scopeLabels={scopeLabels} />
                          </div>
                          <Switch
                            checked={ruleSet.enabled}
                            onCheckedChange={() => onToggleEnabled(ruleSet.id, ruleSet.enabled)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            tabIndex={open ? 0 : -1}
                            aria-label={`${ruleSet.enabled ? "Disable" : "Enable"} rule set ${ruleSet.name}`}
                            className="shrink-0 scale-90"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            tabIndex={open ? 0 : -1}
                            className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
                            aria-label={`Delete rule set ${ruleSet.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDelete(ruleSet);
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
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
      <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-white/5 bg-background/85 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 rail:hidden">
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
