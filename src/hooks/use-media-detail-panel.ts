"use client";

import { useCallback, useRef, useState } from "react";
import { usePanelResize } from "@/hooks/use-panel-resize";
import {
  buildDetailPanelItem,
  type DetailPanelGroup,
  type DetailPanelMediaType,
} from "@/lib/media/detail-panel-item";
import type { MatchedCriterion } from "@/components/media-detail-side-panel";
import type { BaseGroup, BaseRule, BuilderConfig } from "@/components/builder/types";
import type { MediaItemWithRelations } from "@/lib/types";

/** One width for the panel everywhere it opens, remembered across pages. */
export const MEDIA_DETAIL_PANEL_WIDTH_KEY = "media-detail-panel-width";

export interface OpenMediaDetailPanel {
  /** The media item the row is stored against. */
  id: string;
  mediaType: DetailPanelMediaType;
  /**
   * A row complete enough to render while the record loads (a stored match
   * snapshot, a query or preview row). Without one the panel opens once the
   * record is in.
   */
  seed?: MediaItemWithRelations;
  /** The group a grouped row stands for — see `DetailPanelGroup`. */
  group?: DetailPanelGroup;
  /** Header title override, e.g. a lifecycle action's target. */
  title?: string;
  /** Lifecycle criteria the item matched, with the values it matched on. */
  matchedCriteria?: MatchedCriterion[];
  actualValues?: Record<string, string>;
  /** The rule set's rules, for the Logic Preview the matched rules light up in. */
  ruleGroups?: BaseGroup<BaseRule>[];
  builderConfig?: BuilderConfig<BaseRule, BaseGroup<BaseRule>>;
}

export interface MediaDetailPanelSelection {
  item: MediaItemWithRelations;
  mediaType: DetailPanelMediaType;
  title?: string;
  matchedCriteria?: MatchedCriterion[];
  allActualValues?: Record<string, string>;
  ruleGroups?: BaseGroup<BaseRule>[];
  builderConfig?: BuilderConfig<BaseRule, BaseGroup<BaseRule>>;
}

/**
 * The media detail side panel's state, shared by every page that opens it:
 * the width (one remembered value), the selection, and how the item is
 * loaded — always the current `/api/media/[id]` record, with a grouped row's
 * figures laid over it, and a slower response for an earlier click never
 * replacing a later one.
 */
export function useMediaDetailPanel() {
  const { width, resizeHandleProps } = usePanelResize({
    storageKey: MEDIA_DETAIL_PANEL_WIDTH_KEY,
    defaultWidth: 480,
    minWidth: 360,
    maxWidth: 800,
  });
  const [selection, setSelection] = useState<MediaDetailPanelSelection | null>(null);
  const [loading, setLoading] = useState(false);
  const reqToken = useRef(0);

  const close = useCallback(() => {
    ++reqToken.current;
    setLoading(false);
    setSelection(null);
  }, []);

  const open = useCallback(async (request: OpenMediaDetailPanel) => {
    const token = ++reqToken.current;
    const base = {
      mediaType: request.mediaType,
      title: request.title,
      matchedCriteria: request.matchedCriteria,
      allActualValues: request.actualValues,
      ruleGroups: request.ruleGroups,
      builderConfig: request.builderConfig,
    };
    if (request.seed) {
      setSelection({ ...base, item: buildDetailPanelItem(request.seed, request.group) });
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/media/${request.id}`);
      if (token !== reqToken.current || !response.ok) return;
      const data = await response.json();
      if (token !== reqToken.current) return;
      const record: MediaItemWithRelations | undefined = data.item ?? data;
      if (!record?.id) return;
      // A grouped row knows which servers hold the GROUP; the record only
      // knows its own copy's.
      const merged = request.seed?.servers ? { ...record, servers: request.seed.servers } : record;
      setSelection({ ...base, item: buildDetailPanelItem(merged, request.group) });
    } catch (error) {
      console.error("Failed to fetch media item:", error);
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, []);

  const panelProps = selection
    ? { ...selection, onClose: close, width, resizeHandleProps }
    : null;

  return { open, close, loading, selectedId: selection?.item.id ?? null, panelProps };
}
