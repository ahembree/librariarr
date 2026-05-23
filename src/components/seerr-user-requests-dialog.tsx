"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Film,
  Tv,
  Eye,
  EyeOff,
  Check,
  Clock,
  AlertCircle,
  Search,
  ExternalLink,
  Loader2,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";

interface ResolvedRequest {
  seerrId: number;
  type: "movie" | "tv";
  status: number;
  mediaStatus: number;
  is4k: boolean;
  createdAt: string;
  tmdbId: number;
  tvdbId: number | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  mediaItem: { id: string; route: "movie" | "show" } | null;
  watch: {
    correlatable: boolean;
    watched: boolean;
    episodesWatched: number;
    episodesAvailable: number;
  };
}

interface ResolveResponse {
  user: {
    seerrUsername: string;
    plexUsername: string | null;
    avatar: string | null;
  } | null;
  requests: ResolvedRequest[];
}

type FilterTab = "all" | "movies" | "series" | "watched" | "pending";

// Seerr media status: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIAL, 5=AVAILABLE, 6=DELETED
function mediaStatusLabel(s: number): { label: string; tone: string; icon: typeof Check } {
  switch (s) {
    case 5:
      return { label: "Available", tone: "text-emerald-400 bg-emerald-500/10", icon: Check };
    case 4:
      return { label: "Partial", tone: "text-sky-400 bg-sky-500/10", icon: Check };
    case 3:
      return { label: "Processing", tone: "text-blue-400 bg-blue-500/10", icon: Clock };
    case 2:
      return { label: "Pending", tone: "text-amber-400 bg-amber-500/10", icon: Clock };
    case 6:
      return { label: "Deleted", tone: "text-rose-400 bg-rose-500/10", icon: AlertCircle };
    default:
      return { label: "Unknown", tone: "text-muted-foreground bg-muted/40", icon: AlertCircle };
  }
}

// Seerr request status: 1=PENDING, 2=APPROVED, 3=DECLINED
function requestStatusLabel(s: number): string | null {
  if (s === 1) return "Pending approval";
  if (s === 3) return "Declined";
  return null;
}

