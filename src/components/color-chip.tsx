import { cn } from "@/lib/utils";

interface ColorChipProps {
  /** Inline styles for background, color, and border (from chip color utilities) */
  style?: React.CSSProperties;
  className?: string;
  title?: string;
  children: React.ReactNode;
}

/**
 * Consistent colored chip/pill used across tables, cards, and detail pages.
 * Accepts inline styles from getChipBadgeStyle(), getSolidStyle(), or custom colors.
 */
export function ColorChip({ style, className, title, children }: ColorChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium leading-none border shrink-0",
        className,
      )}
      style={style}
      title={title}
    >
      {children}
    </span>
  );
}
