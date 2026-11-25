"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ColorChip } from "@/components/color-chip";
import { InlineError } from "@/components/inline-error";
import { QueryProgress, type ProgressState } from "@/components/query-progress";
import { RowToneChip } from "@/components/row-tone-chip";
import { formatBytesNum, formatDate, formatDateOnly, formatDuration } from "@/lib/format";
import {
  COLLECTION_SORT_DIRECTION_OPTIONS,
  COLLECTION_SORT_OPTIONS,
  COLLECTION_SORT_VALUE_KIND,
  type CollectionSortValueKind,
} from "@/lib/lifecycle/collection-sort";
import type {
  CollectionOrderPreview,
  CollectionOrderPreviewItem,
  CollectionOrderPreviewLibrary,
} from "@/lib/lifecycle/collection-order-preview";

/** A sort value as the preview shows it ("No value" when the item has none). */
export function formatCollectionSortValue(
  kind: CollectionSortValueKind,
  value: number | string | null,
): string {
  if (value === null || value === "") return "No value";
  if (kind === "text") return String(value);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "No value";
  switch (kind) {
    case "date":
      return formatDate(new Date(n).toISOString());
    case "dateOnly":
      return formatDateOnly(n);
    case "count":
      return n.toLocaleString("en-US");
    case "bytes":
      return formatBytesNum(n);
    case "duration":
      return formatDuration(n);
    case "rating":
      return n.toFixed(1);
  }
}

/** How an item's place changes: added, moved up/down, or unchanged (null). */
export function positionChange(item: CollectionOrderPreviewItem, diffKnown: boolean):
  | { kind: "added" }
  | { kind: "up" | "down"; by: number }
  | null {
  if (!diffKnown) return null;
  if (item.previousPosition === null) return { kind: "added" };
  const by = item.previousPosition - item.position;
  if (by === 0) return null;
  return by > 0 ? { kind: "up", by } : { kind: "down", by: -by };
}

const MOVE_CHIP = "border-sky/25 bg-sky-dim text-sky gap-0.5";

