"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bug,
  ChevronDown,
  ExternalLink,
  Sparkles,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { Logo } from "@/components/logo";
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
import { cn } from "@/lib/utils";
import {
  parseReleaseBody,
  releaseSectionKind,
  splitReleaseItemScope,
  type ReleaseSectionKind,
} from "@/lib/version/release-notes";

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
  notes: WhatsNewNote[];
}

interface ParsedSection {
  heading: string;
  kind: ReleaseSectionKind;
  items: string[];
}

interface ParsedNote extends WhatsNewNote {
  sections: ParsedSection[];
}

/** How each kind of change is drawn: its icon, chip colours and list marker. */
const SECTION_STYLE: Record<
  ReleaseSectionKind,
  { icon: LucideIcon; label: [one: string, many: string]; chip: string; iconClass: string; dot: string }
> = {
  features: {
    icon: Sparkles,
    label: ["feature", "features"],
    chip: "border-green/25 bg-green-dim text-green",
    iconClass: "text-green",
    dot: "bg-green",
  },
  fixes: {
    icon: Bug,
    label: ["fix", "fixes"],
    chip: "border-sky/25 bg-sky-dim text-sky",
    iconClass: "text-sky",
    dot: "bg-sky",
  },
  performance: {
    icon: Zap,
    label: ["performance", "performance"],
    chip: "border-amber/25 bg-amber-dim text-amber",
    iconClass: "text-amber",
    dot: "bg-amber",
  },
  other: {
    icon: Wrench,
    label: ["other change", "other changes"],
    chip: "bg-muted/40 text-muted-foreground",
    iconClass: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
};

const KIND_ORDER: ReleaseSectionKind[] = ["features", "fixes", "performance", "other"];

/** Release-please items start lowercase ("keep counts"); show them as sentences. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime())
    ? dateStr
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Item counts per kind of change, in display order, skipping kinds with none. */
function countByKind(sections: ParsedSection[]): { kind: ReleaseSectionKind; count: number }[] {
  const counts = new Map<ReleaseSectionKind, number>();
  for (const section of sections) {
    counts.set(section.kind, (counts.get(section.kind) ?? 0) + section.items.length);
  }
  return KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: counts.get(kind)!,
  }));
}

function KindCountChips({ sections }: { sections: ParsedSection[] }) {
  return (
    <>
      {countByKind(sections).map(({ kind, count }) => (
        <ColorChip key={kind} className={cn("tabular-nums", SECTION_STYLE[kind].chip)}>
          {count} {SECTION_STYLE[kind].label[count === 1 ? 0 : 1]}
        </ColorChip>
      ))}
    </>
  );
}

function ReleaseSectionList({ section }: { section: ParsedSection }) {
  const style = SECTION_STYLE[section.kind];
  const Icon = style.icon;
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", style.iconClass)} />
        {section.heading}
      </h4>
      <ul className="space-y-1.5">
        {section.items.map((item, i) => {
          const { scope, text } = splitReleaseItemScope(item);
          return (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground/85">
              <span className={cn("mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
              <span className="min-w-0">
                {scope && (
                  <ColorChip className="mr-1.5 py-px align-[1px] font-mono text-[11px]">{scope}</ColorChip>
                )}
                {sentenceCase(text)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ReleaseCard({
  note,
  isNewest,
  defaultOpen,
}: {
  note: ParsedNote;
  isNewest: boolean;
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
            {isNewest && (
              <ColorChip className="border-brand/25 bg-brand-dim text-brand-bright">Installed</ColorChip>
            )}
            {note.publishedAt && (
              <span className="text-xs text-muted-foreground">{formatDate(note.publishedAt)}</span>
            )}
            <span className="flex flex-wrap gap-1.5 sm:ml-auto">
              <KindCountChips sections={note.sections} />
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
          {note.sections.length > 0 ? (
            note.sections.map((section) => (
              <ReleaseSectionList key={section.heading} section={section} />
            ))
          ) : (
            <p className="text-sm italic text-muted-foreground">No release notes available.</p>
          )}
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
  const [data, setData] = useState<WhatsNewResponse | null>(null);
  const [open, setOpen] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
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
  }, []);

  const notes = useMemo<ParsedNote[]>(
    () =>
      (data?.notes ?? []).map((note) => ({
        ...note,
        sections: parseReleaseBody(note.body).map((section) => ({
          ...section,
          kind: releaseSectionKind(section.heading),
        })),
      })),
    [data],
  );

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next || !data?.currentVersion) return;
    fetch("/api/settings/whats-new", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: data.currentVersion }),
    }).catch((e) => console.error("Failed to record the release notes as seen", e));
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
                {releaseCount > 1 && ` ${releaseCount} releases since you last looked.`}
              </DialogDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <KindCountChips sections={allSections} />
          </div>
        </DialogHeader>

        <div className="stagger-children min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {notes.map((note, i) => (
            <ReleaseCard
              key={note.version}
              note={note}
              isNewest={i === 0}
              defaultOpen={i === 0}
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
