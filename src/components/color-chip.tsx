import { cn } from "@/lib/utils";

interface ColorChipProps {
  /** Inline styles for background, color, and border (from chip color utilities) */
  style?: React.CSSProperties;
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}

/**
 * Consistent colored chip/pill used across tables, cards, and detail pages.
 * Accepts inline styles from getChipBadgeStyle(), getSolidStyle(), or custom colors.
 * When onClick is provided, renders as a button for accessibility.
 */
export function ColorChip({ style, className, title, onClick, children }: ColorChipProps) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium leading-none border shrink-0",
        onClick && "cursor-pointer",
        className,
      )}
      style={style}
      title={title}
      onClick={onClick}
    >
      {children}
    </Tag>
  );
}
