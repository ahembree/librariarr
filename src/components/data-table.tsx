"use client";

import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useColumnResize } from "@/hooks/use-column-resize";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";

export interface DataTableColumn<T> {
  id: string;
  header: string;
  accessor: (item: T) => React.ReactNode;
  sortValue?: (item: T) => string | number | null;
  sortable?: boolean;
  defaultWidth?: number;
  className?: string;
  headerClassName?: string;
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
}

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
}: DataTableProps<T>) {
  const [internalSortId, setInternalSortId] = useState(defaultSortId ?? "");
  const [internalSortOrder, setInternalSortOrder] = useState<"asc" | "desc">(defaultSortOrder);

  // When controlled, use defaultSortId/defaultSortOrder as current values
  const sortId = onSortChange ? (defaultSortId ?? "") : internalSortId;
  const sortOrder = onSortChange ? (defaultSortOrder ?? "asc") : internalSortOrder;

  const resizeColumns = useMemo(
    () => columns.map((c) => ({ id: c.id, defaultWidth: c.defaultWidth ?? 150 })),
    [columns],
  );

  const { columnWidths, totalWidth, getResizeProps } = useColumnResize({
    columns: resizeColumns,
    storageKey: resizeStorageKey ?? "data-table-widths",
  });

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

  return (
    <div ref={tableContainerRef} className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm table-fixed" style={{ minWidth: totalWidth }}>
        <thead className="sticky top-0 z-10">
          <tr className="border-b bg-muted/50">
            {columns.map((col) => {
              const resizeProps = getResizeProps(col.id);
              return (
                <th
                  key={col.id}
                  className={cn(
                    "px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap relative",
                    col.sortable !== false && col.sortValue && "cursor-pointer select-none hover:text-foreground transition-colors",
                    col.headerClassName,
                  )}
                  style={{ width: columnWidths[col.id] }}
                  onClick={() => {
                    if (col.sortable !== false && col.sortValue) handleSort(col.id);
                  }}
                >
                  <span className="inline-flex items-center gap-1">
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
              <td colSpan={columns.length} style={{ height: paddingTop, padding: 0, border: "none" }} />
            </tr>
          )}
          {virtualRows.map((virtualRow) => {
            const item = sortedData[virtualRow.index];
            const hoverContent = renderHoverContent?.(item);

            const tableRow = (
              <tr
                key={keyExtractor(item)}
                data-index={virtualRow.index}
                className={cn(
                  "transition-all duration-200 even:bg-white/1.5",
                  onRowClick && "cursor-pointer hover:bg-white/3 hover:ring-1 hover:ring-primary/20 hover:shadow-md hover:shadow-primary/10"
                )}
                onClick={() => onRowClick?.(item)}
              >
                {columns.map((col) => (
                  <td
                    key={col.id}
                    className={cn("px-3 py-2 whitespace-nowrap overflow-hidden text-ellipsis", col.className)}
                  >
                    {col.accessor(item)}
                  </td>
                ))}
              </tr>
            );

            if (!hoverContent) return <React.Fragment key={keyExtractor(item)}>{tableRow}</React.Fragment>;

            return (
              <HoverCard key={keyExtractor(item)} openDelay={400} closeDelay={150}>
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
              <td colSpan={columns.length} style={{ height: paddingBottom, padding: 0, border: "none" }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
