"use client";

import { cn } from "@/lib/utils";
import type { CardSize } from "@/hooks/use-card-size";

const SIZES: { value: CardSize; label: string }[] = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
];

interface CardSizeControlProps {
  size: CardSize;
  onChange: (size: CardSize) => void;
}

export function CardSizeControl({ size, onChange }: CardSizeControlProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
      {SIZES.map((s) => (
        <button
          key={s.value}
          onClick={() => onChange(s.value)}
          aria-pressed={size === s.value}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium transition-colors",
            // Match the view-toggle idiom: brand accent when active.
            size === s.value
              ? "bg-brand-dim text-brand-bright"
              : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
          )}
          title={`${s.value.charAt(0).toUpperCase()}${s.value.slice(1)} cards`}
          aria-label={`${s.value.charAt(0).toUpperCase()}${s.value.slice(1)} cards`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
