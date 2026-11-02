"use client";

import { ColorChip } from "@/components/color-chip";
import { useChipColors } from "@/components/chip-color-provider";
import { cn } from "@/lib/utils";
import { qualityChipText, type QualityChipSpec } from "@/lib/media/quality-chips";

/** One quality chip, coloured by its category and value. */
export function QualityChip({ chip, title }: { chip: QualityChipSpec; title?: string }) {
  const { getBadgeStyle } = useChipColors();
  return (
    <ColorChip style={getBadgeStyle(chip.category, chip.label)} title={title}>
      {qualityChipText(chip)}
    </ColorChip>
  );
}

/** A row of quality chips; renders nothing when there are none. */
export function QualityChips({ chips, className }: { chips: QualityChipSpec[]; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {chips.map((chip) => (
        <QualityChip key={`${chip.category}:${chip.label}`} chip={chip} />
      ))}
    </div>
  );
}
