"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Check, Eye, FlaskConical, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { LoadingButton } from "@/components/loading-button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  GROUP_SCOPE_TERMS,
  findGroupScopeBlockedCriteria,
  groupScopeBlockedLabels,
  wholeRecordActionBlockedBy,
  type GroupScopeViolation,
} from "@/lib/conditions/group-scope";

/**
 * The rule editor's evaluation scope (Series and Music rule sets) and the gate
 * it puts on criteria and actions: a criterion that describes one episode or
 * track may never make a whole show or artist an action's target
 * (`groupScopeViolation`, `src/lib/conditions/group-scope.ts`). With "Match
 * against entire series" or "Match against entire artist" on, a rule judges a
 * whole show or artist, so such criteria are not allowed; with it off they
 * are, but not under an action that acts on the whole show or artist (Delete
 * from Sonarr, Arr tags, …). The builder disables the criteria, and the
 * action picker the actions, that would break it; a rule set that does anyway
 * — the scope just turned on, an action just switched on, an import, or one
 * saved before the rule — shows the warning below, with the valid ways out,
 * and its Save, Preview and Test Media stay off with the reason until it is
 * resolved. The server refuses the save regardless.
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

/** The switch, and while the rules break the gate, the warning. */
export function EvaluationScopeCard({
  config,
  seriesScope,
  onSeriesScopeChange,
  violation,
}: {
  config: ScopeConfig;
  seriesScope: boolean;
  onSeriesScopeChange: (on: boolean) => void;
  /** `groupScopeViolation` of the editor's state (scope and action); null when nothing is blocked. */
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
      {violation && <GroupScopeWarning violation={violation} onSetScope={onSeriesScopeChange} />}
    </div>
  );
}

/**
 * The blocked criteria and the valid ways out: remove them; switch to an
 * action that acts only on the matched episodes or tracks, with the scope off;
 * and, when it alone resolves it, a one-click "Turn off series scope" (the
 * action acts only on the matched members) or "Turn on series scope" (every
 * blocked criterion is one the whole show answers itself). Never a click that
 * leads from one violation to the other.
 */
