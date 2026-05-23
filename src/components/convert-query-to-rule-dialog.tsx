"use client";

import { useMemo, useState } from "react";
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
  query,
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

  const initialTypes = query.mediaTypes;
  const [targetType, setTargetType] = useState<LibraryType | "">(
    initialTypes.length === 1 ? initialTypes[0] : "",
  );
  const [name, setName] = useState(
    defaultName ? `${defaultName} (rule set)` : "",
  );
  const [useAllServers, setUseAllServers] = useState(
    query.serverIds.length === 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const incompatible: IncompatibleRule[] = useMemo(() => {
    if (!targetType) return [];
    return findIncompatibleRules(query.groups, targetType);
  }, [query.groups, targetType]);

  const effectiveServerIds =
    query.serverIds.length > 0
      ? query.serverIds
      : useAllServers
        ? availableServerIds
        : [];

  const canSubmit =
    !submitting &&
    targetType !== "" &&
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
      });
      const res = await fetch("/api/lifecycle/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setSubmitError(payload.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const payload = (await res.json()) as { ruleSet: { id: string } };
      toast.success("Lifecycle rule set created", {
        description: "Configure an action and re-evaluate to start matching.",
      });
      router.push(
        `/lifecycle/rules?ruleSet=${encodeURIComponent(payload.ruleSet.id)}#${TYPE_TAB_HASH[targetType]}`,
      );
    } catch (err) {
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
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Old unwatched movies"
            maxLength={120}
          />
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
            <Label>Target library type</Label>
            <p className="text-xs text-muted-foreground">
              Lifecycle rule sets are scoped to a single library type. Pick
              one — any rules that don&apos;t apply will be removed.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {initialTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setTargetType(type)}
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

        {targetType && incompatible.length > 0 && (
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
          </div>
        )}

        {submitError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{submitError}</p>
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
