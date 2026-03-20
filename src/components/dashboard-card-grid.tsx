"use client";

import { useCallback, useMemo } from "react";
import { useChipColors } from "@/components/chip-color-provider";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableCard } from "@/components/sortable-card";
import { StatsCards } from "@/components/stats-cards";
import { SyncStatus } from "@/components/sync-status";
import { QualityChart } from "@/components/quality-chart";
import { BreakdownChart } from "@/components/breakdown-chart";
import { TopPlayed } from "@/components/top-played";
import { RecentlyAdded } from "@/components/recently-added";
import {
  getCardDefinition,
  isCustomCardId,
  CUSTOM_CARD_DEFINITION,
  type CardEntry,
  type CustomCardConfig,
} from "@/lib/dashboard/card-registry";
import { CustomChartCard } from "@/components/custom-chart-card";

const CHANNEL_LABELS: Record<number, string> = {
  1: "Mono (1.0)",
  2: "Stereo (2.0)",
  3: "2.1",
  6: "5.1 Surround",
  8: "7.1 Surround",
};

function formatChannels(channels: number | null): string | null {
  if (channels == null) return null;
  return CHANNEL_LABELS[channels] ?? `${channels}ch`;
}

interface Stats {
  movieCount: number;
  seriesCount: number;
  seasonCount: number;
  musicCount: number;
  artistCount: number;
  albumCount: number;
  episodeCount: number;
  totalSize: string;
  movieSize: string;
  seriesSize: string;
  musicSize: string;
  movieDuration: number;
  seriesDuration: number;
  musicDuration: number;
  qualityBreakdown: {
    resolution: string | null;
    type: string;
    _count: number;
  }[];
  topMovies: {
    id: string;
    title: string;
    year: number | null;
    playCount: number;
  }[];
  topSeries: {
    parentTitle: string;
    totalPlays: number;
  }[];
  topMusic: {
    parentTitle: string;
    totalPlays: number;
    mediaItemId: string | null;
  }[];
  videoCodecBreakdown: {
    videoCodec: string | null;
    type: string;
    _count: number;
  }[];
  audioCodecBreakdown: {
    audioCodec: string | null;
    type: string;
    _count: number;
  }[];
  contentRatingBreakdown: {
    contentRating: string | null;
    type: string;
    _count: number;
  }[];
  dynamicRangeBreakdown: {
    dynamicRange: string | null;
    type: string;
    _count: number;
  }[];
  audioChannelsBreakdown: {
    audioChannels: number | null;
    type: string;
    _count: number;
  }[];
  genreBreakdown: {
    value: string | null;
    type: string;
    _count: number;
  }[];
}

interface DashboardCardGridProps {
  cards: CardEntry[];
  stats: Stats;
  editMode: boolean;
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  lockedFilterType?: boolean;
  serverId?: string;
  servers?: { id: string; name: string }[];
  availableTypes?: string[];
  onLayoutChange: (cards: CardEntry[]) => void;
  onMovieClick: (movieId: string) => void;
  onSeriesClick: (seriesName: string) => void;
  onArtistClick: (mediaItemId: string) => void;
  onSyncComplete: () => void;
  onConfigChange?: (cardId: string, config: CustomCardConfig) => void;
}

