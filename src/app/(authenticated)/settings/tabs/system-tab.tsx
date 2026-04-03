"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react";
import type { SystemInfo, ImageCacheStats, ReleaseNote } from "../types";

export interface SystemTabProps {
  systemInfo: SystemInfo | null;
  imageCacheStats: ImageCacheStats | null;
  clearingImageCache: boolean;
  onClearImageCache: () => void;
  releaseNotes: ReleaseNote[];
  loadingChangelog: boolean;
}

/**
 * Parse a GitHub release body (markdown) into grouped sections.
 * Returns sections like "Features", "Bug Fixes", etc. with their items.
 */
function parseReleaseBody(body: string): { heading: string; items: string[] }[] {
  const lines = body.split("\n");
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Section heading (## or ###)
    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      current = { heading: headingMatch[1], items: [] };
      sections.push(current);
      continue;
    }

    // List item
    if ((trimmed.startsWith("* ") || trimmed.startsWith("- ")) && current) {
      current.items.push(trimmed.slice(2));
    }
  }

  return sections.filter((s) => s.items.length > 0);
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function ReleaseNoteCard({ note }: { note: ReleaseNote }) {
  const [open, setOpen] = useState(note.isLatest && !note.isCurrent);
  const sections = parseReleaseBody(note.body);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <button className="w-full text-left">
            <CardContent className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <span className="font-medium font-mono text-sm">
                  v{note.version}
                </span>
                <div className="flex items-center gap-1.5">
                  {note.isCurrent && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      Current
                    </Badge>
                  )}
                  {note.isLatest && !note.isCurrent && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/20 text-[10px] px-1.5 py-0">
                      Latest
                    </Badge>
                  )}
                </div>
                {note.publishedAt && (
                  <span className="text-xs text-muted-foreground">
                    {formatDate(note.publishedAt)}
                  </span>
                )}
              </div>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              />
            </CardContent>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border px-6 pb-4 pt-3">
            {sections.length > 0 ? (
              <div className="space-y-3">
                {sections.map((section) => (
                  <div key={section.heading}>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      {section.heading}
                    </h4>
                    <ul className="space-y-1">
                      {section.items.map((item, i) => (
                        <li
                          key={i}
                          className="text-sm text-foreground/80 flex gap-2"
                        >
                          <span className="text-muted-foreground mt-1 shrink-0">
                            &bull;
                          </span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                No release notes available.
              </p>
            )}
            {note.url && (
              <a
                href={note.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                View on GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function SystemTab({
  systemInfo,
  imageCacheStats,
  clearingImageCache,
  onClearImageCache,
  releaseNotes,
  loadingChangelog,
}: SystemTabProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">System Information</h2>
      <Card>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Application Version</p>
              <p className="font-medium">{systemInfo?.appVersion ?? "..."}</p>
              {systemInfo?.updateInfo?.updateAvailable && systemInfo.updateInfo.latestVersion && (
                <a
                  href={systemInfo.updateInfo.releaseUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                >
                  <ArrowUpCircle className="h-3 w-3" />
                  v{systemInfo.updateInfo.latestVersion} available
                </a>
              )}
              {systemInfo?.updateInfo && !systemInfo.updateInfo.updateAvailable && systemInfo.updateInfo.latestVersion && (
                <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3" />
                  Up to date
                </p>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Database Migration</p>
              <p className="font-medium font-mono text-sm">{systemInfo?.latestMigration ?? "..."}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Database Size</p>
              <p className="font-medium">{systemInfo?.databaseSize ?? "..."}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Media Items</p>
              <p className="font-medium">{systemInfo?.stats.mediaItems.toLocaleString() ?? "..."}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Libraries</p>
              <p className="font-medium">
                {systemInfo
                  ? `${systemInfo.stats.enabledLibraries} enabled / ${systemInfo.stats.totalLibraries} total`
                  : "..."}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Media Servers</p>
              <p className="font-medium">{systemInfo?.stats.servers ?? "..."}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <h2 className="text-xl font-semibold">Release Notes</h2>
      {loadingChangelog ? (
        <Card>
          <CardContent className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Loading release notes...</span>
          </CardContent>
        </Card>
      ) : releaseNotes.length > 0 ? (
        <div className="space-y-2">
          {releaseNotes.map((note) => (
            <ReleaseNoteCard key={note.version} note={note} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Unable to load release notes. Version information may be unavailable.
            </p>
          </CardContent>
        </Card>
      )}

      <h2 className="text-xl font-semibold">Image Cache</h2>
      <Card>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Cached Images</p>
              <p className="font-medium">
                {imageCacheStats
                  ? `${imageCacheStats.fileCount.toLocaleString()} images — ${(imageCacheStats.totalSize / 1024 / 1024).toFixed(1)} MB`
                  : "..."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={clearingImageCache}
              onClick={onClearImageCache}
            >
              {clearingImageCache ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Clear Image Cache
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
