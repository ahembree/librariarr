"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { MIN_CARD_HEIGHT, MAX_CARD_HEIGHT } from "@/lib/dashboard/card-registry";

const HEIGHT_STEP = 50;

function snapToStep(px: number): number {
  return Math.round(px / HEIGHT_STEP) * HEIGHT_STEP;
}

interface VerticalResizeHandleProps {
  currentHeight: number | undefined;
  onResize: (newHeight: number) => void;
  onReset: () => void;
  onPreviewChange?: (previewHeight: number | null) => void;
}

export function VerticalResizeHandle({
  currentHeight,
  onResize,
  onReset,
  onPreviewChange,
}: VerticalResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(0);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const latestHeightRef = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback(
    (clientY: number) => {
      const el = handleRef.current?.parentElement;
      if (!el) return;
      const measured = currentHeight ?? el.getBoundingClientRect().height;
      const snapped = snapToStep(measured);
      startYRef.current = clientY;
      startHeightRef.current = snapped;
      latestHeightRef.current = snapped;
      setPreviewHeight(snapped);
      setIsDragging(true);
      onPreviewChange?.(snapped);
    },
    [currentHeight, onPreviewChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(e.clientY);
    },
    [startDrag]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation();
      startDrag(e.touches[0].clientY);
    },
    [startDrag]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    },
    [onReset]
  );

  useEffect(() => {
    if (!isDragging) return;

    const updateHeight = (clientY: number) => {
      const deltaY = clientY - startYRef.current;
      const raw = startHeightRef.current + deltaY;
      const snapped = snapToStep(raw);
      const clamped = Math.max(
        MIN_CARD_HEIGHT,
        Math.min(MAX_CARD_HEIGHT, snapped)
      );
      latestHeightRef.current = clamped;
      setPreviewHeight(clamped);
      onPreviewChange?.(clamped);
    };

    const handleMouseMove = (e: MouseEvent) => updateHeight(e.clientY);
    const handleTouchMove = (e: TouchEvent) => updateHeight(e.touches[0].clientY);

    const endDrag = () => {
      const finalHeight = latestHeightRef.current;
      setIsDragging(false);
      onPreviewChange?.(null);
      if (finalHeight !== startHeightRef.current) {
        onResize(finalHeight);
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
  }, [isDragging, onResize, onPreviewChange]);

  return (
    <>
      <div
        ref={handleRef}
        className="absolute bottom-0 left-0 right-0 h-4 cursor-row-resize z-20 group/vresize flex items-center justify-center hover:bg-primary/10 transition-colors touch-none"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onDoubleClick={handleDoubleClick}
      >
        <div className="h-0.5 w-8 rounded-full bg-muted-foreground/40 group-hover/vresize:bg-primary transition-colors" />
      </div>

      {isDragging && (
        <div className="absolute inset-0 z-10 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-popover border rounded-md px-3 py-1.5 shadow-lg">
            <span className="text-sm font-medium tabular-nums">
              {previewHeight}px
            </span>
          </div>
        </div>
      )}
    </>
  );
}
