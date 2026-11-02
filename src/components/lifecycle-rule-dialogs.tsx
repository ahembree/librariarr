"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ClipboardPaste, Copy, FlaskConical, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ColorChip } from "@/components/color-chip";
import { LoadingButton } from "@/components/loading-button";
import { PseudocodePanel } from "@/components/builder/pseudocode-panel";
import { ruleBuilderConfig } from "@/components/rule-builder";
import type { MatchedCriterion } from "@/components/media-detail-side-panel";
import { formatMediaItemTitle } from "@/lib/media/display-title";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

/**
 * The rule editor's dialogs that hold what the user types — a pasted import,
 * a Test Media search — each with its own state, so a keystroke in one
 * re-renders that dialog and not the editor and its preview behind it.
 */

/** "Export Rule Set": the JSON to copy. */
export function ExportRuleSetDialog({
  open,
  onOpenChange,
  json,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  json: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  // A new export starts uncopied.
  const [forJson, setForJson] = useState(json);
  if (forJson !== json) {
    setForJson(json);
    setCopied(false);
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export Rule Set</DialogTitle>
          <DialogDescription>
            Copy the JSON below to share or back up this rule set.
          </DialogDescription>
        </DialogHeader>
        <textarea
          readOnly
          value={json}
          className="h-64 w-full rounded-md border bg-muted p-3 font-mono text-xs focus:outline-none"
          onFocus={(e) => e.target.select()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={handleCopy}>
            {copied ? (
              <Check className="mr-2 h-4 w-4" />
            ) : (
              <Copy className="mr-2 h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy to Clipboard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Import Rule Set": paste an export; `onImport` gets the text and closes the dialog. */
export function ImportRuleSetDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (json: string) => void;
}) {
  const [json, setJson] = useState("");
  // Every opening starts empty.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setJson("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Rule Set</DialogTitle>
          <DialogDescription>
            Paste a previously exported rule set JSON below.
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder="Paste rule set JSON here..."
          className="h-64 w-full rounded-md border bg-muted p-3 font-mono text-xs focus:outline-none placeholder:text-muted-foreground"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onImport(json)} disabled={!json.trim()}>
            <ClipboardPaste className="mr-2 h-4 w-4" />
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TestMediaItem {
  id: string;
  title: string;
  parentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  thumbUrl?: string | null;
  type: string;
}

interface TestMediaResult {
  matches: boolean;
  matchedCriteria: MatchedCriterion[];
  actualValues: Record<string, string>;
}

export interface TestMediaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The editor's rules, as they stand (unsaved). */
  groups: LifecycleRuleGroup[];
  mediaType: "MOVIE" | "SERIES" | "MUSIC";
  /** The series/artist scope switch; undefined for movies, which have none. */
  seriesScope: boolean | undefined;
  serverIds: string[];
  arrInstanceId: string;
  /** The saved rule set being edited, if any. */
  ruleSetId: string | null;
}

/** "Test Media": search one item and evaluate it against the editor's rules. */
export function TestMediaDialog({
  open,
  onOpenChange,
  groups,
  mediaType,
  seriesScope,
  serverIds,
  arrInstanceId,
  ruleSetId,
}: TestMediaDialogProps) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<TestMediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<TestMediaItem | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [result, setResult] = useState<TestMediaResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Every opening starts with a new search.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSearch("");
      setResults([]);
      setSelected(null);
      setResult(null);
    }
  }

  const groupScope = seriesScope === true;
  // What Test Media evaluates: a show in series scope, otherwise one episode —
  // its show and SxxExx, never its own title — or a movie or track.
  const titleOf = (item: Omit<TestMediaItem, "type" | "id">) =>
    groupScope ? (item.parentTitle ?? item.title) : formatMediaItemTitle({ ...item, type: mediaType });

  const runSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: query, type: mediaType });
        if (groupScope) params.set("seriesScope", "true");
        const response = await fetch(`/api/media/search?${params}`);
        if (response.ok) {
          const data = await response.json();
          setResults(data.items ?? []);
        }
      } catch {
        // ignore
      } finally {
        setSearching(false);
      }
    },
    [mediaType, groupScope],
  );

  const handleSearchInput = (value: string) => {
    setSearch(value);
    setSelected(null);
    setResult(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearch(value), 300);
  };

  const evaluate = async (itemId: string) => {
    setEvaluating(true);
    setResult(null);
    try {
      const response = await fetch("/api/lifecycle/rules/test-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: groups,
          type: mediaType,
          seriesScope,
          mediaItemId: itemId,
          serverIds,
          arrInstanceId: arrInstanceId || null,
          ...(ruleSetId ? { ruleSetId } : {}),
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setResult({
          matches: data.matches,
          matchedCriteria: data.matchedCriteria ?? [],
          actualValues: data.actualValues ?? {},
        });
      } else {
        const data = await response.json().catch(() => null);
        toast.error(data?.error ?? "Failed to evaluate item");
      }
    } catch {
      toast.error("Failed to evaluate item");
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Test Media</DialogTitle>
          <DialogDescription>
            Search for a media item and evaluate it against the current rules.
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        {!selected && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by title..."
              value={search}
              onChange={(e) => handleSearchInput(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        )}

        {/* Search results */}
        {!selected && results.length > 0 && (
          <div className="max-h-60 overflow-y-auto rounded-md border">
            {results.map((item) => (
              <button
                key={item.id}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors border-b last:border-b-0"
                onClick={() => {
                  setSelected(item);
                  setResults([]);
                }}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{titleOf(item)}</p>
                  {item.year && (
                    <p className="text-xs text-muted-foreground">{item.year}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* No results */}
        {!selected && search.trim() && !searching && results.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No items found</p>
        )}

        {/* Searching indicator */}
        {searching && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm text-muted-foreground">Searching...</span>
          </div>
        )}

        {/* Selected item */}
        {selected && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">
                  {titleOf(selected)}
                </p>
                {selected.year && (
                  <p className="text-xs text-muted-foreground">{selected.year}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <LoadingButton
                  size="sm"
                  onClick={() => evaluate(selected.id)}
                  loading={evaluating}
                  icon={FlaskConical}
                >
                  Evaluate
                </LoadingButton>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(null);
                    setResult(null);
                    setSearch("");
                  }}
                >
                  Change
                </Button>
              </div>
            </div>

            {/* Evaluation results */}
            {result && (
              <div className="space-y-4">
                {/* Match indicator */}
                <div className="flex items-center gap-2">
                  <ColorChip
                    className={result.matches
                      ? "border-green/30 bg-green-dim text-green"
                      : "border-border bg-muted/40 text-muted-foreground"}
                  >
                    {result.matches ? "Matches Rules" : "Does Not Match"}
                  </ColorChip>
                </div>

                {/* Matched criteria badges */}
                {result.matchedCriteria.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Matched Criteria</h4>
                    <TooltipProvider>
                      <div className="flex flex-wrap gap-1.5">
                        {result.matchedCriteria.map((criterion, i) => {
                          const badge = (
                            <ColorChip key={i} className={criterion.negate ? "border-red/30 text-red" : undefined}>
                              {criterion.groupName && (
                                <span className="text-sky mr-1">[{criterion.groupName}]</span>
                              )}
                              {criterion.negate && <span className="text-red mr-1">NOT</span>}
                              {criterion.field} {criterion.operator} {criterion.value}
                            </ColorChip>
                          );
                          if (criterion.actualValue) {
                            return (
                              <Tooltip key={i}>
                                {/* ColorChip takes no ref, so the trigger is a wrapper. */}
                                <TooltipTrigger asChild><span className="inline-flex">{badge}</span></TooltipTrigger>
                                <TooltipContent>Actual: {criterion.actualValue}</TooltipContent>
                              </Tooltip>
                            );
                          }
                          return badge;
                        })}
                      </div>
                    </TooltipProvider>
                  </div>
                )}

                {/* Logic preview */}
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Logic Preview</h4>
                  <PseudocodePanel
                    groups={groups}
                    config={ruleBuilderConfig}
                    highlightedRuleIds={new Set(result.matchedCriteria.map((c) => c.ruleId))}
                    actualValues={new Map(Object.entries(result.actualValues))}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
