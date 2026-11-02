"use client";

import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface LoadingButtonProps extends ComponentProps<typeof Button> {
  /** Shows the spinner in the icon's place and disables the button. */
  loading?: boolean;
  /** The icon shown while not loading; none leaves the space empty until then. */
  icon?: LucideIcon;
  /** The icon's (and the spinner's) classes. */
  iconClassName?: string;
}

/**
 * A button whose icon turns into a spinner while its action runs, disabled
 * meanwhile — the `{busy ? <Loader2 … /> : <Icon … />}` every form wrote out
 * by hand, with the spinner and the icon sized alike so the label never moves.
 */
export function LoadingButton({
  loading = false,
  icon: Icon,
  iconClassName = "mr-2 h-4 w-4",
  disabled,
  children,
  ...props
}: LoadingButtonProps) {
  return (
    <Button disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? (
        <Loader2 className={cn(iconClassName, "animate-spin")} aria-hidden="true" />
      ) : Icon ? (
        <Icon className={iconClassName} aria-hidden="true" />
      ) : null}
      {children}
    </Button>
  );
}
