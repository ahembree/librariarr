import { Minus, Plus } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { ROW_TONE_LABELS, type RowTone } from "@/lib/table-row-surface";
import { cn } from "@/lib/utils";

const TONE_CHIP: Record<RowTone, { className: string; Icon: typeof Plus }> = {
  added: { className: "border-green/30 bg-green-dim text-green", Icon: Plus },
  removed: { className: "border-amber/30 bg-amber-dim text-amber", Icon: Minus },
};

/**
 * A row's or card's tone in words and shape as well as colour — "+ New" or
 * "− Removed" — so the state reads without telling green from amber.
 */
export function RowToneChip({ tone, className }: { tone: RowTone; className?: string }) {
  const { className: toneClass, Icon } = TONE_CHIP[tone];
  const label = ROW_TONE_LABELS[tone];
  return (
    <ColorChip className={cn("gap-0.5", toneClass, className)} title={label.long} data-tone={tone}>
      <Icon className="size-3" aria-hidden="true" />
      {label.short}
    </ColorChip>
  );
}
