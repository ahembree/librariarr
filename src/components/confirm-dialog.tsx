"use client";

import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /**
   * The question's detail. A string or inline content is read as the dialog's
   * description; block content (paragraphs, lists) belongs in `children`.
   */
  description?: ReactNode;
  /** The confirm button's label, e.g. "Delete". */
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Shown before the confirm label (the spinner takes its place while pending). */
  confirmIcon?: LucideIcon;
  /** A red confirm button, for an action that removes something. */
  destructive?: boolean;
  /**
   * The caller's own "running" flag: both buttons are disabled and the
   * confirm button spins while it is set.
   */
  pending?: boolean;
  /** Disables only the confirm button (an unmet requirement in `children`). */
  confirmDisabled?: boolean;
  /**
   * The action. Returning nothing closes the dialog at once. Returning a
   * promise keeps it open, spinning, until the promise settles: it closes
   * when it resolves to anything but `false`, and stays open on `false` or a
   * rejection (the caller reports why), so a failed save is not dismissed.
   */
  onConfirm: () => void | Promise<unknown>;
  /** Block content between the description and the buttons (a checkbox, a list, a field). */
  children?: ReactNode;
  size?: "default" | "sm";
}

/**
 * "Are you sure?" — an AlertDialog with a title, a description, Cancel and a
 * confirm button. The app had some thirty of these written out by hand, each
 * with its own idea of how a destructive button looks and what happens while
 * the action runs.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmIcon: ConfirmIcon,
  destructive = false,
  pending = false,
  confirmDisabled = false,
  onConfirm,
  children,
  size,
}: ConfirmDialogProps) {
  const [running, setRunning] = useState(false);
  const busy = pending || running;

  const confirm = (event: React.MouseEvent) => {
    const result = onConfirm();
    if (!(result instanceof Promise)) return;
    // Keep the dialog open until the action has answered.
    event.preventDefault();
    setRunning(true);
    result.then(
      (outcome) => {
        setRunning(false);
        if (outcome !== false) onOpenChange(false);
      },
      () => setRunning(false),
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Escape and the overlay cannot dismiss a dialog whose action is running.
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent size={size}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined && description !== null && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy || confirmDisabled}
            onClick={confirm}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : ConfirmIcon ? (
              <ConfirmIcon className="h-4 w-4" aria-hidden="true" />
            ) : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
