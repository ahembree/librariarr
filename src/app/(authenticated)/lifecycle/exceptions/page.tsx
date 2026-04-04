"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  ShieldOff,
  Trash2,
  Pencil,
  Plus,
  Search,
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

interface SearchResult {
  id: string;
  title: string;
  parentTitle: string | null;
  year: number | null;
  type: string;
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

  // Edit reason
  const [editingException, setEditingException] = useState<ExceptionItem | null>(null);
  const [editReason, setEditReason] = useState("");
  const [savingReason, setSavingReason] = useState(false);

  // Add manually
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingItemId, setAddingItemId] = useState<string | null>(null);
  const [addReason, setAddReason] = useState("");
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Media detail panel
  const [selectedItem, setSelectedItem] = useState<MediaItemWithRelations | null>(null);
  const [selectedItemType, setSelectedItemType] = useState<"MOVIE" | "SERIES" | "MUSIC">("MOVIE");
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

    try {
      const response = await fetch(`/api/media/${exception.mediaItem.id}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedItem(data.item ?? data);
      }
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    } finally {

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

  const handleEditReason = async () => {
    if (!editingException) return;
    setSavingReason(true);
    try {
      const response = await fetch(`/api/lifecycle/exceptions/${editingException.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: editReason || undefined }),
      });
      if (response.ok) {
        setExceptions((prev) =>
          prev.map((e) =>
            e.id === editingException.id ? { ...e, reason: editReason || null } : e
          )
        );
        setEditingException(null);
      }
    } catch (error) {
      console.error("Failed to update reason:", error);
    } finally {
      setSavingReason(false);
    }
  };

  // Search for media items to add manually
  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: query, type: activeTab });
      const response = await fetch(`/api/media/search?${params}`);
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data.items || []);
      }
    } catch (error) {
      console.error("Failed to search media:", error);
    } finally {
      setSearching(false);
    }
  }, [activeTab]);

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      handleSearch(value);
    }, 300);
  };

  const handleAddException = async (item: SearchResult) => {
    setAddingItemId(item.id);
    try {
      const response = await fetch("/api/lifecycle/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaItemId: item.id, reason: addReason || undefined }),
      });
      if (response.ok) {
        // Remove from search results and refresh exceptions
        setSearchResults((prev) => prev.filter((r) => r.id !== item.id));
        await fetchExceptions();
      }
    } catch (error) {
      console.error("Failed to add exception:", error);
    } finally {
      setAddingItemId(null);
    }
  };

  const exceptionColumns: DataTableColumn<ExceptionItem>[] = [
    {
      id: "title",
      header: "Title",
      defaultWidth: 300,
      sortable: true,
      accessor: (e) => (
        <span className="truncate max-w-xs font-medium">
          {e.mediaItem.parentTitle
            ? `${e.mediaItem.parentTitle} — ${e.mediaItem.title}`
            : e.mediaItem.title}
        </span>
      ),
      sortValue: (e) =>
        e.mediaItem.parentTitle
          ? `${e.mediaItem.parentTitle} — ${e.mediaItem.title}`
          : e.mediaItem.title,
    },
    {
      id: "year",
      header: "Year",
      defaultWidth: 80,
      sortable: true,
      className: "text-muted-foreground",
      accessor: (e) => e.mediaItem.year ?? "—",
      sortValue: (e) => e.mediaItem.year ?? 0,
    },
    {
      id: "reason",
      header: "Reason",
      defaultWidth: 200,
      className: "text-muted-foreground",
      accessor: (e) => (
        <span className="truncate max-w-xs block">
          {e.reason || "—"}
        </span>
      ),
    },
    {
      id: "createdAt",
      header: "Date Added",
      defaultWidth: 140,
      sortable: true,
      className: "text-muted-foreground text-sm",
      accessor: (e) => new Date(e.createdAt).toLocaleDateString(),
      sortValue: (e) => new Date(e.createdAt).getTime(),
    },
    {
      id: "actions",
      header: "",
      defaultWidth: 100,
      accessor: (exception) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setEditingException(exception);
              setEditReason(exception.reason || "");
            }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmRemove(exception)}
            disabled={removing === exception.id}
          >
            {removing === exception.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      ),
    },
  ];

  const existingMediaItemIds = new Set(exceptions.map((e) => e.mediaItem.id));

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 space-y-6 p-6 overflow-y-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Lifecycle Exceptions</h1>
            <p className="text-muted-foreground">
              Media items excluded from lifecycle actions. These items will not be matched or actioned by any rule set.
            </p>
          </div>
          <Button onClick={() => {
            setShowAddDialog(true);
            setSearchQuery("");
            setSearchResults([]);
            setAddReason("");
          }}>
            <Plus className="h-4 w-4 mr-2" />
            Add Exception
          </Button>
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
              <DataTable<ExceptionItem>
                columns={exceptionColumns}
                data={exceptions}
                keyExtractor={(e) => e.id}
                defaultSortId="title"
                resizeStorageKey="dt-widths-exceptions"
                onRowClick={(exception) => openDetailPanel(exception)}
              />
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

        {/* Edit reason dialog */}
        <Dialog open={!!editingException} onOpenChange={(open) => { if (!open) setEditingException(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit exclusion reason</DialogTitle>
              <DialogDescription>
                Update the reason for excluding &quot;{editingException?.mediaItem.parentTitle
                  ? `${editingException.mediaItem.parentTitle} — ${editingException.mediaItem.title}`
                  : editingException?.mediaItem.title}&quot;.
              </DialogDescription>
            </DialogHeader>
            <Input
              placeholder="Reason (optional)"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditReason();
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingException(null)}>
                Cancel
              </Button>
              <Button onClick={handleEditReason} disabled={savingReason}>
                {savingReason ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Add exception dialog */}
        <Dialog open={showAddDialog} onOpenChange={(open) => { if (!open) setShowAddDialog(false); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Exception</DialogTitle>
              <DialogDescription>
                Search for a {TABS.find((t) => t.value === activeTab)?.label.toLowerCase().replace(/s$/, "")} to exclude from lifecycle actions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by title..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  autoFocus
                />
              </div>
              <Input
                placeholder="Reason (optional)"
                value={addReason}
                onChange={(e) => setAddReason(e.target.value)}
              />
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {searching ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {searchQuery.trim() ? "No results found." : "Type to search for media items."}
                  </div>
                ) : (
                  <div className="divide-y">
                    {searchResults.map((item) => {
                      const alreadyExcluded = existingMediaItemIds.has(item.id);
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/50"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {item.parentTitle
                                ? `${item.parentTitle} — ${item.title}`
                                : item.title}
                            </p>
                            {item.year && (
                              <p className="text-xs text-muted-foreground">{item.year}</p>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-3 shrink-0"
                            disabled={alreadyExcluded || addingItemId === item.id}
                            onClick={() => handleAddException(item)}
                          >
                            {addingItemId === item.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : alreadyExcluded ? (
                              "Excluded"
                            ) : (
                              <>
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                Add
                              </>
                            )}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
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
