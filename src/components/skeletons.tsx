"use client";

import { useSyncExternalStore } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CARD_MIN_WIDTHS, MOBILE_CARD_MIN_WIDTHS, BREAKPOINTS, type CardSize } from "@/hooks/use-card-size";

const CARD_SIZE_KEY = "library-card-size";
const emptySubscribe = () => () => {};
function getCardWidthSnapshot(): number {
  // Runs during render — guard against localStorage throwing (private mode)
  // so the loading skeleton doesn't crash the page.
  let size: CardSize = "medium";
  try {
    const stored = localStorage.getItem(CARD_SIZE_KEY) as CardSize | null;
    if (stored && stored in CARD_MIN_WIDTHS) size = stored;
  } catch {
    // keep default
  }
  const widths = window.innerWidth < BREAKPOINTS.md ? MOBILE_CARD_MIN_WIDTHS : CARD_MIN_WIDTHS;
  return widths[size];
}
function getCardWidthServerSnapshot(): number {
  return CARD_MIN_WIDTHS.medium;
}

/** Media card skeleton matching MediaCard layout */
function MediaCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Skeleton className="aspect-2/3 w-full" />
      <div className="p-2 space-y-1.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <div className="flex gap-1">
          <Skeleton className="h-4 w-10 rounded-full" />
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/** Grid of media card skeletons. Reads the stored card size from localStorage
 *  so the skeleton grid matches the actual card layout. Uses useSyncExternalStore
 *  with a server snapshot to avoid hydration mismatches. */
export function MediaGridSkeleton({ count = 12 }: { count?: number }) {
  const cardWidth = useSyncExternalStore(
    emptySubscribe,
    getCardWidthSnapshot,
    getCardWidthServerSnapshot,
  );

  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))` }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <MediaCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Table row skeletons matching MediaTable layout */
export function TableRowsSkeleton({ rows = 10, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-md border">
      {/* Header */}
      <div className="flex items-center gap-4 border-b px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b last:border-b-0 px-4 py-3">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={j} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Dashboard chart card skeleton */
export function ChartCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-48 w-full rounded-md" />
      </CardContent>
    </Card>
  );
}

/** The dashboard's library tiles while the stats load. */
export function LibraryTilesSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-56 rounded-[14px]" />
      ))}
    </div>
  );
}

/** The dashboard's Insights grid while the stats and saved layout load. */
export function InsightsSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="md:col-span-6">
          <ChartCardSkeleton />
        </div>
      ))}
    </div>
  );
}

/** Log console skeleton matching the system logs console layout */
export function LogConsoleSkeleton({ rows = 14 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-surface-0 shadow-[var(--shadow-card)]">
      <div className="min-h-[200px] overflow-x-hidden py-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-[5px]">
            <Skeleton className="h-3.5 w-24 shrink-0" />
            <Skeleton className="h-3.5 w-12 shrink-0" />
            <Skeleton className="h-3.5 w-16 shrink-0" />
            {/* Deterministic width variation so lines read as log messages */}
            <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 23) % 50)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Settings page skeleton */
export function SettingsSkeleton() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Skeleton className="h-8 w-32 mb-6" />
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24 rounded-t-md" />
        ))}
      </div>
      <SettingsPanelSkeleton />
    </div>
  );
}

/** One settings tab's form fields, shown while that tab's data loads */
export function SettingsPanelSkeleton() {
  return (
    <div className="space-y-6 max-w-2xl">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}
