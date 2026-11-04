"use client";

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useChipColors } from "@/components/chip-color-provider";
import { CARD_HOST_CLASS, StaticDashboardCard } from "@/components/dashboard-card-cell";
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
import { sameCardDisplay, type CardDisplay } from "@/lib/dashboard/card-display";
import { lazyComponent } from "@/components/lazy-component";
import { CustomCardSlot } from "@/components/dashboard/custom-card-slot";
import { formatChannels } from "@/lib/format";

/**
 * The DOM node each card's content renders into (through a portal) for as
 * long as the card is on the grid. A cell — plain, or the layout editor's
 * frame — only holds it, so entering or leaving the editor moves the node
 * into the new cell instead of re-creating the card: the card keeps its own
 * state and its data. (Re-created, every card fetched again and lost what its
 * own controls had set, on every Customize and Done.)
 */
class CardHosts {
  private readonly hosts = new Map<string, HTMLDivElement>();

  get(id: string): HTMLDivElement | null {
    if (typeof document === "undefined") return null;
    let host = this.hosts.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = CARD_HOST_CLASS;
      this.hosts.set(id, host);
    }
    return host;
  }

  /** Forget the hosts of cards no longer on the grid (a card added again starts afresh). */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of [...this.hosts.keys()]) if (!ids.has(id)) this.hosts.delete(id);
  }
}

/** Where a card's host sits in a cell: moved in on mount, never re-created. */
function CardSlot({ host }: { host: HTMLDivElement | null }) {
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && host && host.parentNode !== el) el.appendChild(host);
    },
    [host],
  );
  return <div ref={attach} className="contents" />;
}

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

type MediaType = "MOVIE" | "SERIES" | "MUSIC";

interface DashboardCardGridProps {
  cards: CardEntry[];
  stats: Stats;
  editMode: boolean;
  filterType?: MediaType;
  lockedFilterType?: boolean;
  serverId?: string;
  servers?: { id: string; name: string; type?: string }[];
  availableTypes?: string[];
  onLayoutChange: (cards: CardEntry[]) => void;
  /** A card's display choices changed (saved with the layout). */
  onDisplayChange?: (cardId: string, display: CardDisplay | undefined) => void;
  /** A card was removed in the editor; without it the card is simply dropped from the layout. */
  onCardRemove?: (cardId: string) => void;
  onMovieClick: (movieId: string) => void;
  onSeriesClick: (seriesName: string) => void;
  onArtistClick: (mediaItemId: string) => void;
  onEpisodeClick: (episodeId: string) => void;
  onTrackClick: (trackId: string) => void;
  onSeasonClick?: (mediaItemId: string) => void;
  onAlbumClick?: (mediaItemId: string) => void;
  onConfigChange?: (cardId: string, config: CustomCardConfig) => void;
}

/** Everything a card's content reads besides its own entry, built once per change of any of it. */
type CardContext = Omit<DashboardCardGridProps, "cards" | "editMode" | "onLayoutChange" | "onCardRemove"> & {
  noMusicTypes?: string[];
  dynamicRangeHex: Record<string, string>;
  audioCodecHex: Record<string, string>;
};

