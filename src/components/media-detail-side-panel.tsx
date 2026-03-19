"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaDetailContent } from "@/components/media-detail-content";
import { FadeImage } from "@/components/ui/fade-image";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useChipColors } from "@/components/chip-color-provider";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { formatFileSize, formatDuration } from "@/lib/format";
import { PseudocodePanel } from "@/components/builder/pseudocode-panel";
import type { BaseRule, BaseGroup, BuilderConfig } from "@/components/builder/types";
import type { MediaItemWithRelations } from "@/lib/types";

interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onDoubleClick: () => void;
}

export interface MatchedCriterion {
  ruleId: string;
  field: string;
  operator: string;
  value: string;
  negate: boolean;
  groupName?: string;
  actualValue?: string;
}

interface MediaDetailSidePanelProps {
  item: MediaItemWithRelations;
  mediaType: "MOVIE" | "SERIES" | "MUSIC";
  onClose: () => void;
  width: number;
  resizeHandleProps: ResizeHandleProps;
  /** Override the default detail page URL (e.g. for grouped series/music items) */
  detailUrl?: string;
  /** Matched criteria from lifecycle rules (displayed above cast) */
  matchedCriteria?: MatchedCriterion[];
  /** Rule groups for Logic Preview with highlighting */
  ruleGroups?: BaseGroup<BaseRule>[];
  /** Builder config for generating pseudocode */
  builderConfig?: BuilderConfig<BaseRule, BaseGroup<BaseRule>>;
  /** Actual item values for ALL rules (ruleId → value), shown as tooltips in Logic Preview */
  allActualValues?: Record<string, string>;
  /** Diff status for preview highlighting (added/removed/retained) */
  diffStatus?: "added" | "removed" | "retained";
}

function getDetailPageUrl(mediaType: string, itemId: string): string {
  const prefix =
    mediaType === "MOVIE"
      ? "/library/movies"
      : mediaType === "SERIES"
        ? "/library/series/episode"
        : "/library/music/track";
  return `${prefix}/${itemId}`;
}

