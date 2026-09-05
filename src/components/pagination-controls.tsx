"use client";

import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface PaginationControlsProps {
  /** Current page, 1-based. */
  page: number;
  /** Rows across every page — the control derives the page count from it. */
  totalCount: number;
  /** Rows per page. */
  pageSize: number;
  /** Called with a page already clamped to 1…totalPages, never the current one. */
  onPageChange: (page: number) => void;
  /** A page request is in flight: the controls lock and the spinner shows. */
  busy?: boolean;
  /**
   * Narrow host — a detail-grid card or the side panel: smaller controls, and
   * the range label is dropped since there is no room for it.
   */
  compact?: boolean;
  className?: string;
}

/**
 * First / prev / page-number / next / last, shared by the watch-history lists
 * and the history page so the two can't drift.
 *
 * Deliberately centred rather than flush right: these controls sit at the end
 * of a page, and the fixed `BackToTop` button (bottom-right, `right-6`) covers
 * the corner a right-aligned Next button would occupy.
 */
export function PaginationControls({
  page,
  totalCount,
  pageSize,
  onPageChange,
  busy = false,
  compact = false,
  className,
}: PaginationControlsProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalCount);

  // The field holds a draft until it's committed, so typing "12" doesn't fetch
  // page 1 on the way there. Re-synced whenever the page moves underneath it —
  // a Next click, or a reset to page 1 after a refresh.
  // (set-state-during-render is React 19's idiom for "reset state on prop change" —
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-state-when-a-prop-changes)
  const [draft, setDraft] = useState(String(page));
  const [prevPage, setPrevPage] = useState(page);
  if (prevPage !== page) {
    setPrevPage(page);
    setDraft(String(page));
  }

  const go = (target: number) => {
    if (busy) return;
    const clamped = Math.min(Math.max(target, 1), totalPages);
    if (clamped !== page) onPageChange(clamped);
  };

  const commitDraft = () => {
    const parsed = Number.parseInt(draft, 10);
    // Anything unparseable or out of range snaps back to the current page
    // rather than jumping somewhere the user didn't ask for.
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > totalPages) {
      setDraft(String(page));
      return;
    }
    go(parsed);
  };

  const iconClass = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  const buttonClass = compact ? "h-7 w-7" : "h-8 w-8";
  const textClass = compact ? "text-[11px]" : "text-sm";

  return (
    <div
      className={cn(
        "flex items-center justify-center text-muted-foreground",
        compact ? "gap-1" : "gap-3",
        className,
      )}
    >
      {!compact && (
        <span className="font-mono text-xs tabular-nums">
          {rangeStart.toLocaleString()}-{rangeEnd.toLocaleString()} of {totalCount.toLocaleString()}
        </span>
      )}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className={buttonClass}
          aria-label="First page"
          disabled={page <= 1 || busy}
          onClick={() => go(1)}
        >
          <ChevronsLeft className={iconClass} />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className={buttonClass}
          aria-label="Previous page"
          disabled={page <= 1 || busy}
          onClick={() => go(page - 1)}
        >
          <ChevronLeft className={iconClass} />
        </Button>
        <div className="flex items-center gap-1.5 px-1">
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              } else if (e.key === "Escape") {
                setDraft(String(page));
              }
            }}
            inputMode="numeric"
            aria-label="Page number"
            disabled={busy}
            className={cn(
              "px-1 text-center tabular-nums",
              // Trailing `!` — Tailwind v4's important modifier — so the size
              // beats the Input primitive's own `text-base md:text-sm`.
              compact ? "h-7 w-9 text-[11px]!" : "h-8 w-12 text-sm!",
            )}
          />
          <span className={cn("whitespace-nowrap", textClass)}>of {totalPages.toLocaleString()}</span>
        </div>
        <Button
          variant="outline"
          size="icon"
          className={buttonClass}
          aria-label="Next page"
          disabled={page >= totalPages || busy}
          onClick={() => go(page + 1)}
        >
          <ChevronRight className={iconClass} />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className={buttonClass}
          aria-label="Last page"
          disabled={page >= totalPages || busy}
          onClick={() => go(totalPages)}
        >
          <ChevronsRight className={iconClass} />
        </Button>
      </div>
    </div>
  );
}