function PosterThumb({ url, type }: { url: string | null; type: "movie" | "tv" }) {
  const Icon = type === "movie" ? Film : Tv;
  return (
    <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/40">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

interface Props {
  userKey: string | null;
  open: boolean;
  onClose: () => void;
}

export function SeerrUserRequestsDialog({ userKey, open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        {userKey ? (
          <DialogBody key={userKey} userKey={userKey} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({ userKey, onClose }: { userKey: string; onClose: () => void }) {
  const [data, setData] = useState<ResolveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/seerr/users/${encodeURIComponent(userKey)}/requests`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ResolveResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userKey]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.requests.filter((r) => {
      if (filter === "movies" && r.type !== "movie") return false;
      if (filter === "series" && r.type !== "tv") return false;
      if (filter === "watched") {
        if (!r.watch.correlatable) return false;
        if (r.type === "movie") {
          if (!r.watch.watched) return false;
        } else if (r.watch.episodesWatched === 0) {
          return false;
        }
      }
      if (filter === "pending" && r.mediaStatus !== 2 && r.mediaStatus !== 3) return false;
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filter, search]);

  const counts = useMemo(() => {
    if (!data) return { all: 0, movies: 0, series: 0, watched: 0, pending: 0 };
    let movies = 0;
    let series = 0;
    let watched = 0;
    let pending = 0;
    for (const r of data.requests) {
      if (r.type === "movie") movies++;
      else series++;
      if (r.watch.correlatable && (r.type === "movie" ? r.watch.watched : r.watch.episodesWatched > 0)) {
        watched++;
      }
      if (r.mediaStatus === 2 || r.mediaStatus === 3) pending++;
    }
    return { all: data.requests.length, movies, series, watched, pending };
  }, [data]);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "movies", label: "Movies", count: counts.movies },
    { key: "series", label: "Series", count: counts.series },
    { key: "watched", label: "Watched", count: counts.watched },
    { key: "pending", label: "In progress", count: counts.pending },
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {data?.user?.seerrUsername ?? userKey}&apos;s requests
        </DialogTitle>
          <DialogDescription>
            {loading && "Loading requests…"}
            {!loading && data && (
              <>
                {data.requests.length} {data.requests.length === 1 ? "request" : "requests"}
                {data.user?.plexUsername == null && data.requests.length > 0 && (
                  <span className="ml-1">
                    · <EyeOff className="inline h-3 w-3 mr-1 -mt-px" />
                    no linked Plex username
                  </span>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!loading && data && data.requests.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setFilter(t.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    filter === t.key
                      ? "border-primary/60 bg-primary/15 text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/40"
                  )}
                >
                  {t.label}
                  <span className="text-muted-foreground tabular-nums">{t.count}</span>
                </button>
              ))}
              <div className="relative ml-auto w-full sm:w-48">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </div>
          </>
        )}

        <div className="-mx-6 max-h-[60vh] overflow-y-auto px-6 pt-2 pb-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Could not load requests: {error}
            </p>
          ) : !data || data.requests.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No requests found for this user.
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No requests match the current filter.
            </p>
          ) : (
            <TooltipProvider delayDuration={200}>
              <ul className="space-y-1.5">
                {filtered.map((r) => (
                  <RequestRow key={r.seerrId} req={r} onClose={onClose} />
                ))}
              </ul>
            </TooltipProvider>
          )}
        </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

function RequestRow({ req, onClose }: { req: ResolvedRequest; onClose: () => void }) {
  const TypeIcon = req.type === "movie" ? Film : Tv;
  const statusInfo = mediaStatusLabel(req.mediaStatus);
  const StatusIcon = statusInfo.icon;
  const reqStatus = requestStatusLabel(req.status);

  const watchedBadge = (() => {
    if (!req.watch.correlatable) return null;
    if (req.type === "movie") {
      return req.watch.watched ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
          <Eye className="h-3 w-3" />
          Watched
        </span>
      ) : null;
    }
    // series
    if (req.watch.episodesAvailable === 0) return null;
    const pct = Math.round(
      (req.watch.episodesWatched / req.watch.episodesAvailable) * 100
    );
    const tone =
      pct >= 75 ? "text-emerald-300" : pct >= 25 ? "text-foreground" : "text-amber-300";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1 text-xs", tone)}>
            <Eye className="h-3 w-3" />
            {req.watch.episodesWatched}/{req.watch.episodesAvailable}
            <span className="text-muted-foreground">({pct}%)</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {req.watch.episodesWatched} of {req.watch.episodesAvailable} episodes watched
        </TooltipContent>
      </Tooltip>
    );
  })();

  const titleNode = (
    <>
      <span className="truncate">{req.title}</span>
      {req.year && <span className="ml-1.5 text-muted-foreground">({req.year})</span>}
    </>
  );

  const inner = (
    <div className="flex items-center gap-3 min-w-0">
      <PosterThumb url={req.posterUrl} type={req.type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <TypeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium flex items-center min-w-0">
            {titleNode}
          </span>
          {req.is4k && (
            <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
              4K
            </span>
          )}
          {req.mediaItem && (
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary" />
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium",
              statusInfo.tone
            )}
          >
            <StatusIcon className="h-3 w-3" />
            {statusInfo.label}
          </span>
          {reqStatus && (
            <span className="text-muted-foreground">
              · {reqStatus}
            </span>
          )}
          {watchedBadge && <span className="ml-auto sm:ml-2">{watchedBadge}</span>}
          <span className="ml-auto text-muted-foreground tabular-nums">
            {formatRelativeDate(req.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );

  if (req.mediaItem) {
    const href =
      req.mediaItem.route === "movie"
        ? `/library/movies/${req.mediaItem.id}`
        : `/library/series/show/${req.mediaItem.id}`;
    return (
      <li>
        <Link
          href={href}
          onClick={onClose}
          className="group block rounded-md border border-transparent p-2 hover:border-border hover:bg-muted/30 transition-colors"
        >
          {inner}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="rounded-md p-2 opacity-80">{inner}</div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1">
            <ExternalLink className="h-3 w-3" />
            Not in your library
          </span>
        </TooltipContent>
      </Tooltip>
    </li>
  );
}
