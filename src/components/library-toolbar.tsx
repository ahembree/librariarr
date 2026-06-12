"use client";

import { cn } from "@/lib/utils";
import { LayoutGrid, TableProperties, ArrowUpDown, ArrowDownAZ, ArrowUpZA } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CardSizeControl } from "@/components/card-size-control";
import { CardDisplayControl } from "@/components/card-display-control";
import { ServerFilter } from "@/components/server-filter";
import type { CardSize } from "@/hooks/use-card-size";
import type { CardDisplayPreferences, ToggleConfig } from "@/hooks/use-card-display";

interface SortOption {
  value: string;
  label: string;
}

interface ServerInfo {
  id: string;
  name: string;
  type?: string;
}

export interface LibraryToolbarProps {
  /** Current view mode */
  viewMode: "cards" | "table";
  /** Callback when view mode changes */
  onViewModeChange: (mode: "cards" | "table") => void;
  /** Card size (only used in cards mode) */
  cardSize?: CardSize;
  /** Callback when card size changes */
  onCardSizeChange?: (size: CardSize) => void;
  /** Card display preferences (only used in cards mode) */
  cardDisplayPrefs?: CardDisplayPreferences;
  /** Card display toggle config */
  cardDisplayConfig?: ToggleConfig;
  /** Callback when card display toggle changes */
  onCardDisplayToggle?: (section: "badges" | "metadata" | "servers", key: string, visible: boolean) => void;
  /** Available servers for filtering */
  servers?: ServerInfo[];
  /** Currently selected server ID */
  selectedServerId?: string;
  /** Callback when server selection changes */
  onServerChange?: (serverId: string) => void;
  /** Sort options */
  sortOptions?: SortOption[];
  /** Current sort field */
  sortBy?: string;
  /** Current sort order */
  sortOrder?: "asc" | "desc";
  /** Callback when sort field changes */
  onSortChange?: (field: string) => void;
  /** Callback when sort order toggles */
  onSortOrderToggle?: () => void;
  /** Additional controls to render at the end */
  children?: React.ReactNode;
}

/**
 * Standardized toolbar for library pages.
 * Renders: [ServerFilter] [ViewToggle] [CardSize] [CardDisplay] [Sort] [children]
 * Designed to be used as the `prefix` prop of MediaFilters.
 */
export function LibraryToolbar({
  viewMode,
  onViewModeChange,
  cardSize,
  onCardSizeChange,
  cardDisplayPrefs,
  cardDisplayConfig,
  onCardDisplayToggle,
  servers,
  selectedServerId,
  onServerChange,
  sortOptions,
  sortBy,
  sortOrder,
  onSortChange,
  onSortOrderToggle,
  children,
}: LibraryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      {/* Server filter */}
      {servers && selectedServerId && onServerChange && (
        <ServerFilter
          servers={servers}
          value={selectedServerId}
          onChange={onServerChange}
        />
      )}

      {/* View toggle — active uses the brand accent (handoff "accent when on") */}
      <div className="flex h-9 items-center gap-1 rounded-lg border p-1">
        <button
          onClick={() => onViewModeChange("cards")}
          className={cn(
            "rounded-md p-1.5 transition-colors",
            viewMode === "cards"
              ? "bg-brand-dim text-brand-bright"
              : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
          )}
          title="Card view"
          aria-label="Card view"
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
        <button
          onClick={() => onViewModeChange("table")}
          className={cn(
            "rounded-md p-1.5 transition-colors",
            viewMode === "table"
              ? "bg-brand-dim text-brand-bright"
              : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
          )}
          title="Table view"
          aria-label="Table view"
        >
          <TableProperties className="h-4 w-4" />
        </button>
      </div>

      {/* Card-only controls */}
      {viewMode === "cards" && (
        <>
          {cardSize && onCardSizeChange && (
            <CardSizeControl size={cardSize} onChange={onCardSizeChange} />
          )}
          {cardDisplayPrefs && cardDisplayConfig && onCardDisplayToggle && (
            <CardDisplayControl prefs={cardDisplayPrefs} config={cardDisplayConfig} onToggle={onCardDisplayToggle} />
          )}
        </>
      )}

      {/* Sort controls — one cohesive group */}
      {sortOptions && sortBy && onSortChange && onSortOrderToggle && (
        <div className="flex min-w-0 items-center">
          <Select value={sortBy} onValueChange={onSortChange}>
            <SelectTrigger className="w-full rounded-r-none border-r-0 sm:w-36">
              <ArrowUpDown className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="rounded-l-none"
            onClick={onSortOrderToggle}
            title={sortOrder === "asc" ? "Ascending" : "Descending"}
            aria-label={sortOrder === "asc" ? "Sorted ascending" : "Sorted descending"}
          >
            {sortOrder === "asc" ? (
              <ArrowDownAZ className="h-4 w-4" />
            ) : (
              <ArrowUpZA className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}

      {/* Extra controls */}
      {children}
    </div>
  );
}
