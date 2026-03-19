"use client";

import { useState, useCallback, useRef } from "react";

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
    return raw ? Number(raw) : null;
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
  const [width, setWidth] = useState<number>(
    () => loadStoredWidth(storageKey) ?? defaultWidth,
  );
  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

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
