"use client";

import { useState, useCallback, useRef, useEffect } from "react";

interface UsePanelResizeOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onDoubleClick: () => void;
}

interface UsePanelResizeReturn {
  width: number;
  isDragging: boolean;
  resizeHandleProps: ResizeHandleProps;
}

function loadStoredWidth(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const width = Number(raw);
    // A corrupt value ("abc") read as NaN and rendered a panel with no width.
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

function saveStoredWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // Silently fail
  }
}

export function usePanelResize({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
}: UsePanelResizeOptions): UsePanelResizeReturn {
  // A stored width outside today's bounds (saved before they changed) is
  // clamped on load, as a drag would clamp it.
  const [width, setWidth] = useState<number>(() => {
    const stored = loadStoredWidth(storageKey);
    return stored == null ? defaultWidth : Math.min(maxWidth, Math.max(minWidth, stored));
  });
  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  // Ends the drag in progress, if any: detaches its document listeners and
  // restores the body styles. Also run on unmount, since a panel closed
  // mid-drag never sees its mouseup and would leave the page unselectable.
  const endDragRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    const end = endDragRef.current;
    if (!end) return;
    endDragRef.current = null;
    dragRef.current = null;
    end();
  }, []);

  const handleDragMove = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Dragging left (negative delta) increases width since panel is on the right
      const delta = drag.startX - clientX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, drag.startWidth + delta));
      setWidth(newWidth);
    },
    [minWidth, maxWidth],
  );

  const handleDragEnd = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setIsDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    setWidth((prev) => {
      saveStoredWidth(storageKey, prev);
      return prev;
    });
  }, [storageKey]);

  const startDrag = useCallback(
    (startX: number) => {
      dragRef.current = { startX, startWidth: width };
      setIsDragging(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMouseMove = (e: MouseEvent) => handleDragMove(e.clientX);
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches[0]) handleDragMove(e.touches[0].clientX);
      };
      const detach = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onEnd);
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onEnd);
        document.removeEventListener("touchcancel", onEnd);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      const onEnd = () => {
        handleDragEnd();
        detach();
        if (endDragRef.current === detach) endDragRef.current = null;
      };
      endDragRef.current = detach;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onEnd);
      document.addEventListener("touchmove", onTouchMove);
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    },
    [width, handleDragMove, handleDragEnd],
  );

  const resetWidth = useCallback(() => {
    setWidth(defaultWidth);
    saveStoredWidth(storageKey, defaultWidth);
  }, [defaultWidth, storageKey]);

  const resizeHandleProps: ResizeHandleProps = {
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(e.clientX);
    },
    onTouchStart: (e: React.TouchEvent) => {
      e.stopPropagation();
      if (e.touches[0]) startDrag(e.touches[0].clientX);
    },
    onDoubleClick: resetWidth,
  };

  return { width, isDragging, resizeHandleProps };
}
