import { useState } from "react";
import { formatDuration, formatFileSize, formatDate } from "@/lib/format";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { getRatingLabel } from "@/lib/rating-labels";
import { useChipColors } from "@/components/chip-color-provider";
import { RatingChip } from "@/components/rating-chip";
import { ServerChips } from "@/components/server-chips";
import { FadeImage } from "@/components/ui/fade-image";
import { ColorChip } from "@/components/color-chip";
import { Clock, HardDrive, Film } from "lucide-react";

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

function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-white/6 px-3.5 py-2 space-y-0.5 last:border-b-0">
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
      {children}
    </div>
  );
}

function DetailRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="text-muted-foreground/60 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

interface MediaHoverPopoverProps {
  data: MediaHoverData;
  /** Show poster image at the top (used in table view where posters aren't visible) */
  imageUrl?: string;
  /** Aspect ratio for the poster image. Default "poster" (2/3), "square" for music. */
  imageAspect?: "poster" | "square";
}

export function MediaHoverPopover({ data, imageUrl, imageAspect = "poster" }: MediaHoverPopoverProps) {
  const [imgError, setImgError] = useState(false);
  const { getBadgeStyle } = useChipColors();

  const resLabel =
    data.resolution ? normalizeResolutionLabel(data.resolution) : null;
  const displayRes = resLabel === "Other" ? data.resolution : resLabel;

  const hasSummary = data.summary;
  const hasGroupedCounts =
    data.seasonCount != null ||
    data.episodeCount != null ||
    data.albumCount != null ||
    data.trackCount != null;
  const audioCodecs = data.audioCodecCounts ? Object.keys(data.audioCodecCounts) : [];
  const qualityKeys = data.qualityCounts ? Object.keys(data.qualityCounts).filter((k) => data.qualityCounts![k] > 0) : [];
  const hasChips =
    displayRes ||
    (data.dynamicRange && data.dynamicRange !== "SDR") ||
    data.audioProfile ||
    audioCodecs.length > 0 ||
    qualityKeys.length > 0;
  const hasDuration = data.duration && formatDuration(data.duration) !== "-";
  const hasFileSize = data.fileSize && formatFileSize(data.fileSize) !== "-";
  const hasDetails = hasDuration || hasFileSize;
  const hasGenres = data.genres && data.genres.length > 0;
  const hasRatings = data.rating != null || data.audienceRating != null;
  const hasFooter = data.addedAt || (data.playCount != null && data.playCount > 0);
  const hasServers = data.servers && data.servers.length > 0;

  return (
    <div className="py-1">
      {/* Poster image (table view) */}
      {imageUrl && !imgError && (
        <div className="flex justify-center bg-muted rounded-t-xl">
          <div className={`relative w-1/2 overflow-hidden ${imageAspect === "square" ? "aspect-square" : "aspect-2/3"}`}>
            <FadeImage
              src={imageUrl}
              alt={data.title}
              loading="eager"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          </div>
        </div>
      )}
      {imageUrl && imgError && (
        <div className="flex items-center justify-center w-full h-24 bg-muted rounded-t-xl">
          <Film className="h-8 w-8 text-muted-foreground" />
        </div>
      )}

      {/* Header: title + year + studio */}
      <Section>
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold leading-tight line-clamp-2 min-w-0">
            {data.title}
          </h4>
          {data.year && (
            <span className="text-xs text-muted-foreground shrink-0">
              {data.year}
            </span>
          )}
        </div>
        {(data.studio || data.contentRating) && (
          <Row>
            {data.studio && <span>{data.studio}</span>}
            {data.studio && data.contentRating && <Dot />}
            {data.contentRating && (
              <span className="rounded border border-white/6 px-1 py-px text-[10px] leading-none">
                {data.contentRating}
              </span>
            )}
          </Row>
        )}
      </Section>

      {/* Summary */}
      {hasSummary && (
        <Section>
          <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3">
            {data.summary}
          </p>
        </Section>
      )}

      {/* Grouped counts (series/music) */}
      {hasGroupedCounts && (
        <Section>
          <Row>
            {data.seasonCount != null && (
              <span>
                {data.seasonCount} {data.seasonCount === 1 ? "season" : "seasons"}
              </span>
            )}
            {data.seasonCount != null && data.episodeCount != null && <Dot />}
            {data.episodeCount != null && (
              <span>
                {data.episodeCount}{" "}
                {data.episodeCount === 1 ? "episode" : "episodes"}
              </span>
            )}
            {data.albumCount != null && (
              <span>
                {data.albumCount} {data.albumCount === 1 ? "album" : "albums"}
              </span>
            )}
            {data.albumCount != null && data.trackCount != null && <Dot />}
            {data.trackCount != null && (
              <span>
                {data.trackCount} {data.trackCount === 1 ? "track" : "tracks"}
              </span>
            )}
          </Row>
        </Section>
      )}

      {/* Quality chips */}
      {hasChips && (
        <Section>
          <div className="flex items-center gap-1.5 flex-wrap">
            {displayRes && (
              <ColorChip style={getBadgeStyle("resolution", displayRes)}>
                {displayRes}
              </ColorChip>
            )}
            {!displayRes && qualityKeys.map((quality) => (
              <ColorChip key={quality} style={getBadgeStyle("resolution", quality)}>
                {quality}<span className="text-muted-foreground/60">: {data.qualityCounts![quality]}</span>
              </ColorChip>
            ))}
            {data.dynamicRange && data.dynamicRange !== "SDR" && (
              <ColorChip style={getBadgeStyle("dynamicRange", data.dynamicRange)}>
                {data.dynamicRange}
              </ColorChip>
            )}
            {data.audioProfile && (
              <ColorChip style={getBadgeStyle("audioProfile", data.audioProfile)}>
                {data.audioProfile}
              </ColorChip>
            )}
            {audioCodecs.map((codec) => (
              <ColorChip key={codec} style={getBadgeStyle("audioCodec", codec)}>
                {codec}
              </ColorChip>
            ))}
          </div>
        </Section>
      )}

      {/* Duration + file size — vertical with icons */}
      {hasDetails && (
        <Section>
          <div className="flex flex-col gap-1">
            {hasDuration && (
              <DetailRow icon={<Clock className="h-3.5 w-3.5" />}>
                {formatDuration(data.duration ?? null)}
              </DetailRow>
            )}
            {hasFileSize && (
              <DetailRow icon={<HardDrive className="h-3.5 w-3.5" />}>
                {formatFileSize(data.fileSize ?? null)}
              </DetailRow>
            )}
          </div>
        </Section>
      )}

      {/* Genres */}
      {hasGenres && (
        <Section>
          <Row>
            <span className="line-clamp-1">{data.genres!.slice(0, 3).join(", ")}</span>
          </Row>
        </Section>
      )}

      {/* Ratings */}
      {hasRatings && (
        <Section>
          <div className="flex items-center gap-1.5 flex-wrap">
            {data.rating != null && (
              <RatingChip label={getRatingLabel(data.ratingImage, data.servers?.[0]?.serverType, "rating", "Critic")} value={data.rating} className="text-[10px] px-2 py-px" />
            )}
            {data.audienceRating != null && (
              <RatingChip label={getRatingLabel(data.audienceRatingImage, data.servers?.[0]?.serverType, "audienceRating", "Audience")} value={data.audienceRating} className="text-[10px] px-2 py-px" />
            )}
          </div>
        </Section>
      )}

      {/* Footer: dates + plays */}
      {hasFooter && (
        <Section>
          <Row>
            {data.addedAt && (
              <span>Added {formatDate(data.addedAt)}</span>
            )}
            {data.addedAt && data.playCount != null && data.playCount > 0 && (
              <Dot />
            )}
            {data.playCount != null && data.playCount > 0 && (
              <span>
                {data.playCount} {data.playCount === 1 ? "play" : "plays"}
              </span>
            )}
          </Row>
        </Section>
      )}

      {/* Servers */}
      {hasServers && (
        <Section>
          <ServerChips servers={data.servers!} />
        </Section>
      )}
    </div>
  );
}
