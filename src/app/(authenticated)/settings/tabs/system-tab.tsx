"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  ImageDown,
  Loader2,
  Trash2,
} from "lucide-react";
import type { SystemInfo, ImageCacheStats, ReleaseNote } from "../types";

export interface SystemTabProps {
  systemInfo: SystemInfo | null;
  imageCacheStats: ImageCacheStats | null;
  clearingImageCache: boolean;
  onClearImageCache: () => void;
  onRefreshCacheStats: () => void;
  releaseNotes: ReleaseNote[];
  loadingChangelog: boolean;
}

// ─── Release notes helpers ───

/**
 * Clean a markdown list item for display:
 * - Strip commit hash links: "([abc1234](url))" or "(abc1234)"
 * - Convert bold scopes: "**lifecycle:** msg" → "lifecycle: msg"
 * - Decode HTML entities: "&gt;" → ">"
 */
function cleanItem(raw: string): string {
  return (
    raw
      // Remove markdown commit links: ([hash](url))
      .replace(/\s*\(\[?[a-f0-9]{7,40}\]?\([^)]*\)\)/g, "")
      // Remove bare hash refs: (hash)
      .replace(/\s*\([a-f0-9]{7,40}\)/g, "")
      // Convert **scope:** to scope:
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      // Decode common HTML entities from GitHub
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

/**
 * Parse a release-please body into grouped sections.
 * Handles the format: ## [version](url) (date) then ### Section headings with * items.
 */
function parseReleaseBody(body: string): { heading: string; items: string[] }[] {
  const lines = body.split("\n");
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip the version header line: ## [0.11.3](url) (date)
    if (/^##\s+\[?\d+\.\d+/.test(trimmed)) continue;

    // Section heading (### Bug Fixes, ### Features, etc.)
    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      current = { heading: headingMatch[1], items: [] };
      sections.push(current);
      continue;
    }

    // List item
    if ((trimmed.startsWith("* ") || trimmed.startsWith("- ")) && current) {
      current.items.push(cleanItem(trimmed.slice(2)));
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

// ─── Cache images dialog ───

const LIBRARY_TYPE_LABELS: Record<string, string> = {
  MOVIE: "Movies",
  SERIES: "Series",
  MUSIC: "Music",
};

interface CacheJob {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  totalItems: number;
  processedItems: number;
  cachedImages: number;
  skippedImages: number;
  failedImages: number;
  error?: string;
}

function CacheImagesDialog({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [job, setJob] = useState<CacheJob | null>(null);
  const [starting, setStarting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Fetch available library types when dialog opens
  useEffect(() => {
    if (!open) return;
    mountedRef.current = true;
    setJob(null);
    setStarting(false);

    (async () => {
      setLoadingTypes(true);
      try {
        const res = await fetch("/api/media/library-types");
        if (res.ok) {
          const data = await res.json();
          const types = data.types as string[];
          if (mountedRef.current) {
            setAvailableTypes(types);
            setSelectedTypes(new Set(types));
          }
        }
      } catch {
        // ignore
      } finally {
        if (mountedRef.current) setLoadingTypes(false);
      }

      // Also check for an existing running job
      try {
        const res = await fetch("/api/media/cache-images");
        if (res.ok) {
          const data = await res.json();
          if (data.job && mountedRef.current) {
            setJob(data.job);
            if (data.job.status === "RUNNING") {
              startPolling();
            }
          }
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      mountedRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/media/cache-images");
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;

      const j = data.job as CacheJob | null;
      setJob(j);

      if (!j || j.status !== "RUNNING") {
        onCompleteRef.current();
        return;
      }
    } catch {
      // ignore
    }
    if (mountedRef.current) {
      pollTimer.current = setTimeout(poll, 1500);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(poll, 1500);
  }, [poll]);

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const handleStart = async () => {
    if (selectedTypes.size === 0) return;
    setStarting(true);
    setJob(null);
    try {
      const res = await fetch("/api/media/cache-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryTypes: Array.from(selectedTypes) }),
      });
      if (res.ok) {
        setJob({
          status: "RUNNING",
          totalItems: 0,
          processedItems: 0,
          cachedImages: 0,
          skippedImages: 0,
          failedImages: 0,
        });
        startPolling();
      }
    } catch {
      // ignore
    } finally {
      setStarting(false);
    }
  };

  const isRunning = job?.status === "RUNNING";
  const isCompleted = job?.status === "COMPLETED";
  const isFailed = job?.status === "FAILED";
  const pct = job && job.totalItems > 0 ? Math.round((job.processedItems / job.totalItems) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isRunning) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cache Library Images</DialogTitle>
          <DialogDescription>
            Download and cache all images (posters, artwork, backgrounds, cast photos) for the selected library types.
          </DialogDescription>
        </DialogHeader>

        {!isRunning && !isCompleted && !isFailed && (
          <div className="space-y-3">
            {loadingTypes ? (
              <div className="flex items-center gap-2 py-4 justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading libraries...</span>
              </div>
            ) : availableTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No enabled libraries found.
              </p>
            ) : (
              <div className="space-y-2">
                {availableTypes.map((type) => (
                  <label
                    key={type}
                    className="flex items-center gap-3 rounded-md border px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={selectedTypes.has(type)}
                      onCheckedChange={() => toggleType(type)}
                    />
                    <span className="text-sm font-medium">
                      {LIBRARY_TYPE_LABELS[type] ?? type}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {isRunning && (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="text-sm font-medium">Caching images... {pct}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            {job && job.totalItems > 0 && (
              <p className="text-xs text-muted-foreground">
                {job.processedItems.toLocaleString()} / {job.totalItems.toLocaleString()} items processed
              </p>
            )}
          </div>
        )}

        {isCompleted && job && (
          <div className="space-y-2 py-2">
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-sm font-medium">Caching complete</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border px-2 py-1.5">
                <p className="text-lg font-semibold">{job.cachedImages.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Cached</p>
              </div>
              <div className="rounded-md border px-2 py-1.5">
                <p className="text-lg font-semibold">{job.skippedImages.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Already cached</p>
              </div>
              <div className="rounded-md border px-2 py-1.5">
                <p className="text-lg font-semibold">{job.failedImages.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
            </div>
          </div>
        )}

        {isFailed && job && (
          <div className="space-y-2 py-2">
            <p className="text-sm text-destructive">
              {job.error ?? "Image caching failed unexpectedly."}
            </p>
            {job.processedItems > 0 && (
              <p className="text-xs text-muted-foreground">
                Processed {job.processedItems.toLocaleString()} / {job.totalItems.toLocaleString()} items before failure.
                {job.cachedImages > 0 && ` ${job.cachedImages.toLocaleString()} images were cached successfully.`}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {!isRunning && (isCompleted || isFailed) && (
            <Button variant="outline" onClick={() => { setJob(null); }}>
              {isFailed ? "Try Again" : "Cache More"}
            </Button>
          )}
          {!isRunning && !isCompleted && !isFailed && (
            <Button
              onClick={handleStart}
              disabled={selectedTypes.size === 0 || starting || loadingTypes}
            >
              {starting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ImageDown className="mr-2 h-4 w-4" />
              )}
              Start Caching
            </Button>
          )}
          <Button
            variant={isRunning ? "outline" : "ghost"}
            onClick={() => onOpenChange(false)}
            disabled={isRunning}
          >
            {isCompleted || isFailed ? "Close" : isRunning ? "Running..." : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main SystemTab ───

export function SystemTab({
  systemInfo,
  imageCacheStats,
  clearingImageCache,
  onClearImageCache,
  onRefreshCacheStats,
  releaseNotes,
  loadingChangelog,
}: SystemTabProps) {
  const [cacheDialogOpen, setCacheDialogOpen] = useState(false);

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
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCacheDialogOpen(true)}
              >
                <ImageDown className="mr-2 h-4 w-4" />
                Cache Images
              </Button>
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
          </div>
        </CardContent>
      </Card>

      <CacheImagesDialog
        open={cacheDialogOpen}
        onOpenChange={setCacheDialogOpen}
        onComplete={onRefreshCacheStats}
      />

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
    </div>
  );
}
