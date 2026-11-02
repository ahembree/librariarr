"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { Logo } from "@/components/logo";
import { useShellSettings } from "@/components/shell-settings-provider";
import { ReleaseKindCountChips, ReleaseNoteSections } from "@/components/release-note-sections";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { compareSemver } from "@/lib/version/semver";
import { parseReleaseSections, type ReleaseSection } from "@/lib/version/release-notes";

const RELEASES_URL = "https://github.com/ahembree/librariarr/releases";

interface WhatsNewNote {
  version: string;
  body: string;
  url: string;
  publishedAt: string;
}

interface WhatsNewResponse {
  show: boolean;
  currentVersion: string | null;
  previousVersion: string | null;
  /** Releases since `previousVersion` lie past the page GitHub returned. */
  truncated: boolean;
  notes: WhatsNewNote[];
}

interface ParsedNote extends WhatsNewNote {
  sections: ReleaseSection[];
}

function ReleaseCard({
  note,
  isInstalled,
  defaultOpen,
}: {
  note: ParsedNote;
  isInstalled: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-lg border border-white/6 bg-background/40 shadow-[inset_0_1px_0_oklch(1_0_0/4%)]"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-300 ease-out hover:bg-white/3"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="font-mono text-sm font-semibold">v{note.version}</span>
            {isInstalled && (
              <ColorChip className="border-brand/25 bg-brand-dim text-brand-bright">Installed</ColorChip>
            )}
            {note.publishedAt && (
              <span className="text-xs text-muted-foreground">{formatDate(note.publishedAt, "")}</span>
            )}
            <span className="flex flex-wrap gap-1.5 sm:ml-auto">
              <ReleaseKindCountChips sections={note.sections} />
            </span>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 border-t border-white/6 px-4 pt-4 pb-4">
          <ReleaseNoteSections sections={note.sections} />
          {note.url && (
            <a
              href={note.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View v{note.version} on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Shown once after an upgrade: the features and fixes of every release since
 * the version whose dialog was last closed. Closing it records the version it
 * showed (`PUT /api/settings/whats-new`), so it stays closed until the next
 * upgrade. Mounted in `AuthenticatedShell`.
 */
export function WhatsNewDialog() {
  const shell = useShellSettings();
  const [data, setData] = useState<WhatsNewResponse | null>(null);
  const [open, setOpen] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const recorded = useRef(false);

  useEffect(() => {
    // The server layout already compared the running version with the last
    // one seen; when nothing is owed there is nothing to ask GitHub about.
    if (shell && !shell.getSnapshot().whatsNewDue) return;
    let cancelled = false;
    fetch("/api/settings/whats-new", { priority: "low" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: WhatsNewResponse | null) => {
        if (cancelled || !body?.show || !body.currentVersion || body.notes.length === 0) return;
        setData(body);
        setOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shell]);

  const notes = useMemo<ParsedNote[]>(
    () =>
      (data?.notes ?? []).map((note) => ({ ...note, sections: parseReleaseSections(note.body) })),
    [data],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next || !data?.currentVersion || recorded.current) return;
    recorded.current = true;
    const version = data.currentVersion;
    fetch("/api/settings/whats-new", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    })
      .then((res) => {
        // fetch resolves on an error status too; without this a refused save
        // (an expired session, a database error) left no trace while the
        // dialog came back on every load.
        if (!res.ok) {
          console.error(`Failed to record the v${version} release notes as seen: HTTP ${res.status}`);
          return;
        }
        shell?.setWhatsNewSeen();
      })
      .catch((e) => console.error(`Failed to record the v${version} release notes as seen`, e));
  };

  if (!data) return null;

  const allSections = notes.flatMap((note) => note.sections);
  const releaseCount = notes.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // Focus the dismiss button rather than the first release header, whose
        // focus ring would otherwise sit across the top of the list on open.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          dismissRef.current?.focus();
        }}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden bg-card p-0 shadow-[0_1px_3px_0_rgb(0_0_0/0.1),inset_0_1px_0_oklch(1_0_0/4%)] sm:max-w-2xl">
        <DialogHeader className="shrink-0 gap-3 border-b border-white/6 bg-[radial-gradient(ellipse_at_50%_0%,var(--brand-dim)_0%,transparent_70%)] px-6 pt-6 pb-5 text-left">
          <div className="flex items-center gap-3 pr-6">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/6 bg-background/60 shadow-[0_0_24px_var(--brand-dim)]">
              <Logo size={28} />
            </div>
            <div className="min-w-0">
              <DialogTitle className="font-display text-xl font-bold tracking-tight">
                What&apos;s new in Librariarr
              </DialogTitle>
              <DialogDescription className="mt-0.5">
                {data.previousVersion
                  ? `Updated from v${data.previousVersion} to v${data.currentVersion}.`
                  : `You're now running v${data.currentVersion}.`}
                {releaseCount > 1 &&
                  (data.truncated
                    ? ` Showing the ${releaseCount} most recent releases.`
                    : ` ${releaseCount} releases since you last looked.`)}
                {data.truncated && (
                  <>
                    {" "}
                    <a
                      href={RELEASES_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 transition-colors hover:text-foreground"
                    >
                      Older releases are on GitHub
                    </a>
                    .
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <ReleaseKindCountChips sections={allSections} />
          </div>
        </DialogHeader>

        <div className="stagger-children min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {notes.map((note, i) => (
            <ReleaseCard
              key={note.version}
              note={note}
              isInstalled={compareSemver(note.version, data.currentVersion!) === 0}
              // The newest opens, and so does any release with a breaking change.
              defaultOpen={i === 0 || note.sections.some((section) => section.kind === "breaking")}
            />
          ))}
        </div>

        <DialogFooter className="shrink-0 flex-col-reverse gap-2 border-t border-white/6 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/settings#system" onClick={() => handleOpenChange(false)}>
              All release notes
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button ref={dismissRef} onClick={() => handleOpenChange(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
