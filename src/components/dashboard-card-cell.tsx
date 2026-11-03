"use client";

import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * What holds a card's content to its cell (`.dashboard-cell`, globals.css):
 * a card set shorter or narrower than its content clips at its own border and
 * scrolls its body, instead of painting over the cards around it, and the
 * cell is a size container, so a card can lay out by its own width.
 */
export const DASHBOARD_CELL_CLASS = "dashboard-cell";

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
      className={`${DASHBOARD_CELL_CLASS} col-span-full md:col-auto${heightPx != null ? " flex flex-col" : ""}`}
    >
      {children}
    </div>
  );
}
