"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsSection } from "../components";
import { ReleaseNoteSections } from "@/components/release-note-sections";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  HardDrive,
  Info,
  Loader2,
  Newspaper,
  Trash2,
} from "lucide-react";
import type { SystemInfo, ImageCacheStats, ReleaseNote, UpdateCheck } from "../types";

interface SystemTabProps {
  systemInfo: SystemInfo | null;
  /** Loaded separately (it asks GitHub); null until it answers. */
  updateCheck: UpdateCheck | null;
  imageCacheStats: ImageCacheStats | null;
  clearingImageCache: boolean;
  onClearImageCache: () => void;
  releaseNotes: ReleaseNote[];
  loadingChangelog: boolean;
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

function ReleaseNoteRow({ note }: { note: ReleaseNote }) {
  const [open, setOpen] = useState(note.isLatest && !note.isCurrent);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center justify-between gap-3 py-3 text-left -mx-6 px-6 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-medium font-mono text-sm">v{note.version}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {note.isCurrent && (
                <ColorChip className="bg-muted/40 text-muted-foreground">Current</ColorChip>
              )}
              {note.isLatest && !note.isCurrent && (
                <ColorChip className="border-green/25 bg-green-dim text-green">Latest</ColorChip>
              )}
            </div>
            {note.publishedAt && (
              <span className="text-xs text-muted-foreground truncate">
                {formatDate(note.publishedAt)}
              </span>
            )}
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1 pb-3 space-y-3">
          <ReleaseNoteSections body={note.body} />
          {note.url && (
            <a
              href={note.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SystemTab({
  systemInfo,
  updateCheck,
  imageCacheStats,
  clearingImageCache,
  onClearImageCache,
  releaseNotes,
  loadingChangelog,
}: SystemTabProps) {
  const [confirmClearCache, setConfirmClearCache] = useState(false);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">System</h2>
        <p className="text-sm text-muted-foreground">
          Application status, storage, and release history.
        </p>
      </div>

      {/* System Information */}
      <SettingsSection icon={Info} title="System Information" description="Version, database, and library statistics.">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Application Version</p>
              <p className="font-medium">{systemInfo?.appVersion ?? "..."}</p>
              {updateCheck?.updateAvailable && updateCheck.latestVersion && (
                <a
                  href={updateCheck.releaseUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                >
                  <ArrowUpCircle className="h-3 w-3" />
                  v{updateCheck.latestVersion} available
                </a>
              )}
              {updateCheck && !updateCheck.updateAvailable && updateCheck.latestVersion && (
                <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3" />
                  Up to date
                </p>
              )}
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Database Migration</p>
              <p className="font-medium font-mono text-sm [overflow-wrap:anywhere]">{systemInfo?.latestMigration ?? "..."}</p>
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
      </SettingsSection>

      {/* Image Cache */}
      <SettingsSection icon={HardDrive} title="Image Cache" description="Cached artwork from your media servers — clear to free disk space.">
          <div className="flex items-center justify-between gap-4">
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
              onClick={() => setConfirmClearCache(true)}
            >
              {clearingImageCache ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Clear Image Cache
            </Button>
          </div>

          <AlertDialog open={confirmClearCache} onOpenChange={setConfirmClearCache}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear image cache?</AlertDialogTitle>
                <AlertDialogDescription>
                  All cached artwork will be deleted and re-fetched from your media servers as
                  pages are viewed. This may briefly slow down library browsing.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setConfirmClearCache(false);
                    onClearImageCache();
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear Cache
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
      </SettingsSection>

      {/* Release Notes */}
      <SettingsSection icon={Newspaper} title="Release Notes" description="Recent changes to Librariarr — click any version to expand.">
          {loadingChangelog ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading release notes...</span>
            </div>
          ) : releaseNotes.length > 0 ? (
            <div>
              {releaseNotes.map((note, i) => (
                <div key={note.version}>
                  {i > 0 && <Separator />}
                  <ReleaseNoteRow note={note} />
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Unable to load release notes. Version information may be unavailable.
            </p>
          )}
      </SettingsSection>
    </div>
  );
}
