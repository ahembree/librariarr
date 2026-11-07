"use client";

import { useCallback, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ActionFailure, ActionRunDetails, NotActedOn } from "@/lib/lifecycle/action-report";

/**
 * What a manual run of actions did, as the Query page and the Pending page
 * report it: the counts, every item it failed on with the reason, and the
 * episodes or tracks of actions that ran but were left alone.
 */
export interface ActionResultReport {
  executed: number;
  failed: number;
  /** Selected items the run left out (no longer matching, another media type). */
  skipped?: number;
  failures: ActionFailure[];
  notActedOn: NotActedOn[];
  /** Every not-acted-on member; `notActedOn` lists at most a bounded number of them. */
  notActedOnCount: number;
  /** What the members are called: "episode" for shows, "track" for artists. */
  memberNoun?: string;
  /** Said first in the dialog, e.g. why the run stopped part-way. */
  note?: string;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "3 executed, 1 failed, 4 episodes not acted on, 2 skipped". */
export function summarizeActionResult(report: ActionResultReport): string {
  const parts = [`${report.executed} executed`];
  if (report.failed > 0) parts.push(`${report.failed} failed`);
  if (report.notActedOnCount > 0) parts.push(`${plural(report.notActedOnCount, report.memberNoun ?? "item")} not acted on`);
  if ((report.skipped ?? 0) > 0) parts.push(`${report.skipped} skipped`);
  return parts.join(", ");
}

/** Whether the report has anything to list: a failed item, or a member left alone. */
export function hasActionResultDetails(report: ActionResultReport): boolean {
  return report.failures.length > 0 || report.notActedOnCount > 0;
}

/** An empty report to add batches into. */
export function emptyActionResult(memberNoun?: string): ActionResultReport {
  return { executed: 0, failed: 0, skipped: 0, failures: [], notActedOn: [], notActedOnCount: 0, memberNoun };
}

/** `into` with one response's counts and details added. */
export function addActionResult(into: ActionResultReport, part: Partial<ActionRunDetails>): ActionResultReport {
  return {
    ...into,
    executed: into.executed + (part.executed ?? 0),
    failed: into.failed + (part.failed ?? 0),
    skipped: (into.skipped ?? 0) + (part.skipped ?? 0),
    failures: [...into.failures, ...(part.failures ?? [])],
    notActedOn: [...into.notActedOn, ...(part.notActedOn ?? [])],
    notActedOnCount: into.notActedOnCount + (part.notActedOnCount ?? part.notActedOn?.length ?? 0),
  };
}

/**
 * Whether the run went other than cleanly: an item failed, or an action that
 * ran left an episode or track alone — judged from the counts, so a failure
 * the response did not list still keeps the toast from going green.
 */
export function actionResultHasProblems(report: ActionResultReport): boolean {
  return report.failed > 0 || report.notActedOnCount > 0;
}

/**
 * The run's result as a toast: success only when nothing failed, nothing was
 * left alone and the run was not stopped; otherwise a warning (an error when
 * nothing ran). When there are reasons to list, its text — and its View
 * Details button — open the dialog with each one.
 *
 * `stopped`: why the run stopped before the rest — one toast says it, with
 * what ran (never a second toast beside a "complete" one).
 */
export function toastActionResult(
  report: ActionResultReport,
  showDetails: (report: ActionResultReport) => void,
  opts: { title?: string; suffix?: string; stopped?: string } = {},
): void {
  const summary = `${summarizeActionResult(report)}${opts.suffix ?? ""}${opts.stopped ? ` — ${opts.stopped}` : ""}`;
  const withNote = opts.stopped ? { ...report, note: opts.stopped } : report;
  if (!actionResultHasProblems(report) && !opts.stopped) {
    toast.success(opts.title ?? "Action complete", { description: summary });
    return;
  }
  const nothingRan = report.executed === 0;
  const title =
    opts.title ??
    (opts.stopped ? "Action stopped part-way" : nothingRan ? "Action failed" : "Action completed with problems");
  const show = nothingRan && !opts.stopped ? toast.error : toast.warning;
  if (!hasActionResultDetails(report)) {
    show(title, { description: summary, duration: 20_000 });
    return;
  }
  const description: ReactNode = (
    <button
      type="button"
      className="text-left hover:underline focus-visible:underline focus-visible:outline-none"
      onClick={() => showDetails(withNote)}
    >
      {summary} — click for details
    </button>
  );
  show(title, {
    description,
    duration: 20_000,
    action: { label: "View Details", onClick: () => showDetails(withNote) },
  });
}

/** The dialog and the function that opens it with a report. */
export function useActionResultDialog(): { showDetails: (report: ActionResultReport) => void; dialog: ReactNode } {
  const [report, setReport] = useState<ActionResultReport | null>(null);
  const showDetails = useCallback((next: ActionResultReport) => setReport(next), []);
  const dialog = <ActionResultDialog report={report} onOpenChange={(open) => !open && setReport(null)} />;
  return { showDetails, dialog };
}

/** Every failed item with its reason, then every episode or track left alone with its reason. */
export function ActionResultDialog({
  report,
  onOpenChange,
}: {
  report: ActionResultReport | null;
  onOpenChange: (open: boolean) => void;
}) {
  const noun = report?.memberNoun ?? "item";
  const unlisted = report ? report.notActedOnCount - report.notActedOn.length : 0;
  return (
    <Dialog open={report !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Action Results</DialogTitle>
          <DialogDescription>{report ? summarizeActionResult(report) : ""}</DialogDescription>
        </DialogHeader>
        {report && (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            {report.note && <p className="text-sm text-muted-foreground">{report.note}</p>}
            {report.failures.length > 0 && (
              <section className="space-y-2">
                <h3 className="eyebrow flex items-center gap-1.5 text-red">
                  <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Failed ({report.failures.length})
                </h3>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {report.failures.map((f, i) => (
                    <li key={`${f.title}-${i}`} className="space-y-0.5 px-3 py-2">
                      <p className="text-sm font-medium break-words">{f.title}</p>
                      <p className="text-sm text-muted-foreground break-words">{f.error}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {report.notActedOnCount > 0 && (
              <section className="space-y-2">
                <h3 className="eyebrow flex items-center gap-1.5 text-amber">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  {capitalize(report.notActedOnCount === 1 ? noun : `${noun}s`)} Not Acted On ({report.notActedOnCount})
                </h3>
                <p className="text-xs text-muted-foreground">
                  Their action ran, but left these alone — nothing was changed for them.
                </p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {report.notActedOn.map((n, i) => (
                    <li key={`${n.title}-${i}`} className="space-y-0.5 px-3 py-2">
                      <p className="text-sm font-medium break-words">{n.title}</p>
                      <p className="text-sm text-muted-foreground break-words">{n.reason}</p>
                    </li>
                  ))}
                </ul>
                {unlisted > 0 && (
                  <p className="text-xs text-muted-foreground">
                    …and {unlisted} more {unlisted === 1 ? noun : `${noun}s`} not listed (see System Logs).
                  </p>
                )}
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
