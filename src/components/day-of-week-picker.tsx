"use client";

import { DAY_LABELS } from "@/lib/schedule-format";
import { cn } from "@/lib/utils";

/**
 * The seven day toggles of a recurring schedule. `value` holds the selected
 * days by `Date.getDay()` index (0 = Sunday). The buttons are `type="button"`,
 * so a toggle inside a form never submits it.
 */
export function DayOfWeekPicker({
  value,
  onToggle,
  disabled = false,
  className,
}: {
  value: readonly number[];
  onToggle: (day: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)} role="group" aria-label="Days of week">
      {DAY_LABELS.map((label, day) => {
        const selected = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onToggle(day)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors border disabled:opacity-50",
              selected
                ? "border-primary bg-primary/10 text-primary"
                : "border-muted bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
