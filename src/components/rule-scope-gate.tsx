"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Check, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  GROUP_SCOPE_TERMS,
  groupScopeBlockedLabels,
  type GroupScopeViolation,
} from "@/lib/conditions/group-scope";

/**
 * The rule editor's evaluation scope (Series and Music rule sets) and the gate
 * it puts on criteria: with "Match against entire series" or "Match against
 * entire artist" on, a rule judges a whole show or artist, so criteria that
 * describe one episode or track are not allowed (`groupScopeViolation`,
 * `src/lib/conditions/group-scope.ts`). The builder disables them while the
 * scope is on; a rule set that holds them anyway — the scope just turned on,
 * an import, or one saved before the rule — shows the warning below, with a
 * one-click way out, and its Save, Preview and Test Media stay off with the
 * reason until it is resolved. The server refuses the save regardless.
 */

/** The labels and descriptions of a library type's scope switch. */
export interface ScopeConfig {
  id: string;
  label: string;
  enabledDescription: string;
  disabledDescription: string;
  ruleSetEnabledLabel: string;
  ruleSetDisabledLabel: string;
}

/** The switch, and while the scope is on and the rules break it, the warning. */
export function EvaluationScopeCard({
  config,
  seriesScope,
  onSeriesScopeChange,
  violation,
}: {
  config: ScopeConfig;
  seriesScope: boolean;
  onSeriesScopeChange: (on: boolean) => void;
  /** `groupScopeViolation` of the editor's state; null when nothing is blocked. */
  violation: GroupScopeViolation | null;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <Switch id={config.id} checked={seriesScope} onCheckedChange={onSeriesScopeChange} />
        <div>
          <Label htmlFor={config.id} className="font-medium">
            {config.label}
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {seriesScope ? config.enabledDescription : config.disabledDescription}
          </p>
        </div>
      </div>
      {violation && (
        <GroupScopeWarning violation={violation} onTurnOffScope={() => onSeriesScopeChange(false)} />
      )}
    </div>
  );
}

/** The blocked criteria, and "Turn off series scope" / "Turn off artist scope". */
export function GroupScopeWarning({
  violation,
  onTurnOffScope,
}: {
  violation: GroupScopeViolation;
  onTurnOffScope: () => void;
}) {
  const t = GROUP_SCOPE_TERMS[violation.type];
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <p className="font-medium text-amber">
          Per-{t.member} criteria can&apos;t judge a whole {t.group}
        </p>
        <p className="text-muted-foreground">
          With &ldquo;{t.toggle}&rdquo; on, the rules decide for the whole {t.group} and its action covers all of it, so these
          criteria would let one {t.member} decide for every other. Turn {t.scope} off to check them per {t.member}, or
          remove them. Save, Preview and Test Media stay off until then.
        </p>
        <div className="flex flex-wrap gap-1" aria-label="Criteria not allowed with this scope">
          {groupScopeBlockedLabels(violation).map((label) => (
            <ColorChip key={label} className="border-amber/25 bg-amber-dim text-amber">
              {label}
            </ColorChip>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onTurnOffScope}>
          Turn off {t.scope}
        </Button>
      </div>
    </div>
  );
}

/**
 * The short reason on Save, Preview and Test Media while the rules break the
 * scope, and on the builder's disabled options.
 */
export function groupScopeBlockedReason(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  return `${groupScopeBlockedLabels(violation).join(", ")} can't be used with "${t.toggle}" on — turn ${t.scope} off or remove them first.`;
}

/**
 * A control's reason on hover and keyboard focus while `reason` is set: a
 * disabled button takes no pointer events, so the tooltip hangs on a focusable
 * span around it. Without a reason it renders its child as it is.
 */
export function BlockedReason({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={0}>
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The editor's Save. `blockedReason` (the scope gate) disables it and says why;
 * `disabled` covers every other unmet requirement, each of which the editor
 * explains where it is set.
 */
export function SaveRuleSetButton({
  blockedReason,
  disabled,
  loading,
  justSaved,
  onSave,
}: {
  blockedReason: string | null;
  disabled: boolean;
  loading: boolean;
  justSaved: boolean;
  onSave: () => void;
}) {
  return (
    <BlockedReason reason={blockedReason}>
      <Button
        onClick={onSave}
        disabled={!!blockedReason || disabled}
        className={justSaved ? "bg-green hover:bg-green text-white" : ""}
      >
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : justSaved ? (
          <Check className="mr-2 h-4 w-4" />
        ) : (
          <Save className="mr-2 h-4 w-4" />
        )}
        {justSaved ? "Saved" : "Save"}
      </Button>
    </BlockedReason>
  );
}
