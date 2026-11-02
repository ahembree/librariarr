import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  /** Shown before the title, at the title's height. */
  icon?: LucideIcon;
  /** Beside the title: a count, a status chip. Wraps under it on a narrow screen. */
  meta?: ReactNode;
  /** The line under the title. */
  description?: ReactNode;
  /** Buttons for the page: right of the heading, below it on a phone. */
  actions?: ReactNode;
  /**
   * Keep the actions beside the heading on a phone too — for one small
   * control, like a library page's Sync button.
   */
  actionsInline?: boolean;
  className?: string;
}

/**
 * A page's heading block: the `<h1>` in the style every page uses
 * (`text-2xl sm:text-3xl font-bold font-display tracking-tight`), an optional
 * icon and meta beside it, a description under it, and the page's actions,
 * which wrap rather than push the page sideways at 320px.
 */
export function PageHeader({
  title,
  icon: Icon,
  meta,
  description,
  actions,
  actionsInline = false,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex gap-3",
        actionsInline
          ? "items-start justify-between"
          : "flex-col sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight flex items-center gap-2">
            {Icon && <Icon className="h-7 w-7 shrink-0" aria-hidden="true" />}
            {title}
          </h1>
          {meta}
        </div>
        {description && <p className="text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:gap-3">{actions}</div>}
    </div>
  );
}
