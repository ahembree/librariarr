"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Settings section card matching the handoff's `card-head` pattern: a 14px
 * card with a display-font header (icon + title), optional description, an
 * optional right-aligned action, and a padded body.
 */
export function SettingsSection({
  icon: Icon,
  title,
  description,
  action,
  children,
  contentClassName,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <section className="overflow-hidden rounded-[14px] border bg-card shadow-[var(--shadow-card)]">
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-display text-[14.5px] font-semibold tracking-[-0.01em]">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
            {title}
          </h3>
          {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className={cn("p-5", contentClassName)}>{children}</div>
    </section>
  );
}

/**
 * A single settings row: title + description on the left, control on the
 * right, with a hairline between consecutive rows (the handoff's `SetRow`).
 * Use inside a `SettingsSection` with `contentClassName` cleared so rows can
 * own their own padding, or wrap a list of rows directly.
 */
export function SetRow({
  title,
  description,
  htmlFor,
  control,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
  /** The control rendered on the right (Switch, Select, small Input, Button…). */
  control?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-b border-border/60 py-4 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0 sm:max-w-[62%]">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {title}
        </Label>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{control ?? children}</div>
    </div>
  );
}
