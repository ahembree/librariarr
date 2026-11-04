"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { widthForKey } from "@/lib/dashboard/resize-keys";

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

  // The keyboard's way to resize: a focusable separator (the window-splitter
  // pattern) that ArrowLeft/ArrowRight move a column at a time.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const next = widthForKey(e.key, currentSize, minSize, maxSize);
      if (next === null) return;
      e.preventDefault();
      if (next !== currentSize) onResize(next);
    },
    [currentSize, minSize, maxSize, onResize]
  );

  return (
    <>
      {/* Resize handle bar: in the gap beside the card, so it never sits over
          the card's own content (its scrollbar runs down that edge) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Card width"
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        aria-valuenow={currentSize}
        aria-valuetext={`${currentSize} of 12 columns`}
        tabIndex={0}
        title="Drag, or use the arrow keys, to set the width"
        className="absolute -right-5 top-0 bottom-0 w-4 cursor-col-resize z-20 rounded group/resize flex items-center justify-center hover:bg-primary/10 transition-colors touch-none outline-none focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleKeyDown}
      >
        <div className="w-0.5 h-8 rounded-full bg-muted-foreground/40 group-hover/resize:bg-primary group-focus-visible/resize:bg-primary transition-colors" />
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
