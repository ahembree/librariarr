"use client";

import { useState, useCallback, useRef, useMemo } from "react";

interface ColumnWidthConfig {
  id: string;
  defaultWidth: number;
  /** Narrowest this column may be, e.g. the width its header title needs. */
  minWidth?: number;
}

interface UseColumnResizeOptions {
  columns: ColumnWidthConfig[];
  storageKey: string;
  minWidth?: number;
}

interface ResizeHandlerProps {
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onDoubleClick: () => void;
}

interface UseColumnResizeReturn {
  columnWidths: Record<string, number>;
  totalWidth: number;
  getResizeProps: (columnId: string) => ResizeHandlerProps;
  resizingColumnId: string | null;
}

function loadStoredWidths(key: string): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredWidths(key: string, widths: Record<string, number>) {
  try {
    localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    // Silently fail
  }
}

/**
 * A column's rendered width: the user's stored width, else its default, never
 * below its own minimum (so a stored width saved before the minimum grew, or a
 * default narrower than the header title, cannot squeeze the title over the
 * next column).
 */
export function resolveColumnWidth(
  col: ColumnWidthConfig,
  stored: number | undefined,
): number {
  return Math.max(stored ?? col.defaultWidth, col.minWidth ?? 0);
}

export function useColumnResize({
  columns,
  storageKey,
  minWidth = 50,
}: UseColumnResizeOptions): UseColumnResizeReturn {
  const [storedWidths, setStoredWidths] = useState<Record<string, number>>(
    () => loadStoredWidths(storageKey),
  );
  const [resizingColumnId, setResizingColumnId] = useState<string | null>(null);

  const dragRef = useRef<{
    columnId: string;
    startX: number;
    startWidth: number;
    minWidth: number;
  } | null>(null);

  const columnWidths = useMemo(() => {
    const widths: Record<string, number> = {};
    for (const col of columns) {
      widths[col.id] = resolveColumnWidth(col, storedWidths[col.id]);
    }
    return widths;
  }, [columns, storedWidths]);

  const totalWidth = useMemo(
    () => Object.values(columnWidths).reduce((sum, w) => sum + w, 0),
    [columnWidths],
  );

  const handleDragMove = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = clientX - drag.startX;
      const newWidth = Math.max(minWidth, drag.minWidth, drag.startWidth + delta);
      setStoredWidths((prev) => ({ ...prev, [drag.columnId]: newWidth }));
    },
    [minWidth],
  );

  const handleDragEnd = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setResizingColumnId(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    setStoredWidths((prev) => {
      saveStoredWidths(storageKey, prev);
      return prev;
    });
  }, [storageKey]);

  const startDrag = useCallback(
    (columnId: string, startX: number) => {
      const startWidth = columnWidths[columnId] ?? 120;
      const colMin = columns.find((c) => c.id === columnId)?.minWidth ?? 0;
      dragRef.current = { columnId, startX, startWidth, minWidth: colMin };
      setResizingColumnId(columnId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMouseMove = (e: MouseEvent) => handleDragMove(e.clientX);
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches[0]) handleDragMove(e.touches[0].clientX);
      };
      const onEnd = () => {
        handleDragEnd();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onEnd);
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onEnd);
        document.removeEventListener("touchcancel", onEnd);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onEnd);
      document.addEventListener("touchmove", onTouchMove);
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    },
    [columns, columnWidths, handleDragMove, handleDragEnd],
  );

  const resetColumnWidth = useCallback(
    (columnId: string) => {
      const col = columns.find((c) => c.id === columnId);
      if (!col) return;
      setStoredWidths((prev) => {
        const next = { ...prev, [columnId]: col.defaultWidth };
        saveStoredWidths(storageKey, next);
        return next;
      });
    },
    [columns, storageKey],
  );

  const getResizeProps = useCallback(
    (columnId: string): ResizeHandlerProps => ({
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(columnId, e.clientX);
      },
      onTouchStart: (e: React.TouchEvent) => {
        e.stopPropagation();
        if (e.touches[0]) startDrag(columnId, e.touches[0].clientX);
      },
      onDoubleClick: () => resetColumnWidth(columnId),
    }),
    [startDrag, resetColumnWidth],
  );

  return { columnWidths, totalWidth, getResizeProps, resizingColumnId };
}
