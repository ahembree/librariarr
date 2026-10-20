import { useEffect, useState } from "react";
import {
  formatDuration,
  formatFileSize,
  formatRelativeDate,
} from "@/lib/format";
import { qualityChips } from "@/lib/media/quality-chips";
import { getRatingLabel } from "@/lib/rating-labels";
import { RatingChip } from "@/components/rating-chip";
import { ServerChips } from "@/components/server-chips";
import { FadeImage } from "@/components/ui/fade-image";
import { QualityChips } from "@/components/quality-chips";
import { ColorChip } from "@/components/color-chip";
import { CACHE_WIDTH_GRID, withImageWidth } from "@/lib/image-url";

export interface MediaHoverData {
  title: string;
  year?: number | null;
  summary?: string | null;
  contentRating?: string | null;
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
  duration?: number | null;
  resolution?: string | null;
  dynamicRange?: string | null;
  audioProfile?: string | null;
  /** A track's codec (music-only, like `audioCodecCounts` for a group). */
  audioCodec?: string | null;
  fileSize?: string | null;
  genres?: string[] | null;
  studio?: string | null;
  playCount?: number;
  lastPlayedAt?: string | null;
  addedAt?: string | null;
  seasonCount?: number;
  episodeCount?: number;
  albumCount?: number;
  trackCount?: number;
  audioCodecCounts?: Record<string, number> | null;
  qualityCounts?: Record<string, number> | null;
  servers?: Array<{ serverId: string; serverName: string; serverType: string }>;
}

/**
 * Hover data straight from a `/api/media/[id]` record. The record carries an
 * audio codec for every item, but only a track shows it as its chip — a film
 * keeps its resolution, dynamic range and audio profile.
 */
export function hoverDataFromRecord(record: MediaHoverData & { type?: string | null }): MediaHoverData {
  return record.type === "MUSIC" ? record : { ...record, audioCodec: undefined };
}

function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}

/** Numeric short date for the data grid ("2/22/24" / "22.02.24" by locale)
 *  — the spelled-out form truncates in the two-column grid. */
function formatShortDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { dateStyle: "short" });
}

/** One mono key/value cell in the data grid (tile-row idiom). */
function DataCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
      <span className="shrink-0 text-faint">{label}</span>
      <span className="truncate text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Summaries fetched on hover, keyed by fetch URL. Module-level so re-hovering a
 * card (or hovering the same title in table and card view) is instant and costs
 * no second request. `null` records "asked, nothing there" so a missing summary
 * isn't re-requested on every hover.
 */
const summaryCache = new Map<string, string | null>();

interface MediaHoverPopoverProps {
  data: MediaHoverData;
  /** Show artwork as a hero header (used where artwork isn't already visible) */
  imageUrl?: string;
  /** Aspect hint for the artwork. Accepted for the universal caller contract;
   *  the hero crops both poster and square art to a fixed-height banner. */
  imageAspect?: "poster" | "square";
  /**
   * Where to fetch the summary from when `data.summary` is absent.
   *
   * A summary is a paragraph of prose per row and the popover is the only thing
   * that renders it, so the big list endpoints leave it out and it is fetched
   * for the one item actually hovered. Everything else in the popover comes
   * from data the list already had, so the card paints immediately either way.
   */
  summaryUrl?: string;
}

