import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A failure message in a form or a card — the red box with an alert icon that
 * the login, onboarding and settings forms each wrote out. `multiline` aligns
 * the icon with the first line of a message that wraps.
 */
export function InlineError({
  children,
  multiline = false,
  className,
}: {
  children: ReactNode;
  multiline?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive",
        multiline ? "items-start" : "items-center",
        className,
      )}
    >
      <AlertCircle className={cn("h-4 w-4 shrink-0", multiline && "mt-0.5")} aria-hidden="true" />
      {multiline ? <span>{children}</span> : children}
    </div>
  );
}
