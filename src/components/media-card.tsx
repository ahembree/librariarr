"use client";

import { useState, memo } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Film, Tv, Music, Info } from "lucide-react";
import { ServerChips } from "@/components/server-chips";
import { FadeImage } from "@/components/ui/fade-image";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card";

type FallbackIcon = "movie" | "series" | "music";

interface ServerPresence {
  serverId: string;
  serverName: string;
  serverType: string;
}

export interface QualitySegment {
  color: string;
  weight: number;
  label?: string;
}

/** Fixed height of the text block under the poster, in px. Exported so the
 *  library pages' virtualizer row math stays in lockstep with the card. */
export const CARD_CONTENT_HEIGHT = 96;

export interface MediaCardProps {
  imageUrl: string;
  title: string;
  href?: string;
  aspectRatio?: "poster" | "square" | "landscape";
  metadata?: ReactNode;
  badges?: ReactNode;
  qualityBar?: QualitySegment[];
  servers?: ServerPresence[];
  onClick?: () => void;
  onInfo?: () => void;
  fallbackIcon?: FallbackIcon;
  hoverContent?: ReactNode;
}

const FALLBACK_ICONS = {
  movie: Film,
  series: Tv,
  music: Music,
} as const;

export const MediaCard = memo(function MediaCard({
  imageUrl,
  title,
  href,
  aspectRatio = "poster",
  metadata,
  badges,
  qualityBar,
  servers,
  onClick,
  onInfo,
  fallbackIcon = "movie",
  hoverContent,
}: MediaCardProps) {
  const [imgError, setImgError] = useState(false);
  const FallbackComponent = FALLBACK_ICONS[fallbackIcon];

  const card = (
    <Card
      className={cn(
        "group cursor-pointer overflow-hidden py-0 gap-0 rounded-xl transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-[5px] hover:shadow-[0_18px_40px_-12px_oklch(0_0_0/0.65)] hover:ring-1 hover:ring-white/10",
        !href && "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
      )}
      {...(!href && {
        onClick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.();
          }
        },
        role: "button" as const,
        tabIndex: 0,
      })}
      aria-label={title}
    >
      {/* Image */}
      <div
        className={cn(
          "relative w-full overflow-hidden bg-muted",
          aspectRatio === "poster" && "aspect-2/3",
          aspectRatio === "square" && "aspect-square",
          aspectRatio === "landscape" && "aspect-video",
        )}
      >
        {imgError ? (
          <div className="flex h-full items-center justify-center">
            <FallbackComponent className="h-8 w-8 text-muted-foreground" />
          </div>
        ) : (
          <FadeImage
            src={imageUrl}
            alt={title}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
            onError={() => setImgError(true)}
          />
        )}
      </div>

      {/* Quality bar — always rendered for consistent card height in virtualizer */}
      <div className="flex w-full shrink-0 gap-1 px-2 py-1 bg-card" aria-hidden="true">
        {qualityBar && qualityBar.length > 0 && qualityBar.map((seg, i) => (
          <div
            key={i}
            className="h-1 min-w-1 rounded-full"
            style={{ backgroundColor: seg.color, flex: seg.weight }}
            title={seg.label}
          />
        ))}
        {(!qualityBar || qualityBar.length === 0) && <div className="h-1" />}
      </div>

      {/* Compact content block — fixed height for virtualizer stability:
          title (2 lines reserved), mono metadata line, footer chips. */}
      <div
        className="flex flex-col overflow-hidden px-2.5 pt-1.5 pb-2"
        style={{ height: CARD_CONTENT_HEIGHT }}
      >
        <h3
          className="min-h-[2lh] text-[13px] font-medium leading-snug line-clamp-2 transition-colors group-hover:text-brand-bright"
          title={title}
        >
          {title}
        </h3>

        {/* Mono metadata — clipped if it wraps past the footer */}
        <div className="mt-0.5 min-h-0 flex-1 overflow-hidden">{metadata}</div>

        {/* Footer: badges + server chips + info button */}
        <div className="flex shrink-0 items-center gap-1 overflow-hidden pt-1">
          {badges}
          {servers && servers.length > 0 && <ServerChips servers={servers} />}
          {onInfo && (
            <button
              className="ml-auto rounded-md border border-border bg-muted/50 p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              title="Summary"
              aria-label={`View summary for ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onInfo();
              }}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </Card>
  );

  const wrappedCard = href ? (
    <Link
      href={href}
      onClick={onClick}
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
    >
      {card}
    </Link>
  ) : card;

  if (!hoverContent) return wrappedCard;

  return (
    <HoverCard openDelay={400} closeDelay={150}>
      <HoverCardTrigger asChild>{wrappedCard}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 p-0 duration-200"
      >
        {hoverContent}
      </HoverCardContent>
    </HoverCard>
  );
});
