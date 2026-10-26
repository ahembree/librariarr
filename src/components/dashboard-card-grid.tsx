"use client";

import { createContext, useContext, useMemo } from "react";
import { useChipColors } from "@/components/chip-color-provider";
import { StaticDashboardCard } from "@/components/dashboard-card-cell";
import { StatsCards } from "@/components/stats-cards";
import { SyncStatus } from "@/components/sync-status";
import { QualityChart } from "@/components/quality-chart";
import { BreakdownChart } from "@/components/breakdown-chart";
import { TopPlayed } from "@/components/top-played";
import { RecentlyAdded } from "@/components/recently-added";
import { SeerrRequestStats } from "@/components/seerr-request-stats";
import {
  getCardDefinition,
  isCustomCardId,
  CUSTOM_CARD_DEFINITION,
  type CardEntry,
  type CustomCardConfig,
} from "@/lib/dashboard/card-registry";
import { lazyComponent } from "@/components/lazy-component";
import { CustomCardSlot } from "@/components/dashboard/custom-card-slot";
import { formatChannels } from "@/lib/format";

/** What the grid draws while the edit-mode grid's code loads: the cards as they were. */
const StaticGridContext = createContext<{ cards: CardEntry[]; renderCard: (card: CardEntry) => React.ReactNode } | null>(null);

function StaticCards({ cards, renderCard }: { cards: CardEntry[]; renderCard: (card: CardEntry) => React.ReactNode }) {
  return (
    <>
      {cards.map((card) => (
        <StaticDashboardCard key={card.id} size={card.size} heightPx={card.heightPx}>
          {renderCard(card)}
        </StaticDashboardCard>
      ))}
    </>
  );
}

function StaticCardsFallback() {
  const grid = useContext(StaticGridContext);
  return grid ? <StaticCards {...grid} /> : null;
}

// Loaded on demand: drag-and-drop is needed only while customizing, and
// imported here the library (~55 KB of minified script) loaded with every
// dashboard.
// Until it arrives the cards stay as they are.
const SortableCardGrid = lazyComponent(
  () => import("@/components/sortable-card-grid").then((m) => m.SortableCardGrid),
  StaticCardsFallback,
);

function cardLimits(card: CardEntry): { minSize: number; maxSize: number } {
  const def = isCustomCardId(card.id) ? CUSTOM_CARD_DEFINITION : getCardDefinition(card.id);
  return { minSize: def?.minSize ?? 2, maxSize: def?.maxSize ?? 12 };
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
    mediaItemId: string | null;
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
  servers?: { id: string; name: string; type?: string }[];
  availableTypes?: string[];
  onLayoutChange: (cards: CardEntry[]) => void;
  onMovieClick: (movieId: string) => void;
  onSeriesClick: (seriesName: string) => void;
  onArtistClick: (mediaItemId: string) => void;
  onEpisodeClick: (episodeId: string) => void;
  onTrackClick: (trackId: string) => void;
  onSeasonClick?: (mediaItemId: string) => void;
  onAlbumClick?: (mediaItemId: string) => void;
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
  onEpisodeClick,
  onTrackClick,
  onSeasonClick,
  onAlbumClick,
  onConfigChange,
}: DashboardCardGridProps) {
  const { colors: chipColors } = useChipColors();

  // Build hex color maps for breakdown charts from chip color context
  const dynamicRangeHex = useMemo(() => chipColors.dynamicRange, [chipColors.dynamicRange]);
  const audioCodecHex = useMemo(() => chipColors.audioCodec, [chipColors.audioCodec]);

  const noMusicTypes = availableTypes?.filter((t) => t !== "MUSIC");

  function renderCard(cardId: string, config?: CustomCardConfig) {
    if (isCustomCardId(cardId) && config) {
      return (
        <CustomCardSlot
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
        // The stats refresh during and after a sync is the page's own.
        return <SyncStatus />;
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
            icon={getCardDefinition("video-codec")?.icon}
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
            icon={getCardDefinition("audio-codec")?.icon}
            breakdown={stats.audioCodecBreakdown.map((b) => ({
              value: b.audioCodec,
              type: b.type,
              _count: b._count,
            }))}
            nullLabel="Unknown"
            // Codecs are upper-cased by the default label transform, which is
            // how the chip-colour keys are spelled.
            hexColors={audioCodecHex}
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={availableTypes}
          />
        );
      case "content-rating":
        return (
          <BreakdownChart
            title="Content Rating Breakdown"
            icon={getCardDefinition("content-rating")?.icon}
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
            icon={getCardDefinition("dynamic-range")?.icon}
            breakdown={(stats.dynamicRangeBreakdown ?? [])
              .filter((b) => b.type !== "MUSIC")
              .map((b) => ({
                value: b.dynamicRange,
                type: b.type,
                _count: b._count,
              }))}
            nullLabel="Unknown"
            hexColors={dynamicRangeHex}
            // Dynamic-range values are normalized at sync time ("Dolby
            // Vision", "HDR10+", …) and the chip-color keys match them
            // case-sensitively — the default toUpperCase transform would
            // break the lookup (and shout "DOLBY VISION").
            labelTransform={(v) => v}
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={noMusicTypes}
          />
        );
      case "audio-channels":
        return (
          <BreakdownChart
            title="Audio Channels Breakdown"
            icon={getCardDefinition("audio-channels")?.icon}
            breakdown={(stats.audioChannelsBreakdown ?? []).map((b) => ({
              value: b.audioChannels == null ? null : formatChannels(b.audioChannels, { verbose: true }),
              type: b.type,
              _count: b._count,
            }))}
            nullLabel="Unknown"
            // formatChannels already returns display labels ("Stereo (2.0)");
            // the default upper-casing would shout them.
            labelTransform={(v) => v}
            filterType={filterType}
            lockedFilterType={lockedFilterType}
            availableTypes={availableTypes}
          />
        );
      case "genre":
        return (
          <BreakdownChart
            title="Genre Breakdown"
            icon={getCardDefinition("genre")?.icon}
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
            onEpisodeClick={onEpisodeClick}
            onTrackClick={onTrackClick}
            onSeasonClick={onSeasonClick}
            onAlbumClick={onAlbumClick}
          />
        );
      case "seerr-requests":
        return <SeerrRequestStats />;
      default:
        return null;
    }
  }

  const renderEntry = (card: CardEntry) => renderCard(card.id, card.config);

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
      {editMode ? (
        <StaticGridContext.Provider value={{ cards, renderCard: renderEntry }}>
          <SortableCardGrid
            cards={cards}
            limitsOf={cardLimits}
            renderCard={renderEntry}
            onLayoutChange={onLayoutChange}
          />
        </StaticGridContext.Provider>
      ) : (
        <StaticCards cards={cards} renderCard={renderEntry} />
      )}
    </div>
  );
}
