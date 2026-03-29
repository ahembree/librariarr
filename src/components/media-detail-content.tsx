"use client";

import { useState, useEffect, useCallback } from "react";
import { useChipColors } from "@/components/chip-color-provider";
import { cn } from "@/lib/utils";
import { normalizeResolutionLabel } from "@/lib/resolution";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Loader2, ChevronDown, ChevronRight, Database, History, FileText, Play, Monitor, Volume2, Subtitles } from "lucide-react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { ArrSection } from "@/components/arr-link-button";
import { ServerChips } from "@/components/server-chips";
import { formatFileSize, formatDuration, formatDate } from "@/lib/format";
import { SERVER_TYPE_STYLES, DEFAULT_SERVER_STYLE } from "@/lib/server-styles";
import { FadeImage } from "@/components/ui/fade-image";
import type { MediaItemWithRelations } from "@/lib/types";

function formatResolution(resolution: string | null): string {
  if (!resolution) return "Unknown";
  const label = normalizeResolutionLabel(resolution);
  return label === "Other" ? resolution : label;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-border/30 last:border-0">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="font-medium text-sm">{value}</span>
    </div>
  );
}

/** Recursively renders metadata values: arrays as collapsible lists, objects as key/value pairs, primitives as text. */
function MetadataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null || value === "") return <span className="text-xs text-muted-foreground">-</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-xs text-muted-foreground">-</span>;
    const isPrimitive = value.every((v) => typeof v !== "object" || v === null);
    return (
      <div className={cn("space-y-0.5", !isPrimitive && "space-y-1")}>
        {isPrimitive
          ? value.map((item, i) => (
              <div key={i} className="text-xs font-medium">{String(item)}</div>
            ))
          : value.map((item, i) => (
              <MetadataArrayItem key={i} index={i} value={item} depth={depth} />
            ))}
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <div className={cn("space-y-0.5", depth > 0 && "pl-3 border-l border-border/40")}>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => {
          if (v == null || v === "") return null;
          return <MetadataEntry key={k} label={k} value={v} depth={depth + 1} />;
        })}
      </div>
    );
  }

  return <span className="font-medium text-right break-all text-xs">{String(value)}</span>;
}

