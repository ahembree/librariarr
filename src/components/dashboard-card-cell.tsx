"use client";

import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * A dashboard card's place in the 12-column grid: its column span (none on a
 * phone, where the grid is one column) and its saved height.
 */
export function dashboardCardStyle(size: number, heightPx: number | undefined | null, isMobile: boolean): React.CSSProperties {
  return {
    ...(isMobile ? {} : { gridColumn: `span ${size}` }),
    ...(heightPx != null ? { height: heightPx } : {}),
  };
}

/**
 * A card outside edit mode: only its place in the grid. Kept apart from the
 * sortable card so the dashboard does not load the drag-and-drop library
 * until the user starts customizing.
 */
export function StaticDashboardCard({
  size,
  heightPx,
  children,
}: {
  size: number;
  heightPx?: number;
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <div
      style={dashboardCardStyle(size, heightPx, isMobile)}
      className={`col-span-full md:col-auto${heightPx != null ? " flex flex-col" : ""}`}
    >
      {children}
    </div>
  );
}
