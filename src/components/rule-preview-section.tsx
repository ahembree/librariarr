"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { Calendar, Clock, HardDrive, LayoutGrid, ShieldOff, TableProperties } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { MediaTable } from "@/components/media-table";
import { MediaCard } from "@/components/media-card";
import { MediaHoverPopover, hoverDataFromListItem } from "@/components/media-hover-popover";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { MetadataLine, MetadataItem } from "@/components/metadata-line";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VirtualCardGrid, type GridCardContext } from "@/components/virtual-card-grid";
import type { MatchedCriterion } from "@/components/media-detail-side-panel";
import { useChipColors } from "@/components/chip-color-provider";
import { useCardSize } from "@/hooks/use-card-size";
import { useCardDisplay, TOGGLE_CONFIGS } from "@/hooks/use-card-display";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useVirtualPosterGrid, POSTER_ASPECT, SQUARE_ASPECT } from "@/hooks/use-virtual-poster-grid";
import { LIBRARY_CARD_CONTENT_HEIGHT } from "@/hooks/use-library-grid";
import type { ChipColorCategory } from "@/lib/theme/chip-colors";
import { qualityChips, qualitySegments } from "@/lib/media/quality-chips";
import { formatDuration, formatFileSize } from "@/lib/format";
import { findScrollContainer } from "@/lib/scroll-utils";
import type { MediaItemWithRelations } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface PreviewItem extends MediaItemWithRelations {
  matchedCriteria?: MatchedCriterion[];
  actualValues?: Record<string, string>;
}

export type PreviewDiffStatus = "added" | "removed" | "retained";

export interface PreviewDiffCounts {
  added: number;
  removed: number;
  retained: number;
}

type MediaType = "MOVIE" | "SERIES" | "MUSIC";

// Fields stored as numeric values but serialized as strings (e.g. BigInt fileSize)
// must be compared numerically — a lexicographic compare ranks "9000" above "10000".
const NUMERIC_PREVIEW_FIELDS = new Set(["fileSize"]);

function sortPreview(items: PreviewItem[], sortBy: string | undefined, sortOrder: "asc" | "desc"): PreviewItem[] {
  if (!sortBy) return items;
  return [...items].sort((a, b) => {
    const aVal = a[sortBy as keyof PreviewItem];
    const bVal = b[sortBy as keyof PreviewItem];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    let cmp: number;
    if (NUMERIC_PREVIEW_FIELDS.has(sortBy)) {
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      cmp = aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
    } else {
      cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    }
    return sortOrder === "asc" ? cmp : -cmp;
  });
}

function previewImageUrl(item: PreviewItem, mediaType: MediaType): string {
  return `/api/media/${item.id}/image${mediaType !== "MOVIE" ? "?type=parent" : ""}`;
}

/** The hover popover's fields, the same in the table and the card view. */
function previewHoverContent(item: PreviewItem, mediaType: MediaType, withImage: boolean) {
  return (
    <MediaHoverPopover
      imageUrl={withImage ? previewImageUrl(item, mediaType) : undefined}
      imageAspect={mediaType === "MUSIC" ? "square" : "poster"}
      data={hoverDataFromListItem(item, {
        title: item.parentTitle ? `${item.parentTitle} — ${item.title}` : item.title,
      })}
    />
  );
}

const previewKey = (item: PreviewItem) => item.id;

interface PreviewCardProps {
  item: PreviewItem;
  mediaType: MediaType;
  priority: boolean;
  diffStatus: PreviewDiffStatus | undefined;
  diffActive: boolean;
  excepted: boolean;
  onItemClick: (item: PreviewItem) => void;
  show: (section: "badges" | "metadata", key: string) => boolean;
  getHex: (category: ChipColorCategory, value: string) => string;
  showServers: boolean;
}

