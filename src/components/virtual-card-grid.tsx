"use client";

import { memo, type ReactNode } from "react";
import { PRIORITY_ROWS } from "@/components/media-card";
import type { VirtualPosterGrid } from "@/hooks/use-virtual-poster-grid";

export interface GridCardContext {
  /** The card's position in `items`. */
  index: number;
  /** In the first rows (`PRIORITY_ROWS`): load its artwork eagerly. */
  priority: boolean;
}

export type RenderGridCard<T> = (item: T, context: GridCardContext) => ReactNode;

interface GridCellProps<T> {
  item: T;
  index: number;
  priority: boolean;
  renderItem: RenderGridCard<T>;
}

/**
 * One card, memoised on its item, its place and the page's `renderItem`. The
 * grid re-renders on every virtualizer range change and again when the rest
 * of a library lands, and a card's own memo never holds through that (its
 * metadata, quality bar and hover content are new elements each render), so
 * every mounted card re-rendered each time. This is the movie grid's
 * `MovieGridCard`, for any grid: `renderItem` must be stable (`useCallback`
 * over what the cards read) for the memo to hold.
 */
const GridCell = memo(function GridCell<T>({ item, index, priority, renderItem }: GridCellProps<T>) {
  return <>{renderItem(item, { index, priority })}</>;
}) as <T>(props: GridCellProps<T>) => ReactNode;

export interface VirtualCardGridProps<T> {
  /** `useVirtualPosterGrid`'s result for the same `items` and columns. */
  grid: VirtualPosterGrid;
  items: readonly T[];
  getKey: (item: T) => string;
  /** Stable across renders (see `GridCell`). */
  renderItem: RenderGridCard<T>;
  /** Rows whose artwork loads eagerly. */
  priorityRows?: number;
  /**
   * On the outer element — the scroll box itself for a grid with its own
   * (`scrollElement: "own"`), e.g. `"md:max-h-[60dvh] overflow-y-auto"`.
   */
  className?: string;
}

/**
 * The rows `useVirtualPosterGrid` says are in view, each a CSS grid of
 * `columns` cards — the markup every virtualized poster grid repeated.
 */
export function VirtualCardGrid<T>({
  grid,
  items,
  getKey,
  renderItem,
  priorityRows = PRIORITY_ROWS,
  className,
}: VirtualCardGridProps<T>) {
  const { containerRef, virtualizer, rows, columns, gap, rowRange, rowOffset } = grid;
  return (
    <div ref={containerRef} className={className}>
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {rows.map((row) => {
          const [start, end] = rowRange(row.index);
          const priority = row.index < priorityRows;
          const cells: ReactNode[] = [];
          for (let index = start; index < end && index < items.length; index++) {
            const item = items[index];
            cells.push(
              <GridCell key={getKey(item)} item={item} index={index} priority={priority} renderItem={renderItem} />,
            );
          }
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                paddingBottom: gap,
                transform: `translateY(${rowOffset(row)}px)`,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gap: `${gap}px`,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {cells}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
