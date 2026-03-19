"use client";

import { useCallback, useRef, useState, useEffect } from "react";

interface ResizeHandleProps {
  currentSize: number;
  minSize: number;
  maxSize: number;
  onResize: (newSize: number) => void;
  onPreviewChange?: (previewSize: number | null) => void;
}

export function ResizeHandle({
  currentSize,
  minSize,
  maxSize,
  onResize,
  onPreviewChange,
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previewSize, setPreviewSize] = useState(currentSize);
  const startXRef = useRef(0);
  const startSizeRef = useRef(currentSize);
  const containerWidthRef = useRef(0);
  const latestSizeRef = useRef(currentSize);

  const getGridContainer = useCallback((el: HTMLElement | null): HTMLElement | null => {
    let parent = el?.parentElement;
    while (parent) {
      const display = getComputedStyle(parent).display;
      if (display === "grid" || display === "inline-grid") return parent;
      parent = parent.parentElement;
    }
    return null;
  }, []);

  const startDrag = useCallback(
    (clientX: number, target: HTMLElement) => {
      const gridContainer = getGridContainer(target);
      if (!gridContainer) return;

      containerWidthRef.current = gridContainer.getBoundingClientRect().width;
      startXRef.current = clientX;
      startSizeRef.current = currentSize;
      latestSizeRef.current = currentSize;
      setPreviewSize(currentSize);
      setIsDragging(true);
      onPreviewChange?.(currentSize);
    },
    [currentSize, getGridContainer, onPreviewChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(e.clientX, e.currentTarget as HTMLElement);
    },
    [startDrag]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation();
      const touch = e.touches[0];
      startDrag(touch.clientX, e.currentTarget as HTMLElement);
    },
    [startDrag]
  );

  useEffect(() => {
    if (!isDragging) return;

    const colWidth = containerWidthRef.current / 12;

    const updateSize = (clientX: number) => {
      const deltaX = clientX - startXRef.current;
      const deltaCols = Math.round(deltaX / colWidth);
      const newSize = Math.max(
        minSize,
        Math.min(maxSize, startSizeRef.current + deltaCols)
      );
      latestSizeRef.current = newSize;
      setPreviewSize(newSize);
      onPreviewChange?.(newSize);
    };

    const handleMouseMove = (e: MouseEvent) => updateSize(e.clientX);
    const handleTouchMove = (e: TouchEvent) => updateSize(e.touches[0].clientX);

    const endDrag = () => {
      const finalSize = latestSizeRef.current;
      setIsDragging(false);
      setPreviewSize(finalSize);
      onPreviewChange?.(null);
      if (finalSize !== startSizeRef.current) {
        onResize(finalSize);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", endDrag);
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", endDrag);
    document.addEventListener("touchcancel", endDrag);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", endDrag);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", endDrag);
      document.removeEventListener("touchcancel", endDrag);
    };
  }, [isDragging, minSize, maxSize, onResize, onPreviewChange]);

  return (
    <>
      {/* Resize handle bar */}
      <div
        className="absolute right-0 top-0 bottom-0 w-4 cursor-col-resize z-20 group/resize flex items-center justify-center hover:bg-primary/10 transition-colors touch-none"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        <div className="w-0.5 h-8 rounded-full bg-muted-foreground/40 group-hover/resize:bg-primary transition-colors" />
      </div>

      {/* Size indicator while dragging */}
      {isDragging && (
        <div className="absolute inset-0 z-10 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-popover border rounded-md px-3 py-1.5 shadow-lg">
            <span className="text-sm font-medium tabular-nums">
              {previewSize}/12
            </span>
          </div>
        </div>
      )}
    </>
  );
}
