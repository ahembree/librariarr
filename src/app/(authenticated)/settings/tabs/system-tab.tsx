"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Trash2 } from "lucide-react";
import type { SystemInfo, ImageCacheStats } from "../types";

export interface SystemTabProps {
  systemInfo: SystemInfo | null;
  imageCacheStats: ImageCacheStats | null;
  clearingImageCache: boolean;
  onClearImageCache: () => void;
}

export function SystemTab({
  systemInfo,
  imageCacheStats,
  clearingImageCache,
  onClearImageCache,
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
