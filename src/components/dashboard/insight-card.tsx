"use client";

import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for all Insights-zone cards: an icon tile + title + mono
 * summary line on the left, controls on the right, content below. Keeps
 * the card set visually uniform regardless of what each card renders.
 */
export function InsightCard({
  icon: Icon,
  title,
  sub,
  controls,
  children,
  contentClassName,
}: {
  icon: LucideIcon;
  title: string;
  sub?: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px] border border-border bg-surface-2 text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-sm font-semibold leading-tight">
                {title}
              </CardTitle>
              {sub && (
                <p className="truncate font-mono text-[10.5px] text-faint">{sub}</p>
              )}
            </div>
          </div>
          {controls && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">{controls}</div>
          )}
        </div>
      </CardHeader>
      <CardContent className={cn("flex-1 min-h-0 flex flex-col overflow-auto", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}

/** Centered empty/info state for insight card bodies. */
export function InsightEmpty({
  icon: Icon,
  message,
}: {
  icon: LucideIcon;
  message: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
      <Icon className="h-6 w-6" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

/** Two-state segmented control (e.g. bars/donut view toggle). */
export function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; icon: LucideIcon; label: string }[];
}) {
  return (
    <div className="flex h-8 items-stretch overflow-hidden rounded-md border">
      {options.map(({ value: v, icon: Icon, label }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-label={label}
          aria-pressed={value === v}
          className={cn(
            "flex w-8 items-center justify-center transition-colors",
            value === v
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
