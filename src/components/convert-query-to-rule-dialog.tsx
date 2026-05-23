"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Info } from "lucide-react";
import type { LibraryType } from "@/lib/conditions";
import type { QueryDefinition } from "@/lib/query/types";
import {
  countAllRulesIncludingDisabled,
  dropIncompatibleRules,
  findIncompatibleRules,
  type IncompatibleRule,
} from "@/components/builder/library-type-validity";
import {
  ConvertQueryError,
  arrInstanceIdForType,
  convertQueryToRuleSetBody,
} from "@/lib/query/convert-to-rule";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: QueryDefinition;
  availableServerIds: string[];
  defaultName?: string;
}

const TYPE_LABEL: Record<LibraryType, string> = {
  MOVIE: "Movies",
  SERIES: "Series",
  MUSIC: "Music",
};

const TYPE_TAB_HASH: Record<LibraryType, string> = {
  MOVIE: "movies",
  SERIES: "series",
  MUSIC: "music",
};

export function ConvertQueryToRuleDialog({
  open,
  onOpenChange,
  query,
  availableServerIds,
  defaultName,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <ConvertDialogBody
          query={query}
          availableServerIds={availableServerIds}
          defaultName={defaultName}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

function ConvertDialogBody({
  query: liveQuery,
  availableServerIds,
  defaultName,
  onClose,
}: {
  query: QueryDefinition;
  availableServerIds: string[];
  defaultName?: string;
  onClose: () => void;
}) {
  const router = useRouter();

  // Snapshot the query at dialog-open time. The parent page rebuilds the
  // `query` prop on every render, so without snapshotting, any edit to the
  // underlying builder (rules, mediaTypes, servers) while the dialog is open
  // would leak into the submitted body. The conditional mount in the parent
  // (`{open && <ConvertDialogBody ...>}`) guarantees this initializer runs
  // exactly once per open.
  //
  // `availableServerIds` is intentionally NOT snapshotted — the user can't
  // mutate the server list while the dialog is open, but the list itself
  // may finish loading after the dialog opens. Snapshotting would lock out
  // late-loaders.
  const [query] = useState(liveQuery);

  const initialTypes = query.mediaTypes;
  const [targetType, setTargetType] = useState<LibraryType | "">(
    initialTypes.length === 1 ? initialTypes[0] : "",
  );
  const [name, setName] = useState(
    defaultName ? `${defaultName} (rule set)` : "",
  );
  // True while a reconcile fetch is in flight. Reset whenever targetType
  // changes so the hint shows once per reconcile, including subsequent
  // type changes. The initial value mirrors whether the first reconcile
  // will run — false when there's no targetType (multi-type queries
  // waiting for the user to pick), true otherwise.
  const [reconcilingName, setReconcilingName] = useState(
    initialTypes.length === 1,
  );
  const userEditedNameRef = useRef(false);
  const [useAllServers, setUseAllServers] = useState(
    query.serverIds.length === 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancel any in-flight POST so the rule set isn't silently created
      // server-side after the user dismissed the dialog.
      abortControllerRef.current?.abort();
    };
  }, []);

  // Reconcile the default name with existing rule sets so a second
  // conversion of the same saved query doesn't immediately 409. Only
  // adjusts when the user hasn't manually edited the name yet. The
  // setState-in-effect lint rule's escape hatch fits here — this is a
  // legitimate URL/network → state bridge with no user interaction to
  // hang off of, guarded by `cancelled` for unmount safety.
  useEffect(() => {
    if (!targetType) return;
    // Same escape hatch as the lifecycle hydration effect: this is a
    // legitimate URL/network → state bridge with no user interaction to
    // hang off of, and the deps drive when it should fire.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReconcilingName(true);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/lifecycle/rules");
        if (!res.ok) throw new Error("fetch failed");
        const data = (await res.json()) as { ruleSets: Array<{ name: string; type: string }> };
        if (cancelled || !mountedRef.current || userEditedNameRef.current) return;
        const existing = new Set(
          data.ruleSets.filter((rs) => rs.type === targetType).map((rs) => rs.name),
        );
        setName((current) => {
          if (!existing.has(current)) return current;
          // 10k iterations is a defensive upper bound — practically the
          // user will never have that many collisions. Picks the first
          // free numeric suffix.
          for (let i = 2; i < 10_000; i++) {
            const candidate = `${current} (${i})`;
            if (!existing.has(candidate)) return candidate;
          }
          return current;
        });
      } catch {
        // Best-effort — fall back to the 409 path if reconcile fails.
      } finally {
        if (!cancelled && mountedRef.current) {
          setReconcilingName(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetType]);

  const incompatible: IncompatibleRule[] = useMemo(() => {
    if (!targetType) return [];
    return findIncompatibleRules(query.groups, targetType);
  }, [query.groups, targetType]);

  // Pre-compute the pruned tree once per target-type change, then share it
  // between the up-front "would this be useless?" gate and the submit
  // handler. Avoids a duplicate tree walk on submit.
  const cleanedGroups = useMemo(() => {
    if (!targetType) return null;
    return dropIncompatibleRules(query.groups, targetType);
  }, [query.groups, targetType]);

  // Detect a conversion that would produce a rule set with zero effective
  // rules — either pruning would strip everything, or only placeholder
  // groups remain after pruning. Blocking up-front beats surfacing a
  // post-submit `ALL_RULES_INCOMPATIBLE` error.
  const wouldHaveNoRules = useMemo(() => {
    if (!cleanedGroups) return false;
    return (
      cleanedGroups.length === 0 ||
      countAllRulesIncludingDisabled(cleanedGroups) === 0
    );
  }, [cleanedGroups]);

  const effectiveServerIds =
    query.serverIds.length > 0
      ? query.serverIds
      : useAllServers
        ? availableServerIds
        : [];

  const canSubmit =
    !submitting &&
    targetType !== "" &&
    !wouldHaveNoRules &&
    name.trim().length > 0 &&
    effectiveServerIds.length > 0;

  async function handleSubmit() {
    if (!canSubmit || !targetType) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const body = convertQueryToRuleSetBody(query, {
        name,
        targetLibraryType: targetType,
        serverIds: effectiveServerIds,
        ...(cleanedGroups ? { cleanedGroups } : {}),
      });
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const res = await fetch("/api/lifecycle/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          details?: unknown;
        };
        if (!mountedRef.current) return;
        const top =
          typeof payload.error === "string"
            ? payload.error
            : `Request failed (${res.status})`;
        const detailLines = Array.isArray(payload.details)
          ? (payload.details as Array<{ path?: unknown; message?: unknown }>)
              .map((d) => {
                const pathStr = typeof d.path === "string" ? d.path : "";
                const msgStr = typeof d.message === "string" ? d.message : "";
                if (!msgStr) return null;
                return pathStr ? `${pathStr}: ${msgStr}` : msgStr;
              })
              .filter((line): line is string => !!line)
          : [];
        setSubmitError([top, ...detailLines].join("\n"));
        setSubmitting(false);
        return;
      }
      const payload = (await res.json()) as { ruleSet: { id: string } };
      if (!mountedRef.current) return;
      // Reset submitting BEFORE navigation so the dialog isn't wedged in
      // "Creating..." state if the route push is intercepted / fails to
      // unmount us for any reason.
      setSubmitting(false);
      toast.success("Lifecycle rule set created", {
        description: "Configure an action and re-evaluate to start matching.",
      });
      router.push(
        `/lifecycle/rules?ruleSet=${encodeURIComponent(payload.ruleSet.id)}#${TYPE_TAB_HASH[targetType]}`,
      );
    } catch (err) {
      if (!mountedRef.current) return;
      // AbortError fires when the dialog was unmounted mid-flight — mountedRef
      // already covers this, but be defensive: a slow abort can race and
      // reach here. Either way, don't surface it as an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof ConvertQueryError) {
        setSubmitError(err.message);
      } else {
        setSubmitError(err instanceof Error ? err.message : "Unexpected error");
      }
      setSubmitting(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Convert Query to Lifecycle Rule</DialogTitle>
        <DialogDescription>
          Creates a new lifecycle rule set from this query. The rule set is
          created with no action configured — choose an action after.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        <div className="space-y-2">
          <Label htmlFor="convert-name">Rule set name</Label>
          <Input
            id="convert-name"
            value={name}
            onChange={(e) => {
              userEditedNameRef.current = true;
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="e.g. Old unwatched movies"
            maxLength={120}
          />
          {reconcilingName && (
            <p className="text-xs text-muted-foreground">Checking name…</p>
          )}
        </div>

        {initialTypes.length === 0 && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This query has no media types selected. Pick at least one media
              type in the query first.
            </p>
          </div>
        )}

        {initialTypes.length > 1 && (
          <div className="space-y-2">
            <Label id="convert-target-type-label">Target library type</Label>
            <p className="text-xs text-muted-foreground">
              Lifecycle rule sets are scoped to a single library type. Pick
              one — any rules that don&apos;t apply will be removed.
            </p>
            <div
              className="flex flex-wrap gap-1.5"
              role="radiogroup"
              aria-labelledby="convert-target-type-label"
            >
              {initialTypes.map((type, idx) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={targetType === type}
                  // Per ARIA radiogroup pattern: only the focused/selected
                  // radio is in the Tab sequence; arrow keys move within.
                  tabIndex={
                    targetType === type ||
                    (targetType === "" && idx === 0)
                      ? 0
                      : -1
                  }
                  onClick={() => {
                    setTargetType(type);
                    setSubmitError(null);
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key !== "ArrowRight" &&
                      e.key !== "ArrowLeft" &&
                      e.key !== "ArrowDown" &&
                      e.key !== "ArrowUp"
                    ) {
                      return;
                    }
                    e.preventDefault();
                    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
                    const nextIdx =
                      (idx + (forward ? 1 : -1) + initialTypes.length) %
                      initialTypes.length;
                    const nextType = initialTypes[nextIdx];
                    setTargetType(nextType);
                    setSubmitError(null);
                    // Move DOM focus so screen readers announce the new value.
                    const root = (e.currentTarget as HTMLButtonElement).parentElement;
                    const next = root?.querySelectorAll<HTMLButtonElement>("[role=radio]")[nextIdx];
                    next?.focus();
                  }}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    targetType === type
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                  }`}
                >
                  {TYPE_LABEL[type]}
                </button>
              ))}
            </div>
          </div>
        )}

        {initialTypes.length === 1 && targetType && (
          <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Target library type:{" "}
              <span className="font-medium text-foreground">
                {TYPE_LABEL[targetType]}
              </span>
            </p>
          </div>
        )}

        {targetType && wouldHaveNoRules && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              No rules in this query apply to {TYPE_LABEL[targetType]}. Pick a
              different target type, or update the query to include rules
              compatible with {TYPE_LABEL[targetType]}.
            </p>
          </div>
        )}

        {targetType && !wouldHaveNoRules && incompatible.length > 0 && (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p>
                {incompatible.length}{" "}
                {incompatible.length === 1 ? "rule" : "rules"} will be removed
                because they don&apos;t apply to {TYPE_LABEL[targetType]}:
              </p>
            </div>
            <ul className="ml-6 list-disc space-y-0.5 text-muted-foreground">
              {incompatible.map((r) => (
                <li key={r.ruleId}>{r.fieldLabel}</li>
              ))}
            </ul>
          </div>
        )}

        {query.serverIds.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Will apply to {query.serverIds.length}{" "}
            {query.serverIds.length === 1 ? "server" : "servers"} selected in
            the query.
          </div>
        )}

        {targetType && arrInstanceIdForType(targetType, query.arrServerIds) && (
          <div className="text-xs text-muted-foreground">
            Linked Arr instance from the query will carry over. You can change
            it on the rule set editor.
          </div>
        )}

        {query.serverIds.length === 0 && (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p>
                Lifecycle rule sets require at least one server. The query has
                no servers selected.
              </p>
            </div>
            {availableServerIds.length === 0 ? (
              <p className="pl-6 text-xs text-muted-foreground">
                Waiting for servers to load…
              </p>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 pl-6 text-sm">
                <input
                  type="checkbox"
                  checked={useAllServers}
                  onChange={(e) => setUseAllServers(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>
                  Apply the rule set to all my servers (
                  {availableServerIds.length})
                </span>
              </label>
            )}
          </div>
        )}

        {submitError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <pre className="whitespace-pre-wrap font-sans">{submitError}</pre>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? "Creating..." : "Create Rule Set"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
