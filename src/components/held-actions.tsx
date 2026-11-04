"use client";

import type { ReactNode } from "react";
import { CirclePause, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { LoadingButton } from "@/components/loading-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { heldActionsReason, heldCountLabel } from "@/lib/lifecycle/held-actions";

/**
 * The Pending page's controls for a rule set whose actions are held
 * (`RuleSet.actionsHeldSince`, `src/lib/lifecycle/held-actions.ts`): the Held
 * chip, and Execute, Execute All and Retry, disabled with the hold's reason
 * while it lasts. The server refuses them anyway (409); these say so before
 * the click. They render inside the page's `TooltipProvider`.
 */

/**
 * The hold's reason on hover and keyboard focus, around a chip or a disabled
 * button — which takes no pointer events, so the tooltip hangs on a focusable
 * span around it. Without a hold it renders its child as it is.
 */
export function HeldReason({ since, children }: { since: string | null | undefined; children: ReactNode }) {
  if (!since) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{heldActionsReason(since)}</TooltipContent>
    </Tooltip>
  );
}

/** "Held", on a held rule set's group header and on each of its held rows, with the reason on hover. */
export function HeldChip({ since }: { since: string }) {
  return (
    <HeldReason since={since}>
      <ColorChip className="gap-1 border-sky/25 bg-sky-dim text-sky">
        <CirclePause className="h-3 w-3" aria-hidden="true" />
        Held
      </ColorChip>
    </HeldReason>
  );
}

/** A pending row's Execute, disabled with the reason while its rule set is held (`heldSince`). */
export function ExecuteNowButton({
  heldSince,
  executing,
  disabled = false,
  onExecute,
}: {
  heldSince: string | null;
  executing: boolean;
  /** Disabled for another reason (the item is gone). */
  disabled?: boolean;
  onExecute: () => void;
}) {
  return (
    <HeldReason since={heldSince}>
      <Button
        variant="ghost"
        size="icon"
        onClick={onExecute}
        disabled={!!heldSince || executing || disabled}
        // The tooltip says why while held; a native title would stack on it.
        title={heldSince ? undefined : "Execute now"}
        aria-label="Execute now"
      >
        {executing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
      </Button>
    </HeldReason>
  );
}

/** A failed row's force-retry, disabled with the reason while its rule set is held (`heldSince`). */
export function RetryActionButton({
  heldSince,
  retrying,
  onRetry,
}: {
  heldSince: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <HeldReason since={heldSince}>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRetry}
        disabled={!!heldSince || retrying}
        title={heldSince ? undefined : "Force retry"}
        aria-label="Force retry"
      >
        {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 text-yellow-500" />}
      </Button>
    </HeldReason>
  );
}

/**
 * A group's Execute All. With held actions (`held` > 0 — on a held rule set,
 * every one) it runs nothing: disabled, saying how many it skips, with the
 * reason on hover.
 */
export function ExecuteAllButton({
  held,
  heldSince,
  executing,
  onExecuteAll,
}: {
  held: number;
  heldSince: string | null;
  executing: boolean;
  onExecuteAll: () => void;
}) {
  if (held > 0 && heldSince) {
    return (
      <>
        <span className="text-xs text-sky">{heldCountLabel(held)}</span>
        <HeldReason since={heldSince}>
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