function formatResolution(resolution: string | null): string {
  if (!resolution) return "";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

export function MediaDetailSidePanel({
  item,
  mediaType,
  onClose,
  width,
  resizeHandleProps,
  detailUrl: detailUrlOverride,
  matchedCriteria,
  ruleGroups,
  builderConfig,
  allActualValues,
}: MediaDetailSidePanelProps) {
  const isMobile = useIsMobile();
  const { getBadgeStyle } = useChipColors();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const highlightedRuleIds = useMemo(() => {
    if (!matchedCriteria) return undefined;
    return new Set(matchedCriteria.map((c) => c.ruleId));
  }, [matchedCriteria]);

  const actualValues = useMemo(() => {
    // Prefer allActualValues (covers all rules) over matchedCriteria (matched only)
    if (allActualValues && Object.keys(allActualValues).length > 0) {
      return new Map(Object.entries(allActualValues));
    }
    if (!matchedCriteria) return undefined;
    const map = new Map<string, string>();
    for (const c of matchedCriteria) {
      if (c.actualValue) map.set(c.ruleId, c.actualValue);
    }
    return map.size > 0 ? map : undefined;
  }, [allActualValues, matchedCriteria]);

  const isAggregate = !!item.matchedEpisodes;
  const detailUrl = detailUrlOverride ?? getDetailPageUrl(mediaType, item.id);
  // Aggregated items (series/artist scope) use parentTitle=null but still need the parent image
  const imageUrl = `/api/media/${item.id}/image${item.parentTitle || isAggregate ? "?type=parent" : ""}`;
  const displayTitle = item.parentTitle
    ? `${item.parentTitle} - ${item.title}`
    : item.title;
  const resolutionLabel = formatResolution(item.resolution);

  const header = (
    <div className="border-b shrink-0">
      {/* Close / Open full page buttons */}
      <div className="flex items-center justify-end gap-1 px-3 pt-3">
        <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
          <Link href={detailUrl}>
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="sr-only">Open full page</span>
          </Link>
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {/* Centered artwork */}
      <div className="flex justify-center px-4 pb-3">
        <div className="w-36 h-54 rounded-lg overflow-hidden bg-muted shadow-lg" style={{ aspectRatio: mediaType === "MUSIC" ? "1/1" : "2/3" }}>
          <FadeImage
            src={imageUrl}
            alt={displayTitle}
            className="w-full h-full object-cover"
          />
        </div>
      </div>

      {/* Title + metadata */}
      <div className="text-center px-4 pb-4 space-y-2">
        <h3 className="font-semibold text-base leading-tight line-clamp-2">
          {displayTitle}
        </h3>
        {isAggregate ? (
          <p className="text-xs text-muted-foreground">
            {[
              item.matchedEpisodes && `${item.matchedEpisodes} ${mediaType === "MUSIC" ? "tracks" : "episodes"}`,
              item.fileSize ? formatFileSize(item.fileSize) : null,
              item.playCount > 0 ? `${item.playCount} plays` : null,
            ].filter(Boolean).join(" \u00b7 ")}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {[
                item.year,
                item.duration ? formatDuration(item.duration) : null,
                item.fileSize ? formatFileSize(item.fileSize) : null,
              ].filter(Boolean).join(" \u00b7 ")}
            </p>

            {/* Quality chips */}
            <div className="flex flex-wrap justify-center gap-1.5">
              {resolutionLabel && (
                <Badge variant="secondary" className="text-xs" style={getBadgeStyle("resolution", resolutionLabel)}>
                  {resolutionLabel}
                </Badge>
              )}
              {item.dynamicRange && (
                <Badge variant="secondary" className="text-xs" style={getBadgeStyle("dynamicRange", item.dynamicRange)}>
                  {item.dynamicRange}
                </Badge>
              )}
              {item.audioProfile && (
                <Badge variant="secondary" className="text-xs" style={getBadgeStyle("audioProfile", item.audioProfile)}>
                  {item.audioProfile}
                </Badge>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const matchedCriteriaSection = matchedCriteria && matchedCriteria.length > 0 ? (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Matched Criteria</h4>
      <div className="flex flex-wrap gap-1.5">
        {matchedCriteria.map((criterion, i) => {
          const badge = (
            <Badge
              key={i}
              variant="outline"
              className={`text-xs ${criterion.negate ? "border-red-500/30 text-red-400" : ""}`}
            >
              {criterion.groupName && (
                <span className="text-blue-400 mr-1">[{criterion.groupName}]</span>
              )}
              {criterion.negate && <span className="text-red-400 mr-1">NOT</span>}
              {criterion.field} {criterion.operator} {criterion.value}
            </Badge>
          );
          if (criterion.actualValue) {
            return (
              <TooltipProvider key={i}>
                <Tooltip>
                  <TooltipTrigger asChild>{badge}</TooltipTrigger>
                  <TooltipContent>Actual: {criterion.actualValue}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          }
          return badge;
        })}
      </div>
    </div>
  ) : null;

  const logicPreviewSection = ruleGroups && builderConfig ? (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Logic Preview</h4>
      <PseudocodePanel
        groups={ruleGroups}
        config={builderConfig}
        highlightedRuleIds={highlightedRuleIds}
        actualValues={actualValues}
      />
    </div>
  ) : null;

  const combinedMatchSection = (matchedCriteriaSection || logicPreviewSection) ? (
    <div className="space-y-4">
      {matchedCriteriaSection}
      {logicPreviewSection}
    </div>
  ) : null;

  const content = (
    <div className="flex-1 overflow-y-auto p-4">
      <MediaDetailContent item={item} hideVideo={mediaType === "MUSIC"} compact isAggregate={isAggregate} matchedCriteriaSection={combinedMatchSection} />
    </div>
  );

  // Mobile: full-screen overlay
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        {header}
        {content}
      </div>
    );
  }

  // Desktop: side panel with resize handle
  return (
    <div
      className="relative border-l bg-background flex flex-col h-full overflow-hidden shrink-0"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-label="Resize panel"
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-20 hover:bg-primary/50 active:bg-primary transition-colors touch-none"
        onMouseDown={resizeHandleProps.onMouseDown}
        onTouchStart={resizeHandleProps.onTouchStart}
        onDoubleClick={resizeHandleProps.onDoubleClick}
      />
      {header}
      {content}
    </div>
  );
}