/** A single item in a metadata array, rendered as a collapsible when complex. */
function MetadataArrayItem({ index, value, depth }: { index: number; value: unknown; depth: number }) {
  const [open, setOpen] = useState(false);

  // Primitive items render inline
  if (typeof value !== "object" || value === null) {
    return <span className="font-medium text-xs">{String(value)}</span>;
  }

  // For objects, create a summary label from the first string field
  const entries = Object.entries(value as Record<string, unknown>);
  const preview = entries.find(([, v]) => typeof v === "string")?.[1] as string | undefined;
  const label = preview ? preview.slice(0, 40) + (preview.length > 40 ? "..." : "") : `Item ${index + 1}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5">
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className="truncate font-mono">{label}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 mt-0.5">
          <MetadataValue value={value} depth={depth + 1} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A single metadata key/value row. Arrays and objects expand recursively; lists are always collapsible. */
function MetadataEntry({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(false);

  // Arrays: always collapsible, collapsed by default
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="flex justify-between gap-4 py-1 border-b border-border/50 last:border-0">
          <span className="text-muted-foreground shrink-0 font-mono text-xs">{label}</span>
          <span className="text-xs text-muted-foreground">-</span>
        </div>
      );
    }
    return (
      <div className="py-1 border-b border-border/50 last:border-0">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <span className="font-mono">{label}</span>
              <span className="text-muted-foreground/60">({value.length})</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="ml-4 mt-1">
              <MetadataValue value={value} depth={depth} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }

  // Objects: render nested key/value pairs
  if (typeof value === "object" && value !== null) {
    return (
      <div className="py-1 border-b border-border/50 last:border-0">
        <span className="text-muted-foreground font-mono text-xs">{label}</span>
        <div className="mt-0.5">
          <MetadataValue value={value} depth={depth} />
        </div>
      </div>
    );
  }

  // Primitive: inline row
  return (
    <div className="flex justify-between gap-4 py-1 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground shrink-0 font-mono text-xs">{label}</span>
      <span className="font-medium text-right break-all text-xs">{String(value ?? "-")}</span>
    </div>
  );
}

interface WatchHistoryEntry {
  username: string;
  playCount: number;
  lastPlayedAt: string | null;
}

interface ServerHistoryEntry {
  serverId: string;
  serverName: string;
  serverType: string;
  users: WatchHistoryEntry[];
}

interface MediaDetailContentProps {
  item: MediaItemWithRelations;
  /** Extra content rendered before the standard sections (e.g. horizontal lists) */
  children?: React.ReactNode;
  /** Hide video section (for music) */
  hideVideo?: boolean;
  /** Compact mode for side panel: 1-column grid, smaller cast, collapsed cards */
  compact?: boolean;
  /** Optional matched criteria section rendered above cast */
  matchedCriteriaSection?: React.ReactNode;
  /** When true, this is a series/artist aggregate — skip episode-level detail fetches */
  isAggregate?: boolean;
}

export function MediaDetailContent({ item, children, hideVideo, compact, matchedCriteriaSection, isAggregate }: MediaDetailContentProps) {
  const { getBadgeStyle } = useChipColors();

  // Fetch full detail data (summary, tagline, genres, directors, etc.)
  const [detailData, setDetailData] = useState<Partial<MediaItemWithRelations> | null>(null);
  const [streams, setStreams] = useState<MediaItemWithRelations["streams"]>([]);
  const [history, setHistory] = useState<WatchHistoryEntry[]>([]);
  const [serverHistories, setServerHistories] = useState<ServerHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [videoOpen, setVideoOpen] = useState(!compact);
  const [audioOpen, setAudioOpen] = useState(!compact);
  const [metadataMap, setMetadataMap] = useState<Record<string, Record<string, unknown> | null>>({});
  const [metadataLoadingMap, setMetadataLoadingMap] = useState<Record<string, boolean>>({});
  const [metadataOpenMap, setMetadataOpenMap] = useState<Record<string, boolean>>({});

  // Merged item (list data + full detail)
  const merged: MediaItemWithRelations = detailData && detailData.id === item.id
    ? { ...item, ...detailData, servers: item.servers, library: item.library }
    : item;

  // Group streams by type
  const videoStreams = streams.filter((s) => s.streamType === 1);
  const audioStreams = streams.filter((s) => s.streamType === 2);
  const subtitleStreams = streams.filter((s) => s.streamType === 3);

  // Credits & cast helpers
  const castRoles = (merged.roles ?? []) as Array<{ tag: string; role: string | null; thumb: string | null }>;
  const hasCredits = (merged.directors && merged.directors.length > 0) || (merged.writers && merged.writers.length > 0) || (merged.countries && merged.countries.length > 0);
  const hasCast = castRoles.length > 0;

  const fetchItemDetail = useCallback(async (itemId: string) => {
    try {
      const response = await fetch(`/api/media/${itemId}`);
      const data = await response.json();
      if (data.item) {
        const itemStreams = data.item.streams ?? [];
        setStreams(itemStreams);
        const audioCount = itemStreams.filter((s: { streamType: number }) => s.streamType === 2).length;
        setAudioOpen(audioCount <= 2);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { streams: _st, library: _l, ...rest } = data.item;
        setDetailData(rest as Partial<MediaItemWithRelations>);
      }
    } catch {
      setStreams([]);
    }
  }, []);

  const fetchHistory = useCallback(async (itemId: string) => {
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/media/${itemId}/history`);
      const data = await response.json();
      setHistory(data.history || []);
      setServerHistories(data.serverHistories || []);
    } catch {
      setHistory([]);
      setServerHistories([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchAllMetadata = useCallback(async (cacheKey: string, mediaItemId?: string) => {
    const fetchId = mediaItemId ?? cacheKey;
    setMetadataLoadingMap((prev) => ({ ...prev, [cacheKey]: true }));
    try {
      const response = await fetch(`/api/media/${fetchId}`);
      const data = await response.json();
      setMetadataMap((prev) => ({ ...prev, [cacheKey]: data.item ?? null }));
    } catch {
      setMetadataMap((prev) => ({ ...prev, [cacheKey]: null }));
    } finally {
      setMetadataLoadingMap((prev) => ({ ...prev, [cacheKey]: false }));
    }
  }, []);

  useEffect(() => {
    setDetailData(null);
    setStreams([]);
    setHistory([]);
    setMetadataMap({});
    setMetadataLoadingMap({});
    setMetadataOpenMap({});
    // Aggregate items (series/artist scope) don't have a meaningful single item to fetch
    if (!isAggregate) {
      fetchItemDetail(item.id);
      fetchHistory(item.id);
    }
  }, [item.id, isAggregate, fetchItemDetail, fetchHistory]);

  // Aggregate items (series/artist scope): show only matched criteria + aggregate stats
  if (isAggregate) {
    return (
      <div className="mt-6 space-y-6">
        {/* Matched criteria */}
        {matchedCriteriaSection}

        {/* Aggregate stats */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground"><Play className="h-3.5 w-3.5" />Playback</h3>
          <div className="text-sm">
            <DetailRow
              label="Total Play Count"
              value={
                <span className={merged.playCount > 0 ? "text-green-400" : "text-muted-foreground"}>
                  {merged.playCount}
                </span>
              }
            />
            <DetailRow label="Last Played" value={formatDate(merged.lastPlayedAt, "Never")} />
            <DetailRow label="Added" value={formatDate(merged.addedAt)} />
            {merged.fileSize && <DetailRow label="Total Size" value={formatFileSize(merged.fileSize)} />}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {/* Server chips + correlation */}
      {merged.servers && merged.servers.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <ServerChips servers={merged.servers} />
          {merged.matchedBy && (
            <span className="text-[10px] text-muted-foreground">
              matched by {merged.matchedBy}
            </span>
          )}
        </div>
      )}

      {/* Summary */}
      {merged.summary && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {merged.summary}
        </p>
      )}

      {/* Matched criteria (from lifecycle rules, rendered above cast) */}
      {matchedCriteriaSection}

      {/* Credits & Cast */}
      {(hasCredits || hasCast) && (
        <section className="space-y-4">
          {/* Directors / Writers / Countries — inline */}
          {hasCredits && (
            <div className="flex flex-wrap items-center gap-x-4 text-sm text-muted-foreground">
              {merged.directors && merged.directors.length > 0 && (
                <span>
                  <span className="font-medium text-foreground">{merged.directors.length === 1 ? "Director" : "Directors"}:</span>{" "}
                  {merged.directors.join(", ")}
                </span>
              )}
              {merged.directors && merged.directors.length > 0 && merged.writers && merged.writers.length > 0 && (
                <span className="text-muted-foreground/40">|</span>
              )}
              {merged.writers && merged.writers.length > 0 && (
                <span>
                  <span className="font-medium text-foreground">{merged.writers.length === 1 ? "Writer" : "Writers"}:</span>{" "}
                  {merged.writers.join(", ")}
                </span>
              )}
              {((merged.directors && merged.directors.length > 0) || (merged.writers && merged.writers.length > 0)) && merged.countries && merged.countries.length > 0 && (
                <span className="text-muted-foreground/40">|</span>
              )}
              {merged.countries && merged.countries.length > 0 && (
                <span>
                  <span className="font-medium text-foreground">{merged.countries.length === 1 ? "Country" : "Countries"}:</span>{" "}
                  {merged.countries.join(", ")}
                </span>
              )}
            </div>
          )}

          {/* Cast carousel */}
          {hasCast && (
            <>
              <h3 className="mb-3 text-2xl text-white font-semibold tracking-wider">Cast</h3>
              {hasCredits && <Separator className="mb-4" />}
              <div className="relative sm:px-10">
                <Carousel
                  opts={{ align: "start", dragFree: true }}
                  className="w-full"
                >
                  <CarouselContent className="-ml-3">
                    {castRoles.map((actor, i) => (
                      <CarouselItem
                        key={`${actor.tag}-${i}`}
                        className={compact ? "basis-16 sm:basis-20 md:basis-24 pl-2" : "basis-28 sm:basis-40 md:basis-44 lg:basis-52 pl-3"}
                      >
                        <div className="flex flex-col items-center gap-2 text-center rounded-lg bg-muted/20 p-2 transition-colors hover:bg-muted/40">
                          <div className={compact ? "h-12 w-12 sm:h-16 sm:w-16 md:h-20 md:w-20 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-white/5" : "h-20 w-20 sm:h-28 sm:w-28 md:h-36 md:w-36 lg:h-40 lg:w-40 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-white/5"}>
                            {actor.thumb ? (
                              <FadeImage
                                src={`/api/media/${item.id}/image?type=role&index=${i}`}
                                alt={actor.tag}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = "none";
                                }}
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-lg font-medium text-muted-foreground">
                                {actor.tag.charAt(0).toUpperCase()}
                              </div>
                            )}
                          </div>
                          <div className="w-full min-w-0">
                            <p className="truncate text-xs font-semibold">{actor.tag}</p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {actor.role || "\u00A0"}
                            </p>
                          </div>
                        </div>
                      </CarouselItem>
                    ))}
                  </CarouselContent>
                  <CarouselPrevious className="hidden sm:flex -left-2" />
                  <CarouselNext className="hidden sm:flex -right-2" />
                </Carousel>
              </div>
              {hasCredits && <Separator className="mb-4" />}
            </>
          )}
        </section>
      )}

      {/* Page-specific children (e.g., horizontal media lists) */}
      {children}

      {/* Arr Controls */}
      {!isAggregate && <ArrSection itemId={item.id} mediaType={merged.type} />}

      {/* ── Detail columns ──────────────────────────────────── */}
      <div className={compact ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 stagger-children"}>
        {/* Column 1: Watch/Listen History */}
        <div className="rounded-xl border bg-muted/30 p-5 space-y-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <History className="h-3.5 w-3.5" />
            {merged.type === "MUSIC" ? "Listen History" : "Watch History"}
            {!historyLoading && history.length > 0 && (
              <span className="text-xs font-normal normal-case">
                ({history.reduce((sum, e) => sum + e.playCount, 0)} plays)
              </span>
            )}
          </div>
          {historyLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {merged.type === "MUSIC" ? "No listen history available." : "No watch history available."}
            </p>
          ) : serverHistories.length > 1 ? (
            <div className="space-y-4">
              {serverHistories.filter((sh) => sh.users.length > 0).map((sh) => (
                <div key={sh.serverId} className="space-y-2">
                  <Badge variant="outline" className="text-xs">
                    {sh.serverName}
                  </Badge>
                  {sh.users.map((entry) => (
                    <div key={`${sh.serverId}-${entry.username}`} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div>
                        <span className="font-medium">{entry.username}</span>
                        {entry.lastPlayedAt && (
                          <p className="text-xs text-muted-foreground">
                            Last: {new Date(entry.lastPlayedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                          </p>
                        )}
                      </div>
                      <span className="text-muted-foreground">
                        {entry.playCount} {entry.playCount === 1 ? "play" : "plays"}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((entry) => (
                <div key={entry.username} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                  <div>
                    <span className="font-medium">{entry.username}</span>
                    {entry.lastPlayedAt && (
                      <p className="text-xs text-muted-foreground">
                        Last: {new Date(entry.lastPlayedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                      </p>
                    )}
                  </div>
                  <span className="text-muted-foreground">
                    {entry.playCount} {entry.playCount === 1 ? "play" : "plays"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Column 2: File, Playback, Subtitles, Metadata */}
        <div className="rounded-xl border bg-muted/30 p-5 space-y-5">
          {/* File Section */}
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground"><FileText className="h-3.5 w-3.5" />File</h3>
            <div className="text-sm">
              <DetailRow label="Size" value={formatFileSize(merged.fileSize)} />
              <DetailRow label="Duration" value={formatDuration(merged.duration)} />
              {merged.filePath && (
                <div className="mt-1.5">
                  <span className="text-muted-foreground">Path</span>
                  <p className="mt-1 break-all rounded bg-muted/50 px-2 py-1 text-xs font-mono">
                    {merged.filePath}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Playback Section */}
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground"><Play className="h-3.5 w-3.5" />Playback</h3>
            <div className="text-sm">
              <DetailRow
                label="Play Count"
                value={
                  <span className={merged.playCount > 0 ? "text-green-400" : "text-muted-foreground"}>
                    {merged.playCount}
                  </span>
                }
              />
              <DetailRow label="Last Played" value={formatDate(merged.lastPlayedAt, "Never")} />
              {merged.originallyAvailableAt && <DetailRow label="Released" value={formatDate(merged.originallyAvailableAt)} />}
              <DetailRow label="Added" value={formatDate(merged.addedAt)} />
            </div>
          </section>

          {/* Subtitles */}
          {subtitleStreams.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <Subtitles className="h-3.5 w-3.5" />
                Subtitles ({subtitleStreams.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {subtitleStreams.map((sub) => (
                  <Badge key={sub.id} variant="secondary">
                    {sub.language ?? sub.languageCode ?? "Unknown"}
                    {sub.forced && " (Forced)"}
                    {sub.codec && ` [${sub.codec}]`}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          <Separator />

          {/* Database Metadata */}
          {(() => {
            const isMultiServer = merged.servers && merged.servers.length > 1;
            const entries = isMultiServer
              ? merged.servers!.map((srv) => ({ key: srv.mediaItemId ?? srv.serverId, mediaItemId: srv.mediaItemId ?? merged.id, label: `${srv.serverName} Metadata`, serverType: srv.serverType }))
              : [{ key: merged.id, mediaItemId: merged.id, label: "All Database Metadata", serverType: null as string | null }];

            /** Renders a single metadata collapsible that fetches + displays data for one mediaItemId */
            const renderMetadataCollapsible = (entry: typeof entries[0]) => {
              const isOpen = metadataOpenMap[entry.key] ?? false;
              const isLoading = metadataLoadingMap[entry.key] ?? false;
              const metadata = metadataMap[entry.key];
              const style = entry.serverType ? (SERVER_TYPE_STYLES[entry.serverType] ?? DEFAULT_SERVER_STYLE) : null;
              return (
                <Collapsible key={entry.key} open={isOpen} onOpenChange={(open) => {
                  setMetadataOpenMap((prev) => ({ ...prev, [entry.key]: open }));
                  if (open && metadata === undefined && !isLoading) {
                    fetchAllMetadata(entry.key, entry.mediaItemId);
                  }
                }}>
                  <CollapsibleTrigger asChild>
                    <button className="flex w-full items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {!isMultiServer && <Database className="h-3.5 w-3.5" />}
                      {style ? (
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: style.color }}></span>
                          {entry.label}
                        </span>
                      ) : entry.label}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2">
                      {isLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading...
                        </div>
                      ) : metadata ? (
                        <div className="space-y-1 text-sm">
                          {Object.entries(metadata)
                            .filter(([key]) => key !== "streams" && key !== "library" && key !== "externalIds" && key !== "lifecycleActions")
                            .map(([key, value]) => {
                              if (value == null || value === "") return null;
                              return <MetadataEntry key={key} label={key} value={value} />;
                            })}
                          {Array.isArray(metadata.externalIds) && (metadata.externalIds as Array<{ source: string; externalId: string }>).length > 0 && (
                            <>
                              <p className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">External IDs</p>
                              {(metadata.externalIds as Array<{ source: string; externalId: string }>).map((ext) => (
                                <div key={ext.source} className="flex justify-between gap-4 py-1 border-b border-border/50 last:border-0">
                                  <span className="text-muted-foreground font-mono text-xs">{ext.source}</span>
                                  <span className="font-medium text-xs">{ext.externalId}</span>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      ) : metadata === null ? (
                        <p className="text-sm text-muted-foreground">Failed to load metadata.</p>
                      ) : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            };

            // Single server: one collapsible directly
            if (!isMultiServer) {
              return renderMetadataCollapsible(entries[0]);
            }

            // Multi-server: outer "All Database Metadata" wrapping per-server collapsibles
            const outerOpen = metadataOpenMap["__all__"] ?? false;
            return (
              <Collapsible open={outerOpen} onOpenChange={(open) => {
                setMetadataOpenMap((prev) => ({ ...prev, ["__all__"]: open }));
              }}>
                <CollapsibleTrigger asChild>
                  <button className="flex w-full items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
                    {outerOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <Database className="h-3.5 w-3.5" />
                    All Database Metadata
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 ml-4 space-y-1">
                    {entries.map(renderMetadataCollapsible)}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })()}
        </div>

        {/* Column 3: Video */}
        {!hideVideo && merged.type !== "MUSIC" && (
          <div className="rounded-xl border bg-muted/30 p-5 space-y-3">
            <Collapsible open={videoOpen} onOpenChange={setVideoOpen}>
              <CollapsibleTrigger asChild>
                <button className="flex w-full items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
                  {videoOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <Monitor className="h-3.5 w-3.5" />
                  Video
                  {videoStreams.length > 0 && (
                    <span className="text-xs font-normal normal-case">
                      ({videoStreams.length} {videoStreams.length === 1 ? "stream" : "streams"})
                    </span>
                  )}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2">
                  {videoStreams.length > 0 ? (
                    <div className="space-y-3">
                      {videoStreams.map((vs, i) => (
                        <div key={vs.id} className={cn(videoStreams.length > 1 && "rounded-lg bg-muted/30 p-3")}>
                          {videoStreams.length > 1 && (
                            <p className="mb-1 text-xs font-medium text-muted-foreground">
                              Stream {i + 1}{vs.isDefault ? " (Default)" : ""}
                            </p>
                          )}
                          <div className="text-sm">
                            {vs.extendedDisplayTitle && <DetailRow label="Title" value={vs.extendedDisplayTitle} />}
                            <DetailRow
                              label="Codec"
                              value={vs.codec ? `${vs.codec.toUpperCase()}${vs.profile ? ` (${vs.profile})` : ""}` : "-"}
                            />
                            {vs.width && vs.height && <DetailRow label="Dimensions" value={`${vs.width}x${vs.height}`} />}
                            {vs.bitrate != null && <DetailRow label="Bitrate" value={`${(vs.bitrate / 1000).toFixed(1)} Mbps`} />}
                            {vs.frameRate != null && <DetailRow label="Frame Rate" value={`${vs.frameRate} fps`} />}
                            {vs.bitDepth != null && <DetailRow label="Bit Depth" value={`${vs.bitDepth}-bit`} />}
                            {vs.videoRangeType && (
                              <DetailRow
                                label="Dynamic Range"
                                value={
                                  <Badge variant="secondary" style={getBadgeStyle("dynamicRange", vs.videoRangeType)}>
                                    {vs.videoRangeType}
                                  </Badge>
                                }
                              />
                            )}
                            {vs.chromaSubsampling && <DetailRow label="Chroma" value={vs.chromaSubsampling} />}
                            {vs.colorPrimaries && <DetailRow label="Color Primaries" value={vs.colorPrimaries} />}
                            {vs.colorRange && <DetailRow label="Color Range" value={vs.colorRange} />}
                            {vs.scanType && <DetailRow label="Scan Type" value={vs.scanType} />}
                          </div>
                        </div>
                      ))}
                      <div className="text-sm">
                        <DetailRow label="Container" value={merged.container?.toUpperCase() ?? "-"} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm">
                      <DetailRow
                        label="Resolution"
                        value={
                          <Badge variant="outline" style={getBadgeStyle("resolution", formatResolution(merged.resolution))}>
                            {formatResolution(merged.resolution)}
                          </Badge>
                        }
                      />
                      {merged.videoWidth && merged.videoHeight && (
                        <DetailRow label="Dimensions" value={`${merged.videoWidth}x${merged.videoHeight}`} />
                      )}
                      <DetailRow
                        label="Codec"
                        value={merged.videoCodec ? `${merged.videoCodec.toUpperCase()}${merged.videoProfile ? ` (${merged.videoProfile})` : ""}` : "-"}
                      />
                      <DetailRow label="Bitrate" value={merged.videoBitrate ? `${(merged.videoBitrate / 1000).toFixed(1)} Mbps` : "-"} />
                      {merged.videoFrameRate && <DetailRow label="Frame Rate" value={merged.videoFrameRate} />}
                      {merged.videoBitDepth && <DetailRow label="Bit Depth" value={`${merged.videoBitDepth}-bit`} />}
                      {merged.aspectRatio && <DetailRow label="Aspect Ratio" value={merged.aspectRatio} />}
                      {merged.dynamicRange && (
                        <DetailRow
                          label="Dynamic Range"
                          value={
                            <Badge variant="secondary" style={getBadgeStyle("dynamicRange", merged.dynamicRange)}>
                              {merged.dynamicRange}
                            </Badge>
                          }
                        />
                      )}
                      {merged.videoChromaSubsampling && <DetailRow label="Chroma" value={merged.videoChromaSubsampling} />}
                      <DetailRow label="Container" value={merged.container?.toUpperCase() ?? "-"} />
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {/* Column 4: Audio */}
        <div className="rounded-xl border bg-muted/30 p-5 space-y-3">
          <Collapsible open={audioOpen} onOpenChange={setAudioOpen}>
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
                {audioOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <Volume2 className="h-3.5 w-3.5" />
                Audio
                {audioStreams.length > 0 && (
                  <span className="text-xs font-normal normal-case">
                    ({audioStreams.length} {audioStreams.length === 1 ? "track" : "tracks"})
                  </span>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2">
                {audioStreams.length > 0 ? (
                  <div className="space-y-3">
                    {audioStreams.map((as, i) => (
                      <div key={as.id} className={cn(audioStreams.length > 1 && "rounded-lg bg-muted/30 p-3")}>
                        {audioStreams.length > 1 && (
                          <p className="mb-1 text-xs font-medium text-muted-foreground">
                            Stream {i + 1}{as.isDefault ? " (Default)" : ""}{as.language ? ` — ${as.language}` : ""}
                          </p>
                        )}
                        <div className="text-sm">
                          {as.extendedDisplayTitle && <DetailRow label="Title" value={as.extendedDisplayTitle} />}
                          <DetailRow label="Codec" value={as.codec?.toUpperCase() ?? "-"} />
                          {as.profile && (
                            <DetailRow
                              label="Profile"
                              value={
                                <Badge variant="secondary" style={getBadgeStyle("audioProfile", as.profile)}>
                                  {as.profile}
                                </Badge>
                              }
                            />
                          )}
                          <DetailRow label="Channels" value={as.channels ? `${as.channels} ch` : "-"} />
                          {as.audioChannelLayout && <DetailRow label="Layout" value={as.audioChannelLayout} />}
                          {as.bitrate != null && <DetailRow label="Bitrate" value={`${as.bitrate} kbps`} />}
                          {as.samplingRate != null && <DetailRow label="Sample Rate" value={`${(as.samplingRate / 1000).toFixed(1)} kHz`} />}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm">
                    <DetailRow label="Codec" value={merged.audioCodec?.toUpperCase() ?? "-"} />
                    {merged.audioProfile && (
                      <DetailRow
                        label="Profile"
                        value={
                          <Badge variant="secondary" style={getBadgeStyle("audioProfile", merged.audioProfile)}>
                            {merged.audioProfile}
                          </Badge>
                        }
                      />
                    )}
                    <DetailRow label="Channels" value={merged.audioChannels ? `${merged.audioChannels} channels` : "-"} />
                    {merged.audioBitrate && <DetailRow label="Bitrate" value={`${merged.audioBitrate} kbps`} />}
                    {merged.audioSamplingRate && <DetailRow label="Sample Rate" value={`${(merged.audioSamplingRate / 1000).toFixed(1)} kHz`} />}
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
