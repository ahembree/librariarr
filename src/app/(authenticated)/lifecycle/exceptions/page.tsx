"use client";

import { useState, useEffect, useCallback } from "react";
import { usePanelResize } from "@/hooks/use-panel-resize";
import { MediaDetailSidePanel } from "@/components/media-detail-side-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Loader2,
  ShieldOff,
  Trash2,
  Film,
  Tv,
  Music,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaItemWithRelations } from "@/lib/types";

interface ExceptionItem {
  id: string;
  reason: string | null;
  createdAt: string;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    type: string;
    year: number | null;
    thumbUrl: string | null;
    resolution: string | null;
  };
}

type TabType = "MOVIE" | "SERIES" | "MUSIC";

const TABS: { value: TabType; label: string; icon: typeof Film }[] = [
  { value: "MOVIE", label: "Movies", icon: Film },
  { value: "SERIES", label: "Series", icon: Tv },
  { value: "MUSIC", label: "Music", icon: Music },
];

export default function LifecycleExceptionsPage() {
  const [activeTab, setActiveTab] = useState<TabType>("MOVIE");
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ExceptionItem | null>(null);

  // Media detail panel
  const [selectedItem, setSelectedItem] = useState<MediaItemWithRelations | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const { width: panelWidth, resizeHandleProps } = usePanelResize({
    storageKey: "lifecycle-exceptions-panel-width",
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });

  const fetchExceptions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/lifecycle/exceptions?type=${activeTab}`);
      if (response.ok) {
        const data = await response.json();
        setExceptions(data.exceptions);
      }
    } catch (error) {
      console.error("Failed to fetch exceptions:", error);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchExceptions();
  }, [fetchExceptions]);

  const openDetailPanel = async (exception: ExceptionItem) => {
    const mediaType = exception.mediaItem.type as "MOVIE" | "SERIES" | "MUSIC";
    setSelectedItemType(mediaType);
    setLoadingDetailId(exception.mediaItem.id);
    try {
      const response = await fetch(`/api/media/${exception.mediaItem.id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedItem(data.item ?? data);
      }
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    } finally {
      setLoadingDetailId(null);
    }
  };

  const handleRemove = async (exception: ExceptionItem) => {
    setRemoving(exception.id);
    try {
      const response = await fetch(`/api/lifecycle/exceptions/${exception.id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setExceptions((prev) => prev.filter((e) => e.id !== exception.id));
        if (selectedItem && selectedItem.id === exception.mediaItem.id) {
          setSelectedItem(null);
        }
      }
    } catch (error) {
      console.error("Failed to remove exception:", error);
    } finally {
      setRemoving(null);
      setConfirmRemove(null);
    }
  };

  return (
    <div className="flex md:h-full">
      <div className="flex-1 min-w-0 space-y-6 p-6 md:overflow-y-auto">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lifecycle Exceptions</h1>
          <p className="text-muted-foreground">
            Media items excluded from lifecycle actions. These items will not be matched or actioned by any rule set.
          </p>
        </div>

        {/* Tab navigation */}
        <nav className="flex items-center gap-1 border-b overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={cn(
                  "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0",
                  activeTab === tab.value
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : exceptions.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <ShieldOff className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <CardTitle className="text-lg mb-2">No exceptions</CardTitle>
              <p className="text-muted-foreground text-sm">
                No {TABS.find((t) => t.value === activeTab)?.label.toLowerCase()} are excluded from lifecycle actions.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {exceptions.length} excluded {exceptions.length === 1 ? "item" : "items"}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead className="w-20">Year</TableHead>
                    <TableHead className="w-24">Resolution</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="w-36">Date Added</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exceptions.map((exception) => (
                    <TableRow
                      key={exception.id}
                      className={cn(
                        "cursor-pointer hover:bg-muted/50",
                        loadingDetailId === exception.mediaItem.id && "opacity-60",
                      )}
                      onClick={() => openDetailPanel(exception)}
                    >
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span className="truncate max-w-xs">
                            {exception.mediaItem.parentTitle
                              ? `${exception.mediaItem.parentTitle} — ${exception.mediaItem.title}`
                              : exception.mediaItem.title}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {exception.mediaItem.year ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {exception.mediaItem.resolution ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="truncate max-w-xs block">
                          {exception.reason || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(exception.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmRemove(exception);
                          }}
                          disabled={removing === exception.id}
                        >
                          {removing === exception.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Confirm removal dialog */}
        <AlertDialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove exception?</AlertDialogTitle>
              <AlertDialogDescription>
                This will allow &quot;{confirmRemove?.mediaItem.parentTitle
                  ? `${confirmRemove.mediaItem.parentTitle} — ${confirmRemove.mediaItem.title}`
                  : confirmRemove?.mediaItem.title}&quot; to be matched and actioned by lifecycle rules again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => confirmRemove && handleRemove(confirmRemove)}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Media detail side panel */}
      {selectedItem && (
        <MediaDetailSidePanel
          item={selectedItem}
          mediaType={selectedItemType}
          onClose={() => setSelectedItem(null)}
          width={panelWidth}
          resizeHandleProps={resizeHandleProps}
        />
      )}
    </div>
  );
}
