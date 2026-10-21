"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ReleaseNoteSections } from "@/components/release-note-sections";

interface WhatsNewNote {
  version: string;
  body: string;
  url: string;
  publishedAt: string;
}

interface WhatsNewResponse {
  show: boolean;
  currentVersion: string | null;
  notes: WhatsNewNote[];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return Number.isNaN(date.getTime())
    ? dateStr
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Sparkles className="h-5 w-5 text-primary" />
            What&apos;s new in v{data.currentVersion}
          </DialogTitle>
          <DialogDescription>
            {data.notes.length === 1
              ? "New features and fixes in this release."
              : `New features and fixes across the ${data.notes.length} releases since you last looked.`}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          {data.notes.map((note, i) => (
            <div key={note.version}>
              {i > 0 && <Separator className="my-4" />}
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm font-medium">v{note.version}</span>
                {note.publishedAt && (
                  <span className="text-xs text-muted-foreground">{formatDate(note.publishedAt)}</span>
                )}
                {note.url && (
                  <a
                    href={note.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    View on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="space-y-3">
                <ReleaseNoteSections body={note.body} />
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