/** One preview card, memoised on what it shows (see `VirtualCardGrid`). */
const PreviewCard = memo(function PreviewCard({
  item,
  mediaType,
  priority,
  diffStatus,
  diffActive,
  excepted,
  onItemClick,
  show,
  getHex,
  showServers,
}: PreviewCardProps) {
  const isMusic = mediaType === "MUSIC";
  return (
    <div
      className={cn(
        "relative rounded-lg",
        diffActive && diffStatus === "added" && "ring-1 ring-emerald-500/70",
        diffActive && diffStatus === "removed" && "ring-1 ring-amber/70 opacity-60",
      )}
    >
      {excepted && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="absolute top-2 left-2 z-20 h-6 w-6 rounded-md bg-orange-500/90 backdrop-blur-sm flex items-center justify-center">
              <ShieldOff className="h-3.5 w-3.5 text-white" />
            </div>
          </TooltipTrigger>
          <TooltipContent>Excluded from lifecycle actions</TooltipContent>
        </Tooltip>
      )}
      <MediaCard
        imageUrl={previewImageUrl(item, mediaType)}
        title={item.parentTitle ? `${item.parentTitle} - ${item.title}` : item.title}
        fallbackIcon={mediaType === "MOVIE" ? "movie" : isMusic ? "music" : "series"}
        aspectRatio={isMusic ? "square" : "poster"}
        priority={priority}
        prefetchMediaId={item.id}
        onClick={() => onItemClick(item)}
        hoverContent={previewHoverContent(item, mediaType, false)}
        metadata={
          <MetadataLine stacked>
            {show("metadata", "year") && item.year && <MetadataItem icon={<Calendar />}>{item.year}</MetadataItem>}
            {show("metadata", "duration") && formatDuration(item.duration) && <MetadataItem icon={<Clock />}>{formatDuration(item.duration)}</MetadataItem>}
            {show("metadata", "fileSize") && formatFileSize(item.fileSize) && <MetadataItem icon={<HardDrive />}>{formatFileSize(item.fileSize)}</MetadataItem>}
          </MetadataLine>
        }
        qualityBar={qualitySegments(
          // An artist row is stored against one of its tracks, whose codec
          // is not the artist's, so it draws no codec segment.
          isMusic && item.matchedEpisodes ? [] : qualityChips(item, isMusic ? "music" : "video"),
          getHex,
          (toggle) => show("badges", toggle),
        )}
        servers={showServers ? item.servers : undefined}
      />
    </div>
  );
});

function PreviewCardGrid({
  items,
  mediaType,
  onItemClick,
  diffMap,
  exceptedItemIds,
  show,
  showServers,
}: {
  items: PreviewItem[];
  mediaType: MediaType;
  onItemClick: (item: PreviewItem) => void;
  diffMap: Map<string, PreviewDiffStatus>;
  exceptedItemIds: Set<string>;
  show: (section: "badges" | "metadata", key: string) => boolean;
  showServers: boolean;
}) {
  const { columns } = useCardSize();
  const { getHex } = useChipColors();
  // The preview sits in the shell's <main>, under the rule editor.
  const grid = useVirtualPosterGrid({
    count: items.length,
    columns,
    aspect: mediaType === "MUSIC" ? SQUARE_ASPECT : POSTER_ASPECT,
    contentHeight: LIBRARY_CARD_CONTENT_HEIGHT,
    scrollElement: "main",
    overscan: 5,
  });

  const diffActive = diffMap.size > 0;
  const renderCard = useCallback(
    (item: PreviewItem, { priority }: GridCardContext) => (
      <PreviewCard
        item={item}
        mediaType={mediaType}
        priority={priority}
        diffStatus={diffMap.get(item.id)}
        diffActive={diffActive}
        excepted={exceptedItemIds.has(item.id)}
        onItemClick={onItemClick}
        show={show}
        getHex={getHex}
        showServers={showServers}
      />
    ),
    [mediaType, diffMap, diffActive, exceptedItemIds, onItemClick, show, getHex, showServers],
  );

  return <VirtualCardGrid grid={grid} items={items} getKey={previewKey} renderItem={renderCard} />;
}

const PREVIEW_VIEW_MODE_KEY = "lifecycle-preview-view-mode";

export interface RulePreviewSectionProps {
  items: PreviewItem[];
  mediaType: MediaType;
  /** Each row's change against the stored matches; empty for a new rule set. */
  diffMap: Map<string, PreviewDiffStatus>;
  diffCounts: PreviewDiffCounts | null;
  exceptedItemIds: Set<string>;
  /** Stable: the table and cards are memoised on it. */
  onItemClick: (item: PreviewItem) => void;
}

/**
 * The rule editor's Preview Results: the header with the diff counts, the
 * table/card toggle and the results themselves. Memoised and holding its own
 * sort and view state, so typing in the editor above (a name, a collection,
 * a pasted import) no longer re-renders a preview of thousands of rows.
 */
