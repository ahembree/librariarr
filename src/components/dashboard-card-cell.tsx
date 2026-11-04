"use client";

import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * What holds a card's content to its cell (`.dashboard-cell`, globals.css):
 * a card set shorter or narrower than its content clips at its own border and
 * scrolls its body, instead of painting over the cards around it, and the
 * box is a size container, so a card can lay out by its own width.
 */
export const DASHBOARD_CELL_CLASS = "dashboard-cell";

/**
 * The classes of the node a card's content renders into (`CardHosts` in
 * dashboard-card-grid.tsx): it fills the cell it is moved into, plain or the
 * editor's frame, and holds the card to it.
 */
export const CARD_HOST_CLASS = `${DASHBOARD_CELL_CLASS} flex min-h-0 flex-1 flex-col`;

/**
 * A dashboard card's place in the 12-column grid: its column span and its
 * saved height — neither on a phone, where the grid is one column and every
 * card takes its content's height (heights are set on a wider screen, where
 * the card lays its content out differently).
 */
export function dashboardCardStyle(size: number, heightPx: number | undefined | null, isMobile: boolean): React.CSSProperties {
  if (isMobile) return {};
  return {
    gridColumn: `span ${size}`,
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
    <div style={dashboardCardStyle(size, heightPx, isMobile)} className="col-span-full md:col-auto flex flex-col">
      {children}
    </div>
  );
}
