"use client";

import { useState, memo } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
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

export interface MediaCardProps {
  imageUrl: string;
  title: string;
  aspectRatio?: "poster" | "square" | "landscape";
  metadata?: ReactNode;
  badges?: ReactNode;
  qualityBar?: QualitySegment[];
  servers?: ServerPresence[];
  onClick: () => void;
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
      className="group cursor-pointer overflow-hidden py-0 gap-0 rounded-lg hover:scale-[1.03] hover:shadow-[0_8px_32px_oklch(0_0_0/0.4)] hover:ring-1 hover:ring-white/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none transition-all duration-300 ease-out"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
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

      {/* Quality bar — colored segments between poster and content */}
      {qualityBar && qualityBar.length > 0 && (
        <div className="flex w-full shrink-0 gap-1 px-2 py-1 bg-card" aria-hidden="true">
          {qualityBar.map((seg, i) => (
            <div
              key={i}
              className="h-1 min-w-1 rounded-full"
              style={{ backgroundColor: seg.color, flex: seg.weight }}
              title={seg.label}
            />
          ))}
        </div>
      )}

      {/* Content below poster — fixed height for virtualizer stability */}
      <div className="h-34.5 overflow-hidden flex flex-col">
        {/* Title — min-h reserves 2 lines even for short titles */}
        <CardHeader className="px-3 pt-2 pb-0 shrink-0 gap-0">
          <CardTitle
            className="text-sm leading-tight line-clamp-2 min-h-[2lh]"
            title={title}
          >
            {title}
          </CardTitle>
        </CardHeader>

        {/* Metadata — fills remaining space between title and footer */}
        <CardDescription className="px-3 pt-1 text-xs flex-1 min-h-0 overflow-hidden">
          {metadata}
        </CardDescription>

        {/* Footer: badges + server chips + info button */}
        <CardFooter className="px-3 pt-1 pb-2 gap-1 items-center shrink-0 overflow-hidden">
          {badges}
          {servers && servers.length > 0 && <ServerChips servers={servers} />}
          {onInfo && (
            <button
              className="ml-auto rounded-md border border-border bg-muted/50 p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              title="Summary"
              aria-label={`View summary for ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onInfo();
              }}
            >
              <Info className="h-4 w-4" />
            </button>
          )}
        </CardFooter>
      </div>
    </Card>
  );

  if (!hoverContent) return card;

  return (
    <HoverCard openDelay={400} closeDelay={150}>
      <HoverCardTrigger asChild>{card}</HoverCardTrigger>
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
