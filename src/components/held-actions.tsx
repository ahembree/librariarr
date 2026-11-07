"use client";

import type { ReactNode } from "react";
import { CirclePause, Play } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { LoadingButton } from "@/components/loading-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The Pending page's controls for a rule set whose actions are held
 * (`src/lib/lifecycle/held-actions.ts`: edited since its matches were
 * detected, or judging whole shows/artists on per-episode/per-track
 * criteria): the Held chip, and Execute, Execute All and Retry, disabled with
 * the hold's reason (`holdReasonOf`) while it lasts. The server refuses them
 * anyway (409); these say so before the click. They render inside the page's
 * `TooltipProvider`.
 */

/**
 * The hold's reason on hover and keyboard focus, around a chip or a disabled
 * button — which takes no pointer events, so the tooltip hangs on a focusable
 * span around it. Without a hold it renders its child as it is.
 */
export function HeldReason({ reason, children }: { reason: string | null | undefined; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}

/** "Held", on a held rule set's group header and on each of its held rows, with the reason on hover. */
export function HeldChip({ reason }: { reason: string }) {
  return (
    <HeldReason reason={reason}>
      <ColorChip className="gap-1 border-sky/25 bg-sky-dim text-sky">
        <CirclePause className="h-3 w-3" aria-hidden="true" />
        Held
      </ColorChip>
    </HeldReason>
  );
}

/** A pending row's Execute, disabled with the reason while its rule set is held (`heldReason`). */
export function ExecuteNowButton({
  heldReason,
  executing,
  disabled = false,
  onExecute,
}: {
  heldReason: string | null;
  executing: boolean;
  /** Disabled for another reason (the item is gone). */
  disabled?: boolean;
  onExecute: () => void;
}) {
  return (
    <HeldReason reason={heldReason}>
      <LoadingButton
        variant="ghost"
        size="icon"
        onClick={onExecute}
        disabled={!!heldReason || disabled}
        loading={executing}
        icon={Play}
        iconClassName="h-4 w-4"
        // The tooltip says why while held; a native title would stack on it.
        title={heldReason ? undefined : "Execute now"}
        aria-label="Execute now"
      />
    </HeldReason>
  );
}

/** A failed row's force-retry, disabled with the reason while its rule set is held (`heldReason`). */
export function RetryActionButton({
  heldReason,
  retrying,
  onRetry,
}: {
  heldReason: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <HeldReason reason={heldReason}>
      <LoadingButton
        variant="ghost"
        size="icon"
        onClick={onRetry}
        disabled={!!heldReason}
        loading={retrying}
        icon={Play}
        iconClassName="h-4 w-4 text-amber"
        title={heldReason ? undefined : "Force retry"}
        aria-label="Force retry"
      />
    </HeldReason>
  );
}

/**
 * A group's Execute All. With held actions (`held` > 0 — on a held rule set,
 * every one) it runs nothing: disabled, saying how many it skips and until
 * when (`heldLabel`, `heldCountLabel`), with the reason on hover.
 */
export function ExecuteAllButton({
  held,
  heldReason,
  heldLabel,
  executing,
  onExecuteAll,
}: {
  held: number;
  heldReason: string | null;
  heldLabel: string;
  executing: boolean;
  onExecuteAll: () => void;
}) {
  if (held > 0 && heldReason) {
    return (
      <>
        <span className="text-xs text-sky">{heldLabel}</span>
        <HeldReason reason={heldReason}>
          <LoadingButton size="sm" variant="default" disabled icon={Play} iconClassName="h-4 w-4 mr-1">
            Execute All
          </LoadingButton>
        </HeldReason>
      </>
    );
  }
  return (
    <LoadingButton
      size="sm"
      variant="default"
      onClick={onExecuteAll}
      loading={executing}
      icon={Play}
      iconClassName="h-4 w-4 mr-1"
    >
      {executing ? "Executing..." : "Execute All"}
    </LoadingButton>
  );
}
