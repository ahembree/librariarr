"use client";

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FoldVertical, GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/resize-handle";
import { VerticalResizeHandle } from "@/components/vertical-resize-handle";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DASHBOARD_CELL_CLASS, dashboardCardStyle, StaticDashboardCard } from "@/components/dashboard-card-cell";
import type { DropAxis, DropSide } from "@/lib/dashboard/card-drop";
import { cn } from "@/lib/utils";

/** Where a dragged card would land relative to this one. */
export interface DropMarker {
  id: string;
  side: DropSide;
  axis: DropAxis;
}

/**
 * The marker's place: centred in the grid's 24 px gap (`gap-6`) on the side
 * the dragged card would land.
 */
const MARKER_POSITION: Record<DropAxis, Record<DropSide, string>> = {
  x: { before: "-left-3.5 inset-y-0 w-1", after: "-right-3.5 inset-y-0 w-1" },
  y: { before: "-top-3.5 inset-x-0 h-1", after: "-bottom-3.5 inset-x-0 h-1" },
};

interface SortableCardProps {
  id: string;
  size: number;
  heightPx?: number;
  minSize: number;
  maxSize: number;
  editMode: boolean;
  /** Set on the card a dragged card is over. */
  dropMarker?: DropMarker | null;
  onRemove: () => void;
  onResize: (newSize: number) => void;
  onHeightResize: (newHeight: number) => void;
  onHeightReset: () => void;
  children: React.ReactNode;
}

export function SortableCard({
  id,
  size,
  heightPx,
  minSize,
  maxSize,
  editMode,
  dropMarker,
  onRemove,
  onResize,
  onHeightResize,
  onHeightReset,
  children,
}: SortableCardProps) {
  const isMobile = useIsMobile();
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const displaySize = previewSize ?? size;
  const displayHeight = previewHeight ?? heightPx;

  // On mobile (single-column grid), don't apply gridColumn span
  const gridStyle = dashboardCardStyle(displaySize, displayHeight, isMobile);

  if (!editMode) {
    return (
      <StaticDashboardCard size={displaySize} heightPx={displayHeight}>
        {children}
      </StaticDashboardCard>
    );
  }

  // Only the settle after a drop moves a card (the grid holds still while
  // one is dragged). A translation alone: the cards differ in size, and a
  // scale between two of them stretched the card's content.
  const dndStyle: React.CSSProperties = {
    ...gridStyle,
    transform: CSS.Translate.toString(transform),
    transition: previewSize != null || previewHeight != null ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      className={cn(
        "relative rounded-lg border-2 border-dashed col-span-full md:col-auto flex flex-col transition-colors",
        dropMarker ? "border-primary/60" : "border-muted-foreground/25",
        isDragging && "opacity-40",
      )}
    >
      {/* One row, so the controls can never sit on top of each other: placed
          separately, a narrow card's Auto height button ran under its Remove
          button. Clicks pass through the row's empty middle. */}
      <div className="pointer-events-none absolute -top-3 inset-x-3 z-30 flex items-center gap-1 *:pointer-events-auto">
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label="Drag to move card"
          className="flex h-6 shrink-0 touch-none items-center gap-0.5 rounded bg-muted px-1.5 text-xs text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
          Drag
        </button>
        {heightPx != null && (
          <button
            type="button"
            aria-label="Auto height"
            title="Auto height: size the card to its content again"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground hover:text-foreground"
            onClick={onHeightReset}
          >
            <FoldVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Remove card"
          className="ml-auto h-6 w-6 shrink-0 rounded-full bg-muted p-0 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {dropMarker && (
        <div
          aria-hidden
          className={cn("pointer-events-none absolute z-30 rounded-full bg-primary", MARKER_POSITION[dropMarker.axis][dropMarker.side])}
        />
      )}
      <div className={cn("pt-2 flex-1 min-h-0 flex flex-col", DASHBOARD_CELL_CLASS)}>{children}</div>
      {!isMobile && (
        <>
          <ResizeHandle
            currentSize={size}
            minSize={minSize}
            maxSize={maxSize}
            onResize={onResize}
            onPreviewChange={setPreviewSize}
          />
          <VerticalResizeHandle
            currentHeight={heightPx}
            onResize={onHeightResize}
            onReset={onHeightReset}
            onPreviewChange={setPreviewHeight}
          />
        </>
      )}
    </div>
  );
}
