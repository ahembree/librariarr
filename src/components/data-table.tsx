"use client";

import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronUp, ChevronDown, ChevronsUpDown, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { useColumnResize } from "@/hooks/use-column-resize";
import { arrangePinnedColumns, parseStoredPins, togglePinnedId } from "@/lib/table-pinning";
import { horizontalThumb, scrollPerThumbPixel } from "@/lib/scroll-thumb";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  accessor: (item: T) => React.ReactNode;
  sortValue?: (item: T) => string | number | null;
  sortable?: boolean;
  defaultWidth?: number;
  className?: string;
  headerClassName?: string;
  /** When true, hovering this column's cell does not open the row hover popover. */
  suppressRowHover?: boolean;
  /** Always pinned to the left edge, with no unpin button (needs `pinning`). */
  alwaysPinned?: boolean;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  onRowClick?: (item: T) => void;
  keyExtractor: (item: T) => string;
  defaultSortId?: string;
  defaultSortOrder?: "asc" | "desc";
  /** Controlled sort — when provided, sorting is handled externally (server-side). */
  onSortChange?: (sortId: string, sortOrder: "asc" | "desc") => void;
  /** localStorage key for persisting column widths. Enables resize when provided. */
  resizeStorageKey?: string;
  /** Ref to expose scrollToIndex for alphabet navigation */
  scrollToIndexRef?: React.RefObject<((index: number) => void) | null>;
  /** Optional render function for hover popover content on each row */
  renderHoverContent?: (item: T) => React.ReactNode;
  /**
   * Lets the user pin columns to the left edge from a button in each header.
   * Pins persist in localStorage under `storageKey`; `defaultPinned` applies
   * until the user changes them.
   */
  pinning?: { storageKey: string; defaultPinned: string[] };
}

function loadPins(pinning: { storageKey: string; defaultPinned: string[] } | undefined): string[] {
  if (!pinning) return [];
  if (typeof window === "undefined") return [...pinning.defaultPinned];
  try {
    return parseStoredPins(localStorage.getItem(pinning.storageKey), pinning.defaultPinned);
  } catch {
    return [...pinning.defaultPinned];
  }
}