function renderCard(card: CardEntry, ctx: CardContext): React.ReactNode {
  const {
    stats, filterType, lockedFilterType, serverId, servers, availableTypes, noMusicTypes,
    dynamicRangeHex, audioCodecHex, onConfigChange,
  } = ctx;
  const display = card.display;
  const onDisplayChange = ctx.onDisplayChange
    ? (next: CardDisplay | undefined) => ctx.onDisplayChange?.(card.id, next)
    : undefined;

  if (isCustomCardId(card.id) && card.config) {
    return (
      <CustomCardSlot
        config={card.config}
        filterType={filterType}
        lockedFilterType={lockedFilterType}
        serverId={serverId}
        availableTypes={availableTypes}
        onEditConfig={onConfigChange ? (newConfig) => onConfigChange(card.id, newConfig) : undefined}
        display={display}
        onDisplayChange={onDisplayChange}
      />
    );
  }

  const breakdownProps = { filterType, lockedFilterType, display, onDisplayChange };

  switch (card.id) {
    case "stats":
      return <StatsCards stats={stats} availableTypes={availableTypes} />;
    case "sync-status":
      // The stats refresh during and after a sync is the page's own.
      return <SyncStatus />;
    case "quality-breakdown":
      return (
        <QualityChart
          breakdown={stats.qualityBreakdown.filter((b) => b.type !== "MUSIC")}
          availableTypes={noMusicTypes}
          {...breakdownProps}
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
          availableTypes={noMusicTypes}
          {...breakdownProps}
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
          availableTypes={availableTypes}
          {...breakdownProps}
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
          availableTypes={noMusicTypes}
          {...breakdownProps}
        />
      );
    case "top-played":
      return (
        <TopPlayed
          topMovies={stats.topMovies ?? []}
          topSeries={stats.topSeries ?? []}
          topMusic={stats.topMusic ?? []}
          filterType={filterType}
          onMovieClick={ctx.onMovieClick}
          onSeriesClick={ctx.onSeriesClick}
          onArtistClick={ctx.onArtistClick}
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
          availableTypes={noMusicTypes}
          {...breakdownProps}
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
          availableTypes={availableTypes}
          {...breakdownProps}
        />
      );
    case "genre":
      return (
        <BreakdownChart
          title="Genre Breakdown"
          icon={getCardDefinition("genre")?.icon}
          breakdown={stats.genreBreakdown ?? []}
          nullLabel="Unknown"
          availableTypes={availableTypes}
          labelTransform={(v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()}
          {...breakdownProps}
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
          onMovieClick={ctx.onMovieClick}
          onEpisodeClick={ctx.onEpisodeClick}
          onTrackClick={ctx.onTrackClick}
          onSeasonClick={ctx.onSeasonClick}
          onAlbumClick={ctx.onAlbumClick}
        />
      );
    case "seerr-requests":
      return <SeerrRequestStats />;
    default:
      return null;
  }
}

/**
 * One card's content. Redrawn only when what it shows changes — the shared
 * context, or its own config or display choices — not when the card is moved
 * or resized, the editor opens, or a drag's marker moves (each of which
 * redrew every chart on the grid).
 */
const CardBody = memo(
  function CardBody({ card, ctx }: { card: CardEntry; ctx: CardContext }) {
    return renderCard(card, ctx);
  },
  (prev, next) =>
    prev.ctx === next.ctx &&
    prev.card.id === next.card.id &&
    sameCardDisplay(prev.card.display, next.card.display) &&
    (prev.card.config === next.card.config || JSON.stringify(prev.card.config) === JSON.stringify(next.card.config)),
);

export const DashboardCardGrid = memo(function DashboardCardGrid({
  cards,
  stats,
  editMode,
  filterType,
  lockedFilterType,
  serverId,
  servers,
  availableTypes,
  onLayoutChange,
  onDisplayChange,
  onCardRemove,
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
  const dynamicRangeHex = chipColors.dynamicRange;
  const audioCodecHex = chipColors.audioCodec;

  const ctx = useMemo<CardContext>(
    () => ({
      stats, filterType, lockedFilterType, serverId, servers, availableTypes,
      noMusicTypes: availableTypes?.filter((t) => t !== "MUSIC"),
      dynamicRangeHex, audioCodecHex,
      onDisplayChange, onMovieClick, onSeriesClick, onArtistClick, onEpisodeClick, onTrackClick,
      onSeasonClick, onAlbumClick, onConfigChange,
    }),
    [
      stats, filterType, lockedFilterType, serverId, servers, availableTypes, dynamicRangeHex, audioCodecHex,
      onDisplayChange, onMovieClick, onSeriesClick, onArtistClick, onEpisodeClick, onTrackClick,
      onSeasonClick, onAlbumClick, onConfigChange,
    ],
  );

  const [hosts] = useState(() => new CardHosts());
  const ids = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  useEffect(() => hosts.keepOnly(ids), [hosts, ids]);

  const renderSlot = useCallback((card: CardEntry) => <CardSlot host={hosts.get(card.id)} />, [hosts]);
  const removeCard = useCallback(
    (cardId: string) =>
      onCardRemove ? onCardRemove(cardId) : onLayoutChange(cards.filter((c) => c.id !== cardId)),
    [cards, onCardRemove, onLayoutChange],
  );
  const staticGrid = useMemo(() => ({ cards, renderCard: renderSlot }), [cards, renderSlot]);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {editMode ? (
          <StaticGridContext.Provider value={staticGrid}>
            <SortableCardGrid
              cards={cards}
              limitsOf={cardLimits}
              renderCard={renderSlot}
              onLayoutChange={onLayoutChange}
              onRemove={removeCard}
            />
          </StaticGridContext.Provider>
        ) : (
          <StaticCards cards={cards} renderCard={renderSlot} />
        )}
      </div>
      {cards.map((card) => {
        const host = hosts.get(card.id);
        return host ? createPortal(<CardBody card={card} ctx={ctx} />, host, card.id) : null;
      })}
    </>
  );
});