export const RulePreviewSection = memo(function RulePreviewSection({
  items,
  mediaType,
  diffMap,
  diffCounts,
  exceptedItemIds,
  onItemClick,
}: RulePreviewSectionProps) {
  const [sortBy, setSortBy] = useState<string | undefined>("title");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  // Read through the store (`useLocalStorage`): a lazy `useState` read of
  // localStorage threw in a private window and could not match the server's
  // render.
  const [viewMode, storeViewMode] = useLocalStorage<"cards" | "table">(PREVIEW_VIEW_MODE_KEY, "table");
  const { size: cardSize, setSize: setCardSize } = useCardSize();
  // One instance for the toggles and the cards, so a toggle reaches the cards.
  const { show: showCardField, showServers, setVisible: setCardFieldVisible, prefs: cardPrefs } = useCardDisplay(mediaType);

  const setViewMode = useCallback((mode: "cards" | "table") => {
    const scroller = findScrollContainer();
    const scrollTop = scroller?.scrollTop ?? 0;
    storeViewMode(mode);
    requestAnimationFrame(() => {
      scroller?.scrollTo({ top: scrollTop, behavior: "instant" });
    });
  }, [storeViewMode]);

  const handleSort = useCallback((field: string) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  }, [sortBy]);

  const sorted = useMemo(() => sortPreview(items, sortBy, sortOrder), [items, sortBy, sortOrder]);

  const renderHoverContent = useCallback(
    (item: PreviewItem) => previewHoverContent(item, mediaType, true),
    [mediaType],
  );

  const rowClassName = useMemo(() => {
    if (diffMap.size === 0) return undefined;
    return (item: PreviewItem) => {
      const status = diffMap.get(item.id);
      if (status === "added") return "border-l-2 border-l-emerald-500/70 bg-emerald-500/5";
      if (status === "removed") return "border-l-2 border-l-amber/70 bg-amber/5 opacity-60";
      return undefined;
    };
  }, [diffMap]);

  return (
    <TooltipProvider>
      <div className="mt-8">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <h2 className="text-xl font-bold font-display">
            Preview Results ({diffCounts ? diffCounts.added + diffCounts.retained : items.length} matches)
          </h2>
          {diffCounts && (diffCounts.added > 0 || diffCounts.removed > 0) && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">—</span>
              {diffCounts.added > 0 && (
                <ColorChip className="border-green/30 bg-green-dim text-green">
                  +{diffCounts.added} new
                </ColorChip>
              )}
              {diffCounts.retained > 0 && (
                <ColorChip className="border-border bg-muted/40 text-muted-foreground">
                  {diffCounts.retained} retained
                </ColorChip>
              )}
              {diffCounts.removed > 0 && (
                <ColorChip className="border-amber/30 bg-amber-dim text-amber">
                  -{diffCounts.removed} removed
                </ColorChip>
              )}
            </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border p-1 h-9">
              <button
                onClick={() => setViewMode("cards")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  viewMode === "cards"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
                title="Card view"
                aria-label="Card view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode("table")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  viewMode === "table"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
                title="Table view"
                aria-label="Table view"
              >
                <TableProperties className="h-4 w-4" />
              </button>
            </div>
            {viewMode === "cards" && (
              <>
                <CardSizeControl size={cardSize} onChange={setCardSize} />
                <CardDisplayControl
                  prefs={cardPrefs}
                  config={TOGGLE_CONFIGS.MOVIE}
                  onToggle={(section, key, visible) => setCardFieldVisible(section, key, visible)}
                />
              </>
            )}
          </div>
        </div>
        {viewMode === "table" ? (
          <MediaTable
            items={sorted}
            onItemClick={onItemClick}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={handleSort}
            mediaType={mediaType}
            exceptedItemIds={exceptedItemIds}
            renderHoverContent={renderHoverContent}
            rowClassName={rowClassName}
          />
        ) : (
          <PreviewCardGrid
            items={sorted}
            mediaType={mediaType}
            onItemClick={onItemClick}
            diffMap={diffMap}
            exceptedItemIds={exceptedItemIds}
            show={showCardField}
            showServers={showServers}
          />
        )}
      </div>
    </TooltipProvider>
  );
});