/** "A", "A and B", "A, B and C". */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Header cell width around its title: `px-3` both sides plus the 4px resize handle. */
const HEADER_CELL_CHROME = 12 * 2 + 4;

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  keyExtractor,
  defaultSortId,
  defaultSortOrder = "asc",
  onSortChange,
  resizeStorageKey,
  scrollToIndexRef,
  renderHoverContent,
  pinning,
}: DataTableProps<T>) {
  const [internalSortId, setInternalSortId] = useState(defaultSortId ?? "");
  const [internalSortOrder, setInternalSortOrder] = useState<"asc" | "desc">(defaultSortOrder);

  // Row hover popover is controlled so that hovering a "suppressed" cell (e.g. a
  // selection checkbox) keeps the popover closed instead of covering the cell.
  const [openHoverKey, setOpenHoverKey] = useState<string | null>(null);
  const hoverSuppressedRef = useRef(false);

  // When controlled, use defaultSortId/defaultSortOrder as current values
  const sortId = onSortChange ? (defaultSortId ?? "") : internalSortId;
  const sortOrder = onSortChange ? (defaultSortOrder ?? "asc") : internalSortOrder;

  // Each header's natural width, measured from its rendered title. A column is
  // never narrower than its title: with `table-fixed` and nowrap headers, a
  // title wider than the column's default ran over the next column's title.
  const headerRefs = useRef(new Map<string, HTMLSpanElement>());
  const [headerMinWidths, setHeaderMinWidths] = useState<Record<string, number>>({});

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setHeaderMinWidths((prev) => {
        const next: Record<string, number> = {};
        for (const [id, el] of headerRefs.current) {
          next[id] = Math.ceil(el.getBoundingClientRect().width) + HEADER_CELL_CHROME;
        }
        const same = Object.keys(next).length === Object.keys(prev).length &&
          Object.entries(next).every(([id, w]) => prev[id] === w);
        return same ? prev : next;
      });
    };
    // Fires once per span on observe, and again when a web font swaps in.
    const observer = new ResizeObserver(measure);
    for (const el of headerRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [columns]);

  const resizeColumns = useMemo(
    () => columns.map((c) => ({
      id: c.id,
      defaultWidth: c.defaultWidth ?? 150,
      minWidth: headerMinWidths[c.id],
    })),
    [columns, headerMinWidths],
  );

  const { columnWidths, totalWidth, getResizeProps } = useColumnResize({
    columns: resizeColumns,
    storageKey: resizeStorageKey ?? "data-table-widths",
  });

  // --- Column pinning ---
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => loadPins(pinning));
  const pinnedSet = useMemo(
    () => new Set(pinning ? pinnedIds : []),
    [pinning, pinnedIds],
  );
  const pinnable = !!pinning;
  // The table's visible width, which caps how much of it pinned columns take.
  const [viewportWidth, setViewportWidth] = useState(0);
  const layout = useMemo(
    () => pinnable
      ? arrangePinnedColumns(columns, pinnedSet, columnWidths, viewportWidth)
      : { ordered: columns, pinnedCount: 0, offsets: {} as Record<string, number>, suspended: new Set<string>() },
    [columns, pinnable, pinnedSet, columnWidths, viewportWidth],
  );
  const orderedColumns = layout.ordered;
  const lastPinnedId = layout.pinnedCount > 0 ? orderedColumns[layout.pinnedCount - 1].id : null;
  const togglePin = (id: string) => {
    setPinnedIds((prev) => {
      const next = togglePinnedId(prev, id);
      if (pinning) {
        try {
          localStorage.setItem(pinning.storageKey, JSON.stringify(next));
        } catch {
          /* pins still apply for this visit */
        }
      }
      return next;
    });
  };
  const pinnedStyle = (id: string): React.CSSProperties | undefined =>
    id in layout.offsets ? { position: "sticky", left: layout.offsets[id] } : undefined;

  const sortedData = useMemo(() => {
    // When controlled (server-side sorting), data is already in correct order
    if (onSortChange) return data;
    if (!sortId) return data;
    const col = columns.find((c) => c.id === sortId);
    if (!col?.sortValue) return data;
    const getValue = col.sortValue;
    return [...data].sort((a, b) => {
      const aVal = getValue(a);
      const bVal = getValue(b);
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = typeof aVal === "number" && typeof bVal === "number"
        ? aVal - bVal
        : String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [data, sortId, sortOrder, columns, onSortChange]);

  const handleSort = (colId: string) => {
    const newOrder = sortId === colId ? (sortOrder === "asc" ? "desc" : "asc") : "asc";
    const newId = colId;
    if (onSortChange) {
      onSortChange(newId, newOrder);
    } else {
      setInternalSortId(newId);
      setInternalSortOrder(newOrder);
    }
  };

  // --- Row Virtualization ---
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    // Walk up the DOM to find the nearest scrollable ancestor
    let el = tableContainerRef.current?.parentElement ?? null;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scrollElementRef.current = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scrollElementRef.current) {
      scrollElementRef.current = document.querySelector<HTMLElement>("main");
    }
  }, []);

  useLayoutEffect(() => {
    const scrollEl = scrollElementRef.current;
    const tableEl = tableContainerRef.current;
    if (scrollEl && tableEl) {
      const margin = Math.round(
        tableEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      );
      setScrollMargin(margin);
    }
  }, [data.length]);

  // --- Sticky horizontal scrollbar ---
  // The table's own scrollbar sits below its last row, out of reach on a long
  // list without a trackpad. This bar sticks to the bottom of the viewport
  // while the table is on screen. It is drawn rather than native so it shows
  // the same everywhere (macOS overlay scrollbars hide until you scroll), and
  // it can be dragged, clicked to page, or scrolled with a mouse wheel.
  const tableRef = useRef<HTMLTableElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Positions the thumb by hand: the table scrolls on every frame of a drag,
  // and re-rendering every virtualized row for that would be wasted work.
  const updateThumb = useCallback(() => {
    const container = tableContainerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!container || !track || !thumb) return;
    const geometry = horizontalThumb(container.scrollLeft, container.scrollWidth, container.clientWidth, track.clientWidth);
    thumb.style.width = `${geometry.width}px`;
    thumb.style.transform = `translateX(${geometry.left}px)`;
  }, []);

  useEffect(() => {
    const container = tableContainerRef.current;
    const table = tableRef.current;
    if (!container || !table || typeof ResizeObserver === "undefined") return;
    const update = () => {
      setOverflowing(container.scrollWidth > container.clientWidth + 1);
      setViewportWidth(container.clientWidth);
      updateThumb();
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(table);
    return () => observer.disconnect();
  }, [updateThumb]);

  useLayoutEffect(() => {
    if (overflowing) updateThumb();
  }, [overflowing, updateThumb]);

  // A wheel over the bar scrolls sideways. Registered by hand because React's
  // wheel listener is passive and could not stop the page scrolling as well.
  useEffect(() => {
    const track = trackRef.current;
    const container = tableContainerRef.current;
    if (!overflowing || !track || !container) return;
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      container.scrollLeft += e.deltaMode === 1 ? delta * 40 : delta;
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [overflowing]);

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = tableContainerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!container || !track || !thumb) return;
    e.preventDefault();
    e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startScroll = container.scrollLeft;
    const ratio = scrollPerThumbPixel(container.scrollWidth, container.clientWidth, track.clientWidth, thumb.offsetWidth);
    const onMove = (ev: PointerEvent) => {
      container.scrollLeft = startScroll + (ev.clientX - startX) * ratio;
    };
    const onUp = () => {
      thumb.removeEventListener("pointermove", onMove);
      thumb.removeEventListener("pointerup", onUp);
      thumb.removeEventListener("pointercancel", onUp);
    };
    thumb.addEventListener("pointermove", onMove);
    thumb.addEventListener("pointerup", onUp);
    thumb.addEventListener("pointercancel", onUp);
  };

  // A click on the track beside the thumb pages one view towards the click.
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = tableContainerRef.current;
    const thumb = thumbRef.current;
    if (!container || !thumb) return;
    const thumbRect = thumb.getBoundingClientRect();
    const page = container.clientWidth * 0.9;
    if (e.clientX < thumbRect.left) container.scrollBy({ left: -page, behavior: "smooth" });
    else if (e.clientX > thumbRect.right) container.scrollBy({ left: page, behavior: "smooth" });
  };

  const virtualizer = useVirtualizer({
    count: sortedData.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 37,
    overscan: 15,
    scrollMargin,
  });

  useEffect(() => {
    if (!scrollToIndexRef) return;
    const ref = scrollToIndexRef;
    ref.current = (index: number) => {
      virtualizer.scrollToIndex(index, { align: "start" });
    };
    return () => { ref.current = null; };
  }, [scrollToIndexRef, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const effectiveMargin = virtualizer.options.scrollMargin ?? 0;
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start - effectiveMargin : 0;
  const paddingBottom = virtualRows.length > 0
    ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  // Named in a visible note, not a tooltip: a touch screen cannot hover, and
  // paused pins happen mostly on phones.
  const pausedLabels = orderedColumns
    .filter((c) => layout.suspended.has(c.id))
    .map((c) => (typeof c.header === "string" ? c.header : c.id));

  return (
    <div className="relative w-full">
    {pausedLabels.length > 0 && (
      <p className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Pin className="mt-0.5 h-3 w-3 shrink-0 fill-current text-primary/50" />
        <span>
          Not enough room to keep {formatList(pausedLabels)} pinned on this screen, so{" "}
          {pausedLabels.length === 1 ? "it scrolls" : "they scroll"} with the other columns. Pins
          apply again on a wider screen.
        </span>
      </p>
    )}
    <div
      ref={tableContainerRef}
      onScroll={updateThumb}
      // The native scrollbar sits below the last row, out of reach on a long
      // list; the sticky bar under the table replaces it.
      className="relative w-full overflow-x-auto rounded-lg border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <table ref={tableRef} className="w-full text-sm table-fixed" style={{ minWidth: totalWidth }}>
        <thead className="sticky top-0 z-10">
          <tr className="border-b bg-muted/50">
            {orderedColumns.map((col) => {
              const resizeProps = getResizeProps(col.id);
              const pinned = col.id in layout.offsets;
              const paused = layout.suspended.has(col.id);
              const label = typeof col.header === "string" ? col.header : col.id;
              return (
                <th
                  key={col.id}
                  className={cn(
                    "group/th relative px-3 py-2.5 text-left font-mono text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-faint uppercase",
                    col.sortable !== false && col.sortValue && "cursor-pointer select-none hover:text-foreground transition-colors",
                    pinned && "data-table-pinned-head z-[1]",
                    col.id === lastPinnedId && "data-table-pinned-edge",
                    col.headerClassName,
                  )}
                  style={{ width: columnWidths[col.id], ...pinnedStyle(col.id) }}
                  aria-sort={
                    col.sortable !== false && col.sortValue
                      ? sortId === col.id
                        ? sortOrder === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                  onClick={() => {
                    if (col.sortable !== false && col.sortValue) handleSort(col.id);
                  }}
                >
                  <span
                    ref={(el) => {
                      if (el) headerRefs.current.set(col.id, el);
                      else headerRefs.current.delete(col.id);
                    }}
                    className="inline-flex items-center gap-1"
                  >
                    {col.header}
                    {col.sortable !== false && col.sortValue && (
                      sortId === col.id ? (
                        sortOrder === "asc" ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-30" />
                      )
                    )}
                    {pinnable && !col.alwaysPinned && (
                      <button
                        type="button"
                        aria-label={pinned || paused ? `Unpin ${label}` : `Pin ${label}`}
                        aria-pressed={pinned || paused}
                        title={pinned || paused ? "Unpin column" : "Pin column to the left"}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(col.id);
                        }}
                        className={cn(
                          "-my-1 rounded p-1 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                          pinned
                            ? "text-primary opacity-100"
                            : paused
                              ? "text-primary opacity-50"
                              // Hidden until hover only where hovering exists: on a
                              // touch screen it would be an invisible tap target.
                              : "opacity-40 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/th:opacity-70",
                        )}
                      >
                        <Pin className={cn("h-3 w-3", (pinned || paused) && "fill-current")} />
                      </button>
                    )}
                  </span>
                  <div
                    className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 active:bg-primary z-10 touch-none"
                    onMouseDown={resizeProps.onMouseDown}
                    onTouchStart={resizeProps.onTouchStart}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={resizeProps.onDoubleClick}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={orderedColumns.length} style={{ height: paddingTop, padding: 0, border: "none" }} />
            </tr>
          )}
          {virtualRows.map((virtualRow) => {
            const item = sortedData[virtualRow.index];
            const key = keyExtractor(item);
            const hoverContent = renderHoverContent?.(item);

            const tableRow = (
              <tr
                key={key}
                data-index={virtualRow.index}
                data-clickable={onRowClick ? "" : undefined}
                className={cn(
                  "transition-colors duration-200 even:bg-white/1.5",
                  onRowClick && "cursor-pointer hover:bg-white/3 hover:ring-1 hover:ring-primary/20"
                )}
                onClick={() => onRowClick?.(item)}
              >
                {orderedColumns.map((col) => (
                  <td
                    key={col.id}
                    className={cn(
                      "px-3 py-2 whitespace-nowrap overflow-hidden text-ellipsis",
                      col.id in layout.offsets && "data-table-pinned z-[1]",
                      col.id === lastPinnedId && "data-table-pinned-edge",
                      col.className,
                    )}
                    style={pinnedStyle(col.id)}
                    onPointerEnter={
                      col.suppressRowHover
                        ? () => { hoverSuppressedRef.current = true; setOpenHoverKey(null); }
                        : undefined
                    }
                    onPointerLeave={
                      col.suppressRowHover
                        ? () => { hoverSuppressedRef.current = false; }
                        : undefined
                    }
                  >
                    {col.accessor(item)}
                  </td>
                ))}
              </tr>
            );

            if (!hoverContent) return <React.Fragment key={key}>{tableRow}</React.Fragment>;

            return (
              <HoverCard
                key={key}
                open={openHoverKey === key}
                onOpenChange={(open) => {
                  // Don't open the popover while the pointer is over a suppressed cell.
                  if (open && hoverSuppressedRef.current) return;
                  setOpenHoverKey(open ? key : null);
                }}
                openDelay={400}
                closeDelay={150}
              >
                <HoverCardTrigger asChild>
                  {tableRow}
                </HoverCardTrigger>
                <HoverCardContent
                  side="bottom"
                  align="start"
                  sideOffset={4}
                  className="w-72 p-0 duration-200"
                >
                  {hoverContent}
                </HoverCardContent>
              </HoverCard>
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={orderedColumns.length} style={{ height: paddingBottom, padding: 0, border: "none" }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
    {overflowing && (
      <div className="sticky bottom-0 z-20 bg-background/90 px-px py-1 backdrop-blur-sm" aria-hidden="true">
        <div
          ref={trackRef}
          onPointerDown={onTrackPointerDown}
          className="data-table-scrollbar relative h-2.5 cursor-pointer rounded-full bg-white/5"
        >
          <div
            ref={thumbRef}
            onPointerDown={onThumbPointerDown}
            className="absolute inset-y-0 left-0 cursor-grab touch-none rounded-full bg-white/25 transition-colors hover:bg-white/40 active:cursor-grabbing active:bg-white/50"
          />
        </div>
      </div>
    )}
    </div>
  );
}
