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
  Loader2,
  ArrowUpRight,
  Calendar,
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

type FilterTab = "all" | "movies" | "series" | "watched" | "pending" | "missing";

interface MediaStatusInfo {
  label: string;
  chipClass: string;
  borderClass: string;
  icon: typeof Check;
}

// Seerr media status: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIAL, 5=AVAILABLE, 6=DELETED
function mediaStatusInfo(s: number): MediaStatusInfo {
  switch (s) {
    case 5:
      return {
        label: "Available",
        chipClass: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/20",
        borderClass: "border-l-emerald-500/60",
        icon: Check,
      };
    case 4:
      return {
        label: "Partial",
        chipClass: "text-sky-300 bg-sky-500/10 ring-sky-500/20",
        borderClass: "border-l-sky-500/60",
        icon: Check,
      };
    case 3:
      return {
        label: "Processing",
        chipClass: "text-blue-300 bg-blue-500/10 ring-blue-500/20",
        borderClass: "border-l-blue-500/60",
        icon: Clock,
      };
    case 2:
      return {
        label: "Pending",
        chipClass: "text-amber-300 bg-amber-500/10 ring-amber-500/20",
        borderClass: "border-l-amber-500/60",
        icon: Clock,
      };
    case 6:
      return {
        label: "Deleted",
        chipClass: "text-rose-300 bg-rose-500/10 ring-rose-500/20",
        borderClass: "border-l-rose-500/60",
        icon: AlertCircle,
      };
    default:
      return {
        label: "Unknown",
        chipClass: "text-muted-foreground bg-muted/40 ring-border/40",
        borderClass: "border-l-transparent",
        icon: AlertCircle,
      };
  }
}

// Seerr request status: 1=PENDING, 2=APPROVED, 3=DECLINED
function requestStatusLabel(s: number): string | null {
  if (s === 1) return "Pending approval";
  if (s === 3) return "Declined";
  return null;
}

const AVATAR_PALETTE = [
  "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
  "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function UserAvatar({ name }: { name: string }) {
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  const color = AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length];
  return (
    <span
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ring-1 shrink-0",
        color
      )}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function PosterThumb({ url, type }: { url: string | null; type: "movie" | "tv" }) {
  const Icon = type === "movie" ? Film : Tv;
  const [errored, setErrored] = useState(false);
  const showImage = url && !errored;
  return (
    <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/40">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
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
      <DialogContent className="max-w-[75vw] sm:max-w-[75vw] w-[75vw] gap-0 p-0 overflow-hidden">
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
      if (filter === "missing" && r.mediaItem != null) return false;
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filter, search]);

  const stats = useMemo(() => {
    if (!data) {
      return { total: 0, movies: 0, series: 0, watched: 0, pending: 0, missing: 0, watchedPct: null as number | null };
    }
    let movies = 0;
    let series = 0;
    let watched = 0;
    let pending = 0;
    let missing = 0;
    let watchNum = 0;
    let watchDenom = 0;
    for (const r of data.requests) {
      if (r.type === "movie") {
        movies++;
        if (r.watch.correlatable) {
          watchDenom += 1;
          if (r.watch.watched) watchNum += 1;
        }
      } else {
        series++;
        if (r.watch.correlatable && r.watch.episodesAvailable > 0) {
          watchDenom += r.watch.episodesAvailable;
          watchNum += r.watch.episodesWatched;
        }
      }
      if (r.watch.correlatable && (r.type === "movie" ? r.watch.watched : r.watch.episodesWatched > 0)) {
        watched++;
      }
      if (r.mediaStatus === 2 || r.mediaStatus === 3) pending++;
      if (r.mediaItem == null) missing++;
    }
    return {
      total: data.requests.length,
      movies,
      series,
      watched,
      pending,
      missing,
      watchedPct: watchDenom > 0 ? Math.round((watchNum / watchDenom) * 100) : null,
    };
  }, [data]);

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: stats.total },
    { key: "movies", label: "Movies", count: stats.movies },
    { key: "series", label: "Series", count: stats.series },
    { key: "watched", label: "Watched", count: stats.watched },
    { key: "pending", label: "In progress", count: stats.pending },
    { key: "missing", label: "Not in library", count: stats.missing },
  ];

  const displayName = data?.user?.seerrUsername ?? userKey;

  return (
    <>
      <DialogHeader className="border-b border-border bg-muted/20 px-6 py-4">
        <div className="flex items-start gap-3">
          <UserAvatar name={displayName} />
          <div className="flex-1 min-w-0">
            <DialogTitle className="text-base font-display tracking-tight flex items-center gap-2">
              <span className="truncate">{displayName}</span>
              <span className="text-muted-foreground font-normal">&apos;s requests</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Seerr request history for {displayName}.
            </DialogDescription>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {loading ? (
                <span>Loading…</span>
              ) : !data ? null : (
                <>
                  <span>
                    <span className="font-medium text-foreground">{stats.total}</span>{" "}
                    {stats.total === 1 ? "request" : "requests"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Film className="h-3 w-3" />
                    <span className="font-medium text-foreground">{stats.movies}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Tv className="h-3 w-3" />
                    <span className="font-medium text-foreground">{stats.series}</span>
                  </span>
                  {stats.watchedPct != null && (
                    <span className="inline-flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      <span
                        className={cn(
                          "font-medium",
                          stats.watchedPct >= 75
                            ? "text-emerald-300"
                            : stats.watchedPct >= 40
                              ? "text-foreground"
                              : "text-amber-300"
                        )}
                      >
                        {stats.watchedPct}%
                      </span>{" "}
                      watched
                    </span>
                  )}
                  {data.user?.plexUsername == null && stats.total > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <EyeOff className="h-3 w-3" />
                      no linked Plex username
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </DialogHeader>

      {!loading && data && data.requests.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setFilter(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                filter === t.key
                  ? "border-primary/70 bg-primary/20 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/40"
              )}
            >
              {t.label}
              <span
                className={cn(
                  "tabular-nums",
                  filter === t.key ? "text-foreground/80" : "text-muted-foreground/70"
                )}
              >
                {t.count}
              </span>
            </button>
          ))}
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>
      )}

      <div className="max-h-[65vh] overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Could not load requests: {error}
          </p>
        ) : !data || data.requests.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No requests found for this user.
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No requests match the current filter.
          </p>
        ) : (
          <TooltipProvider delayDuration={200}>
            <ul className="space-y-2">
              {filtered.map((r) => (
                <RequestRow key={r.seerrId} req={r} onClose={onClose} />
              ))}
            </ul>
          </TooltipProvider>
        )}
      </div>
    </>
  );
}