export function DashboardCardGrid({
  cards,
  stats,
  editMode,
  filterType,
  lockedFilterType,
  serverId,
  servers,
  availableTypes,
  onLayoutChange,
  onMovieClick,
  onSeriesClick,
  onArtistClick,
  onSyncComplete,
  onConfigChange,
}: DashboardCardGridProps) {
  const { colors: chipColors } = useChipColors();

  // Build hex color maps for breakdown charts from chip color context
  const dynamicRangeHex = useMemo(() => chipColors.dynamicRange, [chipColors.dynamicRange]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = cards.findIndex((c) => c.id === active.id);
      const newIndex = cards.findIndex((c) => c.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onLayoutChange(arrayMove(cards, oldIndex, newIndex));
    },
    [cards, onLayoutChange]
  );

  const handleRemove = useCallback(
    (cardId: string) => {
      onLayoutChange(cards.filter((c) => c.id !== cardId));
    },
    [cards, onLayoutChange]
  );

  const handleResize = useCallback(
    (cardId: string, newSize: number) => {
      onLayoutChange(
        cards.map((c) => (c.id === cardId ? { ...c, size: newSize } : c))
      );
    },
    [cards, onLayoutChange]
  );

  const handleHeightResize = useCallback(
    (cardId: string, newHeight: number) => {
      onLayoutChange(
        cards.map((c) => (c.id === cardId ? { ...c, heightPx: newHeight } : c))
      );
    },
    [cards, onLayoutChange]
  );

  const handleHeightReset = useCallback(
    (cardId: string) => {
      onLayoutChange(
        cards.map((c) =>
          c.id === cardId ? { id: c.id, size: c.size, ...(c.config && { config: c.config }) } : c
        )
      );
    },
    [cards, onLayoutChange]
  );

  const noMusicTypes = availableTypes?.filter((t) => t !== "MUSIC");

  function renderCard(cardId: string, config?: CustomCardConfig) {
    if (isCustomCardId(cardId) && config) {
      return (
        <CustomChartCard
          config={config}
          filterType={filterType}
          lockedFilterType={lockedFilterType}
          serverId={serverId}
          availableTypes={availableTypes}
          onEditConfig={onConfigChange ? (newConfig) => onConfigChange(cardId, newConfig) : undefined}
        />
      );
    }

    switch (cardId) {
      case "stats":
        return <StatsCards stats={stats} availableTypes={availableTypes} />;
      case "sync-status":
        return <SyncStatus onSyncComplete={onSyncComplete} />;
      case "quality-breakdown":
        return (
          <QualityChart
            breakdown={stats.qualityBreakdown.filter((b) => b.type !== "MUSIC")}
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={noMusicTypes}
          />
        );
      case "video-codec":
        return (
          <BreakdownChart
            title="Video Codec Breakdown"
            breakdown={stats.videoCodecBreakdown
              .filter((b) => b.type !== "MUSIC")
              .map((b) => ({
                value: b.videoCodec,
                type: b.type,
                _count: b._count,
              }))}
            nullLabel="Unknown"
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={noMusicTypes}
          />
        );
      case "audio-codec":
        return (
          <BreakdownChart
            title="Audio Codec Breakdown"
            breakdown={stats.audioCodecBreakdown.map((b) => ({
              value: b.audioCodec,
              type: b.type,
              _count: b._count,
            }))}
            nullLabel="Unknown"
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={availableTypes}
          />
        );
      case "content-rating":
        return (
          <BreakdownChart
            title="Content Rating Breakdown"
            breakdown={stats.contentRatingBreakdown
              .filter((b) => b.type !== "MUSIC")
              .map((b) => ({
                value: b.contentRating,
                type: b.type,
                _count: b._count,
              }))}
            nullLabel="Not Rated"
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={noMusicTypes}
          />
        );
      case "top-played":
        return (
          <TopPlayed
            topMovies={stats.topMovies ?? []}
            topSeries={stats.topSeries ?? []}
            topMusic={stats.topMusic ?? []}
            filterType={filterType}
            onMovieClick={onMovieClick}
            onSeriesClick={onSeriesClick}
            onArtistClick={onArtistClick}
          />
        );
      case "dynamic-range":
        return (
          <BreakdownChart
            title="Dynamic Range Breakdown"
            breakdown={(stats.dynamicRangeBreakdown ?? [])
              .filter((b) => b.type !== "MUSIC")
              .map((b) => ({
                value: b.dynamicRange,
                type: b.type,
                _count: b._count,
              }))}
            nullLabel="Unknown"
            hexColors={dynamicRangeHex}
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={noMusicTypes}
          />
        );
      case "audio-channels":
        return (
          <BreakdownChart
            title="Audio Channels Breakdown"
            breakdown={(stats.audioChannelsBreakdown ?? []).map((b) => ({
              value: formatChannels(b.audioChannels),
              type: b.type,
              _count: b._count,
            }))}
            nullLabel="Unknown"
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={availableTypes}
          />
        );
      case "genre":
        return (
          <BreakdownChart
            title="Genre Breakdown"
            breakdown={stats.genreBreakdown ?? []}
            nullLabel="Unknown"
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={availableTypes}
            labelTransform={(v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()}
          />
        );
      case "recently-added":
        return (
          <RecentlyAdded
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            serverId={serverId}
            servers={servers}
            availableTypes={availableTypes}
            onMovieClick={onMovieClick}
            onSeriesClick={onSeriesClick}
          />
        );
      default:
        return null;
    }
  }

  const cardIds = cards.map((c) => c.id);

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={cardIds}
          strategy={rectSortingStrategy}
        >
          {cards.map((card) => {
            const isCustom = isCustomCardId(card.id);
            const def = isCustom ? CUSTOM_CARD_DEFINITION : getCardDefinition(card.id);
            return (
              <SortableCard
                key={card.id}
                id={card.id}
                size={card.size}
                heightPx={card.heightPx}
                minSize={def?.minSize ?? 2}
                maxSize={def?.maxSize ?? 12}
                editMode={editMode}
                onRemove={() => handleRemove(card.id)}
                onResize={(newSize) => handleResize(card.id, newSize)}
                onHeightResize={(newHeight) => handleHeightResize(card.id, newHeight)}
                onHeightReset={() => handleHeightReset(card.id)}
              >
                {renderCard(card.id, card.config)}
              </SortableCard>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
