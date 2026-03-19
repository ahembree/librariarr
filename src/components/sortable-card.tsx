"use client";

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/resize-handle";
import { VerticalResizeHandle } from "@/components/vertical-resize-handle";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface SortableCardProps {
  id: string;
  size: number;
  heightPx?: number;
  minSize: number;
  maxSize: number;
  editMode: boolean;
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
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const displaySize = previewSize ?? size;
  const displayHeight = previewHeight ?? heightPx;

  // On mobile (single-column grid), don't apply gridColumn span
  const gridStyle: React.CSSProperties = {
    ...(isMobile ? {} : { gridColumn: `span ${displaySize}` }),
    ...(displayHeight != null ? { height: displayHeight } : {}),
  };

  if (!editMode) {
    return (
      <div style={gridStyle} className={`col-span-full md:col-auto${displayHeight != null ? " flex flex-col" : ""}`}>
        {children}
      </div>
    );
  }

  const dndStyle: React.CSSProperties = {
    ...gridStyle,
    transform: CSS.Transform.toString(transform),
    transition: previewSize != null || previewHeight != null ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      className={`relative rounded-lg border-2 border-dashed border-muted-foreground/25 col-span-full md:col-auto flex flex-col ${
        isDragging ? "opacity-50 z-50" : ""
      }`}
    >
      <div className="absolute -top-3 left-3 z-10 flex items-center gap-1">
        <button
          className="flex h-6 items-center gap-0.5 rounded bg-muted px-1.5 text-xs text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
          Drag
        </button>
      </div>
      <div className="absolute -top-3 right-8 z-10">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 rounded-full bg-muted p-0 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="pt-2 flex-1 min-h-0 flex flex-col">{children}</div>
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