function WatchProgress({ watched, total }: { watched: number; total: number }) {
  const pct = total > 0 ? Math.round((watched / total) * 100) : 0;
  const tone =
    pct >= 75 ? "bg-emerald-500/70" : pct >= 40 ? "bg-primary/70" : pct > 0 ? "bg-amber-500/70" : "bg-muted-foreground/30";
  const textTone =
    pct >= 75 ? "text-emerald-300" : pct >= 40 ? "text-foreground" : pct > 0 ? "text-amber-300" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-muted/40">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("text-xs font-medium tabular-nums", textTone)}>
        {watched}/{total}
      </span>
    </div>
  );
}

function RequestRow({ req, onClose }: { req: ResolvedRequest; onClose: () => void }) {
  const TypeIcon = req.type === "movie" ? Film : Tv;
  const statusInfo = mediaStatusInfo(req.mediaStatus);
  const StatusIcon = statusInfo.icon;
  const reqStatus = requestStatusLabel(req.status);
  const isClickable = req.mediaItem != null;

  const inner = (
    <div className="flex items-stretch gap-4 min-w-0">
      <PosterThumb url={req.posterUrl} type={req.type} />
      <div className="flex-1 min-w-0 flex flex-col py-0.5">
        <div className="flex items-start gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <TypeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <h4 className="truncate text-sm font-medium font-display tracking-tight">
                {req.title}
                {req.year && (
                  <span className="ml-1.5 font-normal text-muted-foreground">({req.year})</span>
                )}
              </h4>
              {req.is4k && (
                <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300 shrink-0">
                  4K
                </span>
              )}
              {isClickable && (
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {formatRelativeDate(req.createdAt)}
              </span>
              {reqStatus && (
                <span className="inline-flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {reqStatus}
                </span>
              )}
              {!isClickable && (
                <span className="text-muted-foreground/70 italic">Not in your library</span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
                statusInfo.chipClass
              )}
            >
              <StatusIcon className="h-3 w-3" />
              {statusInfo.label}
            </span>
            {req.watch.correlatable && req.type === "movie" && req.watch.watched && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                <Eye className="h-3 w-3" />
                Watched
              </span>
            )}
            {req.watch.correlatable && req.type === "tv" && req.watch.episodesAvailable > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <WatchProgress
                      watched={req.watch.episodesWatched}
                      total={req.watch.episodesAvailable}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {req.watch.episodesWatched} of {req.watch.episodesAvailable} episodes watched
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const baseClasses = cn(
    "group block rounded-md border-l-2 bg-card/30 p-3 transition-colors",
    statusInfo.borderClass
  );

  if (isClickable && req.mediaItem) {
    const href =
      req.mediaItem.route === "movie"
        ? `/library/movies/${req.mediaItem.id}`
        : `/library/series/show/${req.mediaItem.id}`;
    return (
      <li>
        <Link
          href={href}
          onClick={onClose}
          className={cn(baseClasses, "hover:bg-muted/40 cursor-pointer")}
        >
          {inner}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <div className={cn(baseClasses, "opacity-80")}>{inner}</div>
    </li>
  );
}