function ChangeChip({ item, diffKnown }: { item: CollectionOrderPreviewItem; diffKnown: boolean }) {
  const change = positionChange(item, diffKnown);
  if (!change) return <span className="w-12 shrink-0" aria-hidden="true" />;
  if (change.kind === "added") return <RowToneChip tone="added" />;
  const Icon = change.kind === "up" ? ArrowUp : ArrowDown;
  return (
    <ColorChip
      className={MOVE_CHIP}
      title={`Was #${item.previousPosition! + 1}, now #${item.position + 1}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {change.by}
    </ColorChip>
  );
}

function librarySummary(library: CollectionOrderPreviewLibrary): string {
  const parts = [`${library.items.length.toLocaleString("en-US")} item${library.items.length === 1 ? "" : "s"}`];
  if (library.status === "ok") {
    const added = library.items.filter((i) => i.previousPosition === null).length;
    const moved = library.items.filter((i) => i.previousPosition !== null && i.previousPosition !== i.position).length;
    if (library.collectionExists === false) parts.push("collection created on the next sync");
    else {
      if (added > 0) parts.push(`${added} new`);
      if (library.removed.length > 0) parts.push(`${library.removed.length} removed`);
      if (moved > 0) parts.push(`${moved} change position`);
    }
  }
  if (library.plexSorted) parts.push("Plex keeps this order itself");
  else if (library.moves === 0) parts.push("already in order");
  else if (library.moves !== null) parts.push(`${library.moves} move${library.moves === 1 ? "" : "s"} on the next sync`);
  return parts.join(" · ");
}

function LibrarySection({
  library,
  kind,
}: {
  library: CollectionOrderPreviewLibrary;
  kind: CollectionSortValueKind;
}) {
  const diffKnown = library.status === "ok" && library.collectionExists === true;
  const showValue = (item: CollectionOrderPreviewItem) =>
    kind !== "text" || (item.value !== null && item.value !== item.title);
  return (
    <section className="space-y-2" aria-label={`${library.libraryTitle} on ${library.serverName}`}>
      <div>
        <h3 className="text-sm font-semibold">
          {library.libraryTitle}
          {library.serverName && <span className="font-normal text-muted-foreground"> · {library.serverName}</span>}
        </h3>
        {(library.status === "ok" || library.status === "currentUnknown") && (
          <p className="text-xs text-muted-foreground">{librarySummary(library)}</p>
        )}
      </div>
      {library.message &&
        (library.status === "error" || library.status === "currentUnknown" ? (
          <InlineError multiline>{library.message}</InlineError>
        ) : (
          <p className="rounded-md bg-amber-dim p-3 text-sm text-amber">{library.message}</p>
        ))}
      {library.items.length > 0 && (
        <ol className="divide-y divide-border rounded-md border border-border">
          {library.items.map((item) => (
            <li key={item.ratingKey} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <span className="w-8 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {item.position + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={item.title}>{item.title}</span>
                {showValue(item) && (
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {formatCollectionSortValue(kind, item.value)}
                    {item.estimated && " (estimated)"}
                  </span>
                )}
              </span>
              <ChangeChip item={item} diffKnown={diffKnown} />
            </li>
          ))}
        </ol>
      )}
      {library.status === "ok" && library.removed.length > 0 && (
        <div className="space-y-1">
          <p className="eyebrow text-muted-foreground">Leaving the collection</p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {library.removed.map((item) => (
              <li key={item.ratingKey} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <span className="w-8 shrink-0 text-right font-mono text-xs text-muted-foreground">
                  {item.previousPosition + 1}
                </span>
                <span className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
                <RowToneChip tone="removed" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export interface CollectionOrderPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionName: string;
  loading: boolean;
  progress: ProgressState;
  error: string | null;
  result: CollectionOrderPreview | null;
}

/**
 * The rule editor's Collection Order Preview: per Plex library, the order the
 * collection's members would be in after the next sync — the editor's unsaved
 * rules and sort — with each item's sort value and how its place changes
 * against Plex's current order (`POST /api/lifecycle/collections/order-preview`).
 */
export function CollectionOrderPreviewDialog({
  open,
  onOpenChange,
  collectionName,
  loading,
  progress,
  error,
  result,
}: CollectionOrderPreviewDialogProps) {
  const fieldLabel = result ? COLLECTION_SORT_OPTIONS.find((o) => o.value === result.field)?.label : null;
  const directionLabel = result
    ? COLLECTION_SORT_DIRECTION_OPTIONS.find((o) => o.value === result.direction)?.label.toLowerCase()
    : null;
  const kind = result ? COLLECTION_SORT_VALUE_KIND[result.field] : "text";
  const hasEstimates = !!result?.libraries.some((l) => l.items.some((i) => i.estimated));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Collection Order Preview</DialogTitle>
          <DialogDescription>
            {result
              ? `"${collectionName}" by ${fieldLabel?.toLowerCase()}, ${directionLabel}, with this editor's unsaved rules. Nothing is changed until you save.`
              : `The order "${collectionName}" would have after the next sync, with this editor's unsaved rules.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60dvh] space-y-5 overflow-y-auto pr-1">
          {loading && (
            progress.phases.length > 0
              ? <QueryProgress state={progress} />
              : <p className="text-sm text-muted-foreground">Working out the order…</p>
          )}
          {!loading && error && <InlineError multiline>{error}</InlineError>}
          {!loading && !error && result && (
            <>
              {hasEstimates && (
                <p className="text-xs text-muted-foreground">
                  An estimated date belongs to a match with no action scheduled yet: today plus the action delay.
                </p>
              )}
              {result.libraries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing matches, and no Plex library holds this collection — the sync leaves Plex as it is.
                </p>
              ) : (
                result.libraries.map((library) => (
                  <LibrarySection key={library.libraryId} library={library} kind={kind} />
                ))
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
