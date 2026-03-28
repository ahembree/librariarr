"use client";

import { useSyncExternalStore } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CARD_MIN_WIDTHS, MOBILE_CARD_MIN_WIDTHS, BREAKPOINTS, type CardSize } from "@/hooks/use-card-size";

const CARD_SIZE_KEY = "library-card-size";
const emptySubscribe = () => () => {};
function getCardWidthSnapshot(): number {
  const stored = localStorage.getItem(CARD_SIZE_KEY) as CardSize | null;
  const size = stored && stored in CARD_MIN_WIDTHS ? stored : "medium";
  const widths = window.innerWidth < BREAKPOINTS.md ? MOBILE_CARD_MIN_WIDTHS : CARD_MIN_WIDTHS;
  return widths[size];
}
function getCardWidthServerSnapshot(): number {
  return CARD_MIN_WIDTHS.medium;
}

/** Stats card skeleton matching StatsCards layout */
export function StatsCardsSkeleton({ count = 4 }: { count?: number }) {
  const gridCols =
    count <= 2 ? "sm:grid-cols-2" : count === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <div className={`grid gap-4 ${gridCols}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-4 rounded" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-24" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Media card skeleton matching MediaCard layout */
export function MediaCardSkeleton() {
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

/** Filter bar skeleton matching MediaFilters layout */
export function FilterBarSkeleton() {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <Skeleton className="h-9 w-28 rounded-md" />
      <div className="flex items-center gap-1 rounded-lg border p-1">
        <Skeleton className="h-7 w-7 rounded-md" />
        <Skeleton className="h-7 w-7 rounded-md" />
      </div>
      <Skeleton className="h-9 w-24 rounded-md" />
      <Skeleton className="h-9 flex-1 max-w-xs rounded-md" />
      <Skeleton className="h-9 w-32 rounded-md" />
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

/** Dashboard page skeleton */
export function DashboardSkeleton() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 sm:mb-8">
        <Skeleton className="h-8 w-40" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-20 rounded-t-md" />
        ))}
      </div>
      <StatsCardsSkeleton />
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <ChartCardSkeleton />
        <ChartCardSkeleton />
      </div>
    </div>
  );
}

/** Library page skeleton (shared by movies, series, music) */
export function LibraryPageSkeleton() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Skeleton className="h-8 w-32 mb-6" />
      <FilterBarSkeleton />
      <MediaGridSkeleton />
    </div>
  );
}

/** Logs table skeleton matching the system logs table layout */
export function LogsTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b last:border-b-0">
          <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
          <td className="px-4 py-3"><Skeleton className="h-5 w-14 rounded-full" /></td>
          <td className="hidden px-4 py-3 md:table-cell"><Skeleton className="h-5 w-16 rounded-full" /></td>
          <td className="hidden px-4 py-3 md:table-cell"><Skeleton className="h-4 w-20" /></td>
          <td className="px-4 py-3"><Skeleton className="h-4 w-full max-w-md" /></td>
        </tr>
      ))}
    </>
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
      {/* Form fields */}
      <div className="space-y-6 max-w-2xl">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