export function MediaHoverPopover({
  data,
  imageUrl,
  imageAspect = "poster",
  summaryUrl,
}: MediaHoverPopoverProps) {
  const [imgError, setImgError] = useState(false);

  // The popover only mounts when it opens, so this effect is the "on hover"
  // trigger — no fetch happens for cards the user never hovers.
  const needsSummary = !data.summary && Boolean(summaryUrl);
  const [fetchedSummary, setFetchedSummary] = useState<string | null>(() =>
    summaryUrl ? summaryCache.get(summaryUrl) ?? null : null,
  );

  useEffect(() => {
    if (!needsSummary || !summaryUrl || summaryCache.has(summaryUrl)) return;
    let cancelled = false;
    fetch(summaryUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { item?: { summary?: string | null } } | null) => {
        const summary = json?.item?.summary ?? null;
        summaryCache.set(summaryUrl, summary);
        if (!cancelled) setFetchedSummary(summary);
      })
      .catch(() => {
        // Best-effort enrichment — the rest of the popover is already rendered.
      });
    return () => {
      cancelled = true;
    };
  }, [needsSummary, summaryUrl]);

  const summary = data.summary ?? fetchedSummary;

  // The same chips, by the same rules, as the cards, tables and detail pages.
  const chips = qualityChips(data, data.audioCodec ? "music" : "video");
  const hasDuration = data.duration != null && formatDuration(data.duration) !== "-";
  const hasFileSize = data.fileSize != null && formatFileSize(data.fileSize) !== "-";
  const hasPlays = data.playCount != null && data.playCount > 0;
  const hasGenres = data.genres && data.genres.length > 0;
  const hasRatings = data.rating != null || data.audienceRating != null;
  const hasServers = data.servers && data.servers.length > 0;
  const hasData =
    hasDuration || hasFileSize || hasPlays || data.addedAt || data.lastPlayedAt;

  const groupedCounts = [
    data.seasonCount != null &&
      `${data.seasonCount} ${data.seasonCount === 1 ? "season" : "seasons"}`,
    data.episodeCount != null &&
      `${data.episodeCount} ${data.episodeCount === 1 ? "episode" : "episodes"}`,
    data.albumCount != null &&
      `${data.albumCount} ${data.albumCount === 1 ? "album" : "albums"}`,
    data.trackCount != null &&
      `${data.trackCount} ${data.trackCount === 1 ? "track" : "tracks"}`,
  ].filter(Boolean) as string[];

  const showHero = Boolean(imageUrl) && !imgError;

  const titleBlock = (
    <>
      <h4 className="font-display text-sm font-semibold leading-tight line-clamp-2">
        {data.title}
        {data.year && (
          <span className="ml-1.5 font-sans text-xs font-normal text-muted-foreground">
            {data.year}
          </span>
        )}
      </h4>
      {(data.studio || data.contentRating) && (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
          {data.studio && <span className="truncate">{data.studio}</span>}
          {data.studio && data.contentRating && <Dot />}
          {data.contentRating && (
            <ColorChip className="text-[10px]">{data.contentRating}</ColorChip>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="overflow-hidden rounded-xl">
      {/* Cinematic hero: artwork banner with a scrim, title overlaid. */}
      {showHero ? (
        <div className={`relative w-full bg-muted ${imageAspect === "square" ? "h-40" : "h-44"}`}>
          <FadeImage
            src={withImageWidth(imageUrl!, CACHE_WIDTH_GRID)}
            alt=""
            loading="eager"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: "center 20%" }}
            onError={() => setImgError(true)}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to top, var(--popover) 0%, color-mix(in oklch, var(--popover) 40%, transparent) 45%, transparent 80%)",
            }}
          />
          <div className="absolute inset-x-0 bottom-0 px-3.5 pb-2">{titleBlock}</div>
        </div>
      ) : (
        <div className="px-3.5 pt-3">{titleBlock}</div>
      )}

      <div className="space-y-2 px-3.5 pt-2 pb-3">
        {/* Quality chips */}
        <QualityChips chips={chips} className="gap-1.5" />

        {/* Summary */}
        {summary && (
          <p className="text-xs leading-relaxed text-muted-foreground/80 line-clamp-3">
            {summary}
          </p>
        )}

        {/* Grouped counts (series/music) + genres — quiet mono lines */}
        {groupedCounts.length > 0 && (
          <p className="truncate font-mono text-[10.5px] text-faint">
            {groupedCounts.join(" · ")}
          </p>
        )}
        {hasGenres && (
          <p className="truncate font-mono text-[10.5px] text-faint">
            {data.genres!.slice(0, 3).join(" · ")}
          </p>
        )}

        {/* Data grid: mono key/value pairs */}
        {hasData && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/6 pt-2">
            {hasDuration && (
              <DataCell label="Runtime" value={formatDuration(data.duration ?? null)} />
            )}
            {hasFileSize && (
              <DataCell label="Size" value={formatFileSize(data.fileSize ?? null)} />
            )}
            {hasPlays && (
              <DataCell label="Plays" value={data.playCount!.toLocaleString()} />
            )}
            {data.lastPlayedAt && (
              <DataCell label="Played" value={formatRelativeDate(data.lastPlayedAt)} />
            )}
            {data.addedAt && (
              <DataCell label="Added" value={formatShortDate(data.addedAt)} />
            )}
          </div>
        )}

        {/* Ratings */}
        {hasRatings && (
          <div className="flex flex-wrap items-center gap-1.5">
            {data.rating != null && (
              <RatingChip label={getRatingLabel(data.ratingImage, data.servers?.[0]?.serverType, "rating", "Critic")} value={data.rating} className="text-[10px] px-2 py-px" />
            )}
            {data.audienceRating != null && (
              <RatingChip label={getRatingLabel(data.audienceRatingImage, data.servers?.[0]?.serverType, "audienceRating", "Audience")} value={data.audienceRating} className="text-[10px] px-2 py-px" />
            )}
          </div>
        )}

        {/* Servers */}
        {hasServers && (
          <div className="border-t border-white/6 pt-2">
            <ServerChips servers={data.servers!} />
          </div>
        )}
      </div>
    </div>
  );
}
