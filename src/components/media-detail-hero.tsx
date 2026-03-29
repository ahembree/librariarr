"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FadeImage } from "@/components/ui/fade-image";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type PlayServer, buildPlayUrl } from "@/lib/play-url";
import { SERVER_TYPE_STYLES, DEFAULT_SERVER_STYLE } from "@/lib/server-styles";

interface MediaDetailHeroProps {
  itemId: string;
  imageUrl: string;
  title: string;
  tagline?: string | null;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  ratings?: React.ReactNode;
  genres?: React.ReactNode;
  filePath?: string | null;
  backHref: string;
  backLabel?: string;
  children?: React.ReactNode;
  useParentArt?: boolean;
  artUrl?: string;
  posterAspectRatio?: "2/3" | "1/1";
  playServers?: PlayServer[];
}

function getServerColors(serverType: string) {
  return (SERVER_TYPE_STYLES[serverType] ?? DEFAULT_SERVER_STYLE).rgba;
}

function PlayButton({ playServers }: { playServers: PlayServer[] }) {
  if (playServers.length === 0) return null;

  const baseClasses = cn(
    "flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold",
    "backdrop-blur-sm transition-all duration-200 shadow-lg",
  );

  // Single link — render as a direct button
  if (playServers.length === 1) {
    const server = playServers[0];
    const colors = getServerColors(server.serverType);
    return (
      <a
        href={buildPlayUrl(server)}
        target="_blank"
        rel="noopener noreferrer"
        className={baseClasses}
        style={{
          backgroundColor: colors.bg,
          color: colors.text,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = colors.hover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = colors.bg;
        }}
      >
        <ExternalLink className="h-3 w-3 shrink-0" />
        <span className="truncate">Open in {server.serverName}</span>
      </a>
    );
  }

  // Multiple links — dropdown
  const hasLabels = playServers.some((s) => s.label);
  const multiServer = new Set(playServers.map((s) => s.serverName)).size > 1;
  const primary = getServerColors(playServers[0].serverType);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={baseClasses}
          style={{
            backgroundColor: primary.bg,
            color: primary.text,
          }}
        >
          <ExternalLink className="h-3 w-3" />
          Open in…
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {playServers.map((server, i) => {
          const colors = getServerColors(server.serverType);
          // Build a descriptive label for the menu item
          let itemLabel: string;
          if (hasLabels && multiServer) {
            itemLabel = `${server.label} — ${server.serverName}`;
          } else if (hasLabels) {
            itemLabel = server.label!;
          } else {
            itemLabel = server.serverName;
          }
          return (
            <DropdownMenuItem key={`${server.serverName}-${server.label ?? i}`} asChild>
              <a
                href={buildPlayUrl(server)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2"
              >
                <ExternalLink className="h-3.5 w-3.5" style={{ color: colors.text }} />
                {itemLabel}
                {!hasLabels && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {server.serverType}
                  </span>
                )}
              </a>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MediaDetailHero({
  itemId,
  imageUrl,
  title,
  tagline,
  subtitle,
  badges,
  ratings,
  genres,
  filePath,
  backHref,
  backLabel,
  children,
  useParentArt,
  artUrl: artUrlProp,
  posterAspectRatio = "2/3",
  playServers,
}: MediaDetailHeroProps) {
  const [artFailed, setArtFailed] = useState(false);

  const artUrl = artUrlProp ?? `/api/media/${itemId}/image?type=art`;
  const posterArtFallback = useParentArt
    ? `/api/media/${itemId}/image?type=parent`
    : imageUrl;

  const handleArtError = useCallback(() => {
    setArtFailed(true);
  }, []);

  return (
    <div className="min-h-screen">
      {/* Hero section */}
      <div className="relative h-[55vh] min-h-70 sm:min-h-100 max-h-175 w-full overflow-hidden">
        {/* Background artwork layer */}
        <div className="absolute inset-0">
          {artFailed ? (
            /* Blur fallback: scaled-up poster with heavy blur */
            <FadeImage
              src={posterArtFallback}
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full object-cover"
              style={{
                filter: "blur(40px) saturate(1.2)",
                transform: "scale(1.15)",
              }}
            />
          ) : (
            <FadeImage
              src={artUrl}
              alt=""
              aria-hidden
              fetchPriority="high"
              loading="eager"
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: "center 20%" }}
              onError={handleArtError}
            />
          )}

          {/* Dark vignette overlay for depth */}
          <div
            className="absolute inset-0"
            style={{
              background: [
                "linear-gradient(to bottom, oklch(0.16 0.006 270 / 0.3) 0%, transparent 30%)",
                "linear-gradient(to bottom, transparent 40%, oklch(0.16 0.006 270 / 0.7) 70%, oklch(0.16 0.006 270) 100%)",
                "linear-gradient(to right, oklch(0.16 0.006 270 / 0.5) 0%, transparent 50%)",
              ].join(", "),
            }}
          />
        </div>

        {/* Top navigation — back button + open button */}
        <div className="relative z-10 flex items-center p-4 sm:p-6 lg:p-8">
          <Link
            href={backHref}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
              "text-white/80 hover:text-white",
              "bg-white/5 hover:bg-white/10 backdrop-blur-sm",
              "transition-all duration-200",
            )}
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel || "Back"}
          </Link>
        </div>

        {/* Localized dark gradient behind poster + text */}
        <div
          className="absolute bottom-0 left-0 z-9 pointer-events-none"
          style={{
            width: "min(56rem, 80%)",
            height: "70%",
            background: "radial-gradient(ellipse at 10% 100%, oklch(0.16 0.006 270 / 0.7) 0%, oklch(0.16 0.006 270 / 0.35) 40%, transparent 70%)",
          }}
        />

        {/* Poster + title area — anchored to the bottom of the hero */}
        <div className="absolute inset-x-0 bottom-0 z-10 px-4 pb-6 sm:px-6 sm:pb-8 lg:px-8 animate-fade-in-up">
          <div className="flex items-center gap-5 sm:gap-7">
            {/* Poster + play button */}
            <div className="shrink-0 w-30 sm:w-40 lg:w-50">
              <div
                className="relative overflow-hidden rounded-lg shadow-2xl"
                style={{
                  boxShadow:
                    "0 25px 50px -12px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(1 0 0 / 0.08)",
                }}
              >
                <FadeImage
                  src={imageUrl}
                  alt={title}
                  className="block h-auto w-full"
                  style={{ aspectRatio: posterAspectRatio, objectFit: "cover" }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
              {playServers && playServers.length > 0 && (
                <div className="mt-2 w-full overflow-hidden *:w-full *:justify-center">
                  <PlayButton playServers={playServers} />
                </div>
              )}
            </div>

            {/* Title + metadata */}
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold font-display leading-tight tracking-tight text-white sm:text-3xl lg:text-4xl">
                {title}
              </h1>

              {tagline && (
                <p className="mt-1.5 text-sm font-display italic text-white/60 sm:text-base lg:text-lg">
                  &ldquo;{tagline}&rdquo;
                </p>
              )}

              {subtitle && (
                <div className="mt-1.5 text-sm text-white/70 sm:text-base lg:text-lg">
                  {subtitle}
                </div>
              )}

              {badges && (
                <div className="mt-2 sm:mt-3 flex flex-wrap items-center gap-1.5 sm:gap-2">
                  {badges}
                </div>
              )}

              {ratings && (
                <div className="mt-2 flex items-center gap-4 text-sm">
                  {ratings}
                </div>
              )}

              {genres && (
                <div className="mt-2 flex gap-1.5 overflow-x-auto sm:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {genres}
                </div>
              )}

              {filePath && (
                <p className="mt-2 hidden sm:block truncate text-xs font-mono text-white/40">
                  {filePath.substring(0, filePath.lastIndexOf("/"))}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content area below the hero */}
      <div className="relative z-10 px-4 pb-12 sm:px-6 lg:px-8">
        {children}
      </div>
    </div>
  );
}