export function GroupScopeWarning({
  violation,
  onSetScope,
}: {
  violation: GroupScopeViolation;
  onSetScope: (on: boolean) => void;
}) {
  const t = GROUP_SCOPE_TERMS[violation.type];
  const action = violation.wholeRecordAction;
  const member = violation.judgement === "member";
  const toggle = member
    ? violation.scopeOnResolves ? { on: true, label: `Turn on ${t.scope}` } : null
    : action ? null : { on: false, label: `Turn off ${t.scope}` };
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <p className="font-medium text-amber">
          {member
            ? <>Per-{t.member} criteria can&apos;t decide a whole-{t.group} action</>
            : <>Per-{t.member} criteria can&apos;t judge a whole {t.group}</>}
        </p>
        <p className="text-muted-foreground">
          {member ? (
            <>
              With {t.scope} off each {t.member} is checked on its own, but &ldquo;{action}&rdquo; acts on the whole{" "}
              {t.group}, so these criteria would let one {t.member} decide for every other. Remove them, or switch to an
              action that acts only on the matched {t.member}s ({t.memberActions})
              {violation.scopeOnResolves ? <>, or turn {t.scope} on to judge the whole {t.group}</> : null}.
            </>
          ) : action ? (
            <>
              With &ldquo;{t.toggle}&rdquo; on, the rules decide for the whole {t.group} and its action covers all of it, so
              these criteria would let one {t.member} decide for every other — and &ldquo;{action}&rdquo; acts on the whole{" "}
              {t.group} with {t.scope} off too. Remove them, or switch to an action that acts only on the matched{" "}
              {t.member}s ({t.memberActions}) and turn {t.scope} off.
            </>
          ) : (
            <>
              With &ldquo;{t.toggle}&rdquo; on, the rules decide for the whole {t.group} and its action covers all of it, so
              these criteria would let one {t.member} decide for every other. Turn {t.scope} off to check them per{" "}
              {t.member}, or remove them.
            </>
          )}{" "}
          Save, Preview and Test Media stay off until then.
        </p>
        <div className="flex flex-wrap gap-1" aria-label="Criteria not allowed here">
          {groupScopeBlockedLabels(violation).map((label) => (
            <ColorChip key={label} className="border-amber/25 bg-amber-dim text-amber">
              {label}
            </ColorChip>
          ))}
        </div>
        {toggle && (
          <Button type="button" size="sm" variant="outline" onClick={() => onSetScope(toggle.on)}>
            {toggle.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The short reason on Save, Preview and Test Media while the rules break the
 * gate.
 */
export function groupScopeBlockedReason(violation: GroupScopeViolation): string {
  const t = GROUP_SCOPE_TERMS[violation.type];
  const labels = groupScopeBlockedLabels(violation).join(", ");
  const memberAction = `pick an action that acts only on the matched ${t.member}s`;
  if (violation.judgement === "member") {
    return (
      `${labels} can't decide "${violation.wholeRecordAction}", which acts on the whole ${t.group} — remove them or ` +
      `${memberAction}${violation.scopeOnResolves ? `, or turn ${t.scope} on` : ""}.`
    );
  }
  return violation.wholeRecordAction
    ? `${labels} can't be used with "${t.toggle}" on — remove them, or turn ${t.scope} off and ${memberAction}.`
    : `${labels} can't be used with "${t.toggle}" on — turn ${t.scope} off or remove them first.`;
}

/**
 * Why the action picker offers an action type disabled: choosing it would let
 * per-episode/per-track criteria decide an action on the whole show or
 * artist (`wholeRecordActionBlockedBy`). Also the reason on the Arr tags and
 * Lidarr search-after switches, which make any action act on the whole record.
 */
export function wholeRecordActionReason(
  type: GroupScopeViolation["type"],
  what: string,
  blocked: Pick<GroupScopeViolation, "fields" | "streamQuery">,
  /** Whether turning the scope on would allow it: every blocked criterion is one the whole show or artist answers. */
  scopeOnResolves: boolean,
): string {
  const t = GROUP_SCOPE_TERMS[type];
  return (
    `"${what}" acts on the whole ${t.group}, so with ${t.scope} off it can't follow per-${t.member} criteria ` +
    `(${groupScopeBlockedLabels(blocked).join(", ")}) — remove them first${scopeOnResolves ? `, or turn ${t.scope} on` : ""}.`
  );
}

/**
 * Why turning on something that makes any action act on the whole show or
 * artist — Arr tags, Lidarr's search after a file delete (`what`) — would
 * break the gate as the rule set stands: the scope off and its rules holding
 * criteria of one episode or track. Null when it would not.
 */
export function wholeRecordSwitchReason(type: string, seriesScope: boolean, rules: unknown, what: string): string | null {
  if (type !== "SERIES" && type !== "MUSIC") return null;
  if (seriesScope) return null;
  const blocked = findGroupScopeBlockedCriteria(rules, type, "member");
  if (!blocked) return null;
  return wholeRecordActionReason(type, what, blocked, findGroupScopeBlockedCriteria(rules, type, "group") === null);
}

/**
 * The rule editor's action picker: each option disabled with its reason on
 * hover (`actionTypeOptionStates`).
 */
export function ActionTypeSelect({
  value,
  onValueChange,
  options,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: ActionTypeOptionState[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="mt-1.5" aria-label="Action type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) =>
          opt.disabledReason ? (
            <TooltipProvider key={opt.value}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <SelectItem value={opt.value} disabled title={opt.disabledReason}>
                      {opt.label}
                    </SelectItem>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs">
                  {opt.disabledReason}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/** One option of the rule editor's action picker, and why it is offered disabled. */
export interface ActionTypeOptionState {
  value: string;
  label: string;
  /** Null when it can be picked. */
  disabledReason: string | null;
}

/**
 * The action picker's options as the rule set stands: an action needing an
 * Arr instance is off until one is selected, and one that acts on the whole
 * show or artist is off while its rules hold criteria of one episode or track
 * with the scope off (`wholeRecordActionBlockedBy`), saying which.
 */
export function actionTypeOptionStates(
  type: string,
  seriesScope: boolean,
  rules: unknown,
  options: ReadonlyArray<{ value: string; label: string }>,
  arrSelected: boolean,
): ActionTypeOptionState[] {
  const scopeOnResolves = (type === "SERIES" || type === "MUSIC") && findGroupScopeBlockedCriteria(rules, type, "group") === null;
  return options.map(({ value, label }) => {
    if (value !== "DO_NOTHING" && !arrSelected) {
      return { value, label, disabledReason: "Select an Arr server above to enable this action" };
    }
    const blocked = wholeRecordActionBlockedBy(type, seriesScope, rules, value);
    return {
      value,
      label,
      disabledReason: blocked
        ? wholeRecordActionReason(type as GroupScopeViolation["type"], label, blocked, scopeOnResolves)
        : null,
    };
  });
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
 * The editor's Preview. `blockedReason` (the scope gate: the scope, the rules
 * and the action as a save would send them) disables it and says why — the
 * route refuses the same, with detection's reason; `disabled` covers every
 * other unmet requirement.
 */
export function PreviewRuleSetButton({
  blockedReason,
  disabled,
  loading,
  onPreview,
}: {
  blockedReason: string | null;
  disabled: boolean;
  loading: boolean;
  onPreview: () => void;
}) {
  return (
    <BlockedReason reason={blockedReason}>
      <LoadingButton
        onClick={onPreview}
        loading={loading}
        icon={Eye}
        disabled={!!blockedReason || disabled}
        variant="secondary"
      >
        Preview
      </LoadingButton>
    </BlockedReason>
  );
}

/** The editor's Test Media, gated as Preview is (`PreviewRuleSetButton`). */
export function TestMediaButton({
  blockedReason,
  disabled,
  onTest,
}: {
  blockedReason: string | null;
  disabled: boolean;
  onTest: () => void;
}) {
  return (
    <BlockedReason reason={blockedReason}>
      <Button onClick={onTest} disabled={!!blockedReason || disabled} variant="secondary">
        <FlaskConical className="mr-2 h-4 w-4" />
        Test Media
      </Button>
    </BlockedReason>
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
      <LoadingButton
        onClick={onSave}
        disabled={!!blockedReason || disabled}
        className={justSaved ? "bg-green text-background hover:bg-green" : ""}
        loading={loading}
        icon={justSaved ? Check : Save}
      >
        {justSaved ? "Saved" : "Save"}
      </LoadingButton>
    </BlockedReason>
  );
}
