"use client";

import { useState, useEffect, useRef } from "react";
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
  Square,
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

function cleanItem(raw: string): string {
  return (
    raw
      .replace(/\s*\(\[?[a-f0-9]{7,40}\]?\([^)]*\)\)/g, "")
      .replace(/\s*\([a-f0-9]{7,40}\)/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

function parseReleaseBody(body: string): { heading: string; items: string[] }[] {
  const lines = body.split("\n");
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+\[?\d+\.\d+/.test(trimmed)) continue;
    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      current = { heading: headingMatch[1], items: [] };
      sections.push(current);
      continue;
    }
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

// ─── Cache images types & helpers ───

const LIBRARY_TYPE_LABELS: Record<string, string> = {
  MOVIE: "Movies",
  SERIES: "Series",
  MUSIC: "Music",
};

interface CacheJob {
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  totalItems: number;
  processedItems: number;
  totalImages: number;
  processedImages: number;
  cachedImages: number;
  skippedImages: number;
  failedImages: number;
  totalCachedBytes: number;
  error?: string;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Library picker dialog (select & start only) ───

interface ServerInfo {
  id: string;
  name: string;
  libraryTypes: string[];
}

function CacheImagesPickerDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: () => void;
}) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedServerIds, setSelectedServerIds] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStarting(false);

    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/servers");
        if (res.ok) {
          const data = await res.json();
          const serverList: ServerInfo[] = (data.servers ?? [])
            .filter((s: { enabled: boolean }) => s.enabled)
            .map((s: { id: string; name: string; libraries: Array<{ type: string; enabled: boolean }> }) => ({
              id: s.id,
              name: s.name,
              libraryTypes: [...new Set(
                s.libraries
                  .filter((l) => l.enabled)
                  .map((l) => l.type),
              )],
            }))
            .filter((s: ServerInfo) => s.libraryTypes.length > 0);

          setServers(serverList);
          setSelectedServerIds(new Set(serverList.map((s) => s.id)));

          // Derive available library types from all servers
          const allTypes = new Set<string>();
          for (const s of serverList) {
            for (const t of s.libraryTypes) allTypes.add(t);
          }
          setSelectedTypes(allTypes);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const toggleServer = (id: string) => {
    setSelectedServerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Derive available library types from selected servers
  const availableTypes = [...new Set(
    servers
      .filter((s) => selectedServerIds.has(s.id))
      .flatMap((s) => s.libraryTypes),
  )];

  const handleStart = async () => {
    if (selectedTypes.size === 0 || selectedServerIds.size === 0) return;
    setStarting(true);
    try {
      const body: Record<string, unknown> = {
        libraryTypes: Array.from(selectedTypes),
      };
      // Only include serverIds if not all servers are selected
      if (selectedServerIds.size < servers.length) {
        body.serverIds = Array.from(selectedServerIds);
      }
      const res = await fetch("/api/media/cache-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        onOpenChange(false);
        onStarted();
      }
    } catch {
      // ignore
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cache Library Images</DialogTitle>
          <DialogDescription>
            Select servers and library types to cache. Caching runs in the background.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-4 justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No enabled servers with libraries found.
          </p>
        ) : (
          <div className="space-y-4">
            {servers.length > 1 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Servers</p>
                {servers.map((server) => (
                  <label
                    key={server.id}
                    className="flex items-center gap-3 rounded-md border px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={selectedServerIds.has(server.id)}
                      onCheckedChange={() => toggleServer(server.id)}
                    />
                    <span className="text-sm font-medium">{server.name}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Library Types</p>
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
              {availableTypes.length === 0 && selectedServerIds.size > 0 && (
                <p className="text-xs text-muted-foreground">No library types available for selected servers.</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleStart}
            disabled={selectedTypes.size === 0 || selectedServerIds.size === 0 || starting || loading}
          >
            {starting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ImageDown className="mr-2 h-4 w-4" />
            )}
            Start Caching
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
  const [cacheJob, setCacheJob] = useState<CacheJob | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onRefreshRef = useRef(onRefreshCacheStats);

  useEffect(() => {
    onRefreshRef.current = onRefreshCacheStats;
  }, [onRefreshCacheStats]);

  const pollJobRef = useRef<() => void>();

  useEffect(() => {
    mountedRef.current = true;

    const poll = async () => {
      try {
        const res = await fetch("/api/media/cache-images");
        if (!res.ok) return;
        const data = await res.json();
        if (!mountedRef.current) return;

        const j = data.job as CacheJob | null;
        setCacheJob(j);

        if (j && j.status === "RUNNING") {
          pollTimer.current = setTimeout(() => pollJobRef.current?.(), 1500);
          return;
        }

        // Job finished — refresh cache stats
        if (j && j.status !== "RUNNING") {
          onRefreshRef.current();
        }
      } catch {
        // ignore
      }
    };

    pollJobRef.current = poll;
    poll();

    return () => {
      mountedRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const handleJobStarted = () => {
    setCacheJob({
      status: "RUNNING",
      totalItems: 0,
      processedItems: 0,
      totalImages: 0,
      processedImages: 0,
      cachedImages: 0,
      skippedImages: 0,
      failedImages: 0,
      totalCachedBytes: 0,
    });
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => pollJobRef.current?.(), 1500);
  };

  const [stopping, setStopping] = useState(false);

  const handleStopJob = async () => {
    setStopping(true);
    try {
      await fetch("/api/media/cache-images", { method: "DELETE" });
    } catch {
      // ignore
    } finally {
      setStopping(false);
    }
  };

  const isRunning = cacheJob?.status === "RUNNING";
  const isCompleted = cacheJob?.status === "COMPLETED";
  const isFailed = cacheJob?.status === "FAILED";
  const isCancelled = cacheJob?.status === "CANCELLED";
  const pct = cacheJob && cacheJob.totalImages > 0
    ? Math.round((cacheJob.processedImages / cacheJob.totalImages) * 100)
    : 0;
  const estimatedTotalSize = cacheJob && cacheJob.processedImages > 0 && cacheJob.totalImages > 0
    ? Math.round((cacheJob.totalCachedBytes / cacheJob.processedImages) * cacheJob.totalImages)
    : 0;

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
        <CardContent className="space-y-4">
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
              {isRunning ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStopJob}
                  disabled={stopping}
                >
                  {stopping ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="mr-2 h-3.5 w-3.5" />
                  )}
                  Stop
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCacheDialogOpen(true)}
                >
                  <ImageDown className="mr-2 h-4 w-4" />
                  Cache Images
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={clearingImageCache || isRunning}
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

          {/* Inline progress bar while job is running */}
          {isRunning && cacheJob && (
            <div className="space-y-2">
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {cacheJob.totalImages > 0
                    ? `${cacheJob.processedImages.toLocaleString()} / ${cacheJob.totalImages.toLocaleString()} images`
                    : "Starting..."}
                </span>
                <span>
                  {cacheJob.totalCachedBytes > 0 && (
                    <>
                      {formatSize(cacheJob.totalCachedBytes)}
                      {estimatedTotalSize > 0 && ` / ~${formatSize(estimatedTotalSize)}`}
                    </>
                  )}
                </span>
              </div>
            </div>
          )}

          {/* Completion summary */}
          {isCompleted && cacheJob && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>
                  Cached {cacheJob.cachedImages.toLocaleString()} images
                  {cacheJob.skippedImages > 0 && `, ${cacheJob.skippedImages.toLocaleString()} already cached`}
                  {cacheJob.failedImages > 0 && `, ${cacheJob.failedImages.toLocaleString()} failed`}
                </span>
              </div>
              {cacheJob.totalCachedBytes > 0 && (
                <span>{formatSize(cacheJob.totalCachedBytes)}</span>
              )}
            </div>
          )}

          {/* Cancelled summary */}
          {isCancelled && cacheJob && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Stopped — cached {cacheJob.cachedImages.toLocaleString()} images
                {cacheJob.skippedImages > 0 && `, ${cacheJob.skippedImages.toLocaleString()} already cached`}
              </span>
              {cacheJob.totalCachedBytes > 0 && (
                <span>{formatSize(cacheJob.totalCachedBytes)}</span>
              )}
            </div>
          )}

          {/* Failure message */}
          {isFailed && cacheJob && (
            <p className="text-xs text-destructive">
              {cacheJob.error ?? "Image caching failed unexpectedly."}
              {cacheJob.cachedImages > 0 && ` (${cacheJob.cachedImages.toLocaleString()} images cached before failure)`}
            </p>
          )}
        </CardContent>
      </Card>

      <CacheImagesPickerDialog
        open={cacheDialogOpen}
        onOpenChange={setCacheDialogOpen}
        onStarted={handleJobStarted}
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
