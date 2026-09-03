"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { History, Loader2, Monitor, User } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { Button } from "@/components/ui/button";
import { SERVER_TYPE_STYLES, DEFAULT_SERVER_STYLE } from "@/lib/server-styles";

/** How many plays each request pulls; "Load more" appends another page. */
const PAGE_SIZE = 25;

interface WatchHistoryRow {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  };
  server: { id: string; name: string; type: string };
}

interface WatchHistoryResponse {
  items: WatchHistoryRow[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
}

interface SeriesWatchHistoryProps {
  /**
   * Series identity (see src/lib/media/series-key.ts) — the preferred way to
   * scope the history, so two same-titled shows don't blend. Falls back to
   * `parentTitle` when absent (legacy callers). At least one is required.
   */
  seriesKey?: string | null;
  /** Series name — the `parentTitle` every episode row carries. Fallback identifier. */
  parentTitle?: string | null;
  /** Restrict to one season. Omit for the whole series. */
  seasonNumber?: number | null;
  /** Restrict to one episode (with `seasonNumber`). Omit for all episodes. */
  episodeNumber?: number | null;
  /** Restrict to one server; omit to merge history across every server. */
  serverId?: string | null;
  /** Section heading. */
  heading?: string;
  /**
   * These rows are all the same episode — the one whose page this is. The
   * episode is still named on every row (so a play says exactly what was
   * watched), but as plain text rather than a link back to the page you are
   * already on.
   */
  currentEpisode?: boolean;
  /** Bump to refetch — e.g. on a `sync:completed` realtime event. */
  refreshKey?: number;
  /**
   * `section` (default): a full-width block under a series/season page.
   * `card`: one of the detail cards in `MediaDetailContent`'s grid — the
   * episode page passes it through `historySection` so this per-play list
   * *is* the episode's Watch History card, rather than a second section
   * beneath the per-user aggregate showing the same plays.
   */
  variant?: "section" | "card";
}

function episodeLabel(row: WatchHistoryRow): string | null {
  const { seasonNumber, episodeNumber } = row.mediaItem;
  if (seasonNumber == null || episodeNumber == null) return null;
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

/**
 * Absolute date + time for a play. Watch history is about *when* something was
 * played, so the clock time is part of the answer, not decoration — a relative
 * "2d ago" alone can't distinguish two plays on the same evening.
 */
function formatWatchedAt(dateStr: string | null): string {
  if (!dateStr) return "Unknown date";
  const date = new Date(dateStr);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const watchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - watchDay.getTime()) / 86400000);

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  const day = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
  return `${day} ${time}`;
}

function formatPlayCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "play" : "plays"}`;
}

interface PlayRowProps {
  row: WatchHistoryRow;
  /** Render the episode as plain text instead of a self-link (see the prop). */
  currentEpisode: boolean;
  /** Only worth naming the server when the plays actually span more than one. */
  multiServer: boolean;
  card: boolean;
}

function PlayRow({ row, currentEpisode, multiServer, card }: PlayRowProps) {
  const label = episodeLabel(row);
  const device = row.deviceName || row.platform;

  const episode = (
    <div className={card ? "mb-1 flex min-w-0 items-center gap-2" : "flex min-w-0 items-center gap-2 sm:flex-1"}>
      {label && (
        <ColorChip className="border-border font-mono text-muted-foreground">{label}</ColorChip>
      )}
      {currentEpisode ? (
        <span className="truncate font-medium" title={row.mediaItem.title}>
          {row.mediaItem.title}
        </span>
      ) : (
        <Link
          href={`/library/series/episode/${row.mediaItem.id}`}
          className="truncate font-medium hover:text-primary hover:underline"
          title={row.mediaItem.title}
        >
          {row.mediaItem.title}
        </Link>
      )}
    </div>
  );
  const serverChip = multiServer && (
    <ColorChip className={(SERVER_TYPE_STYLES[row.server.type] ?? DEFAULT_SERVER_STYLE).classes}>
      {row.server.name}
    </ColorChip>
  );
  const watchedAt = (
    <span className="font-mono tabular-nums" title={row.watchedAt ?? undefined}>
      {formatWatchedAt(row.watchedAt)}
    </span>
  );

  if (card) {
    // Card columns are narrow, so the row keeps the shape of the other detail
    // cards' rows: name on the left with a muted secondary line, one mono
    // value on the right.
    return (
      <li className="rounded-lg bg-muted/50 px-3 py-2 text-sm transition-colors hover:bg-muted/70">
        {episode}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <span className="font-medium">{row.serverUsername}</span>
            {(device || serverChip) && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {device && (
                  <span className="flex min-w-0 items-center gap-1" title={device}>
                    <Monitor className="h-3 w-3 shrink-0" />
                    <span className="truncate">{device}</span>
                  </span>
                )}
                {serverChip}
              </div>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{watchedAt}</span>
        </div>
      </li>
    );
  }

  return (
    // Stacks below `sm`: the metadata block can't shrink (chips and the
    // timestamp don't wrap), so side-by-side on a phone squeezed the title to
    // a single clipped character and overlapped it.
    <li className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm transition-colors hover:bg-muted/70 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      {episode}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:shrink-0 sm:flex-nowrap">
        <span className="flex items-center gap-1">
          <User className="h-3 w-3" />
          <span className="font-medium text-foreground/80">{row.serverUsername}</span>
        </span>
        {device && (
          <span className="flex items-center gap-1" title={device}>
            <Monitor className="h-3 w-3" />
            <span className="max-w-[10rem] truncate">{device}</span>
          </span>
        )}
        {serverChip}
        {watchedAt}
      </div>
    </li>
  );
}

/**
 * Per-play watch history for a series, a single season, or a single episode —
 * who watched, when, and which episode.
 *
 * Reads `/api/media/series/watch-history` (the stored `WatchHistory` table).
 * `MediaDetailContent`'s built-in history card answers a different question
 * (how many plays per user, fetched live from the server) and has no per-play
 * timestamps, so it can't stand in for this — which is why the episode page
 * swaps that card for this component (`variant="card"`) instead of showing
 * both.
 */
export function SeriesWatchHistory({
  seriesKey,
  parentTitle,
  seasonNumber,
  episodeNumber,
  serverId,
  heading = "Watch History",
  currentEpisode = false,
  refreshKey = 0,
  variant = "section",
}: SeriesWatchHistoryProps) {
  const [rows, setRows] = useState<WatchHistoryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // Guards against a stale slow response landing after the scope changed and
  // overwriting the current series'/season's rows.
  const reqToken = useRef(0);

  const loadPage = useCallback(
    async (page: number, token: number) => {
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_SIZE),
        });
        if (seriesKey) params.set("seriesKey", seriesKey);
        else if (parentTitle) params.set("parentTitle", parentTitle);
        if (seasonNumber != null) params.set("seasonNumber", String(seasonNumber));
        if (episodeNumber != null) params.set("episodeNumber", String(episodeNumber));
        if (serverId) params.set("serverId", serverId);

        const res = await fetch(`/api/media/series/watch-history?${params}`);
        if (!res.ok) throw new Error("Failed to load watch history");
        const data: WatchHistoryResponse = await res.json();
        if (token !== reqToken.current) return;

        setRows((prev) => (page === 1 ? data.items : [...prev, ...data.items]));
        setTotalCount(data.pagination.totalCount);
        setHasMore(data.pagination.hasMore);
      } catch {
        if (token === reqToken.current) setError(true);
      } finally {
        if (token !== reqToken.current) return;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [seriesKey, parentTitle, seasonNumber, episodeNumber, serverId],
  );

  // Reset to the loading state when the scope changes, so a new series/season
  // never shows the previous one's plays while its own request is in flight.
  // (set-state-during-render is React 19's idiom for "reset state on prop change" —
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-state-when-a-prop-changes)
  const scopeKey = `${seriesKey ?? parentTitle ?? ""}|${seasonNumber ?? ""}|${episodeNumber ?? ""}|${serverId ?? ""}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setRows([]);
    setTotalCount(0);
    setHasMore(false);
    setError(false);
    setLoading(true);
  }

  useEffect(() => {
    const token = ++reqToken.current;
    void (async () => {
      await loadPage(1, token);
    })();
  }, [loadPage, refreshKey]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    // The next page is derived from what's already rendered, so a "Load more"
    // that races a refresh can't skip a page.
    void loadPage(Math.floor(rows.length / PAGE_SIZE) + 1, reqToken.current);
  }, [loadPage, rows.length]);

  const card = variant === "card";
  // Only worth naming the server when the plays actually span more than one.
  const multiServer = new Set(rows.map((r) => r.server.id)).size > 1;

  const body = loading ? (
    <div className="space-y-2">
      {(card ? [0, 1] : [0, 1, 2]).map((i) => (
        <div
          key={i}
          className="flex animate-pulse items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5"
        >
          <div className="space-y-1.5">
            <div className={card ? "h-3 w-20 rounded bg-muted-foreground/20" : "h-3 w-40 rounded bg-muted-foreground/20"} />
            <div className={card ? "h-2 w-28 rounded bg-muted-foreground/10" : "h-2 w-24 rounded bg-muted-foreground/10"} />
          </div>
          <div className={card ? "h-2.5 w-12 rounded bg-muted-foreground/10" : "h-2.5 w-20 rounded bg-muted-foreground/10"} />
        </div>
      ))}
    </div>
  ) : error ? (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/5 bg-muted/30 px-3 py-6 text-center">
      <History className="h-5 w-5 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">Could not load watch history</p>
    </div>
  ) : rows.length === 0 ? (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/5 bg-muted/30 px-3 py-6 text-center">
      <History className="h-5 w-5 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">No watch history yet</p>
    </div>
  ) : (
    <>
      <ul className={card ? "space-y-2" : "space-y-1.5"}>
        {rows.map((row) => (
          <PlayRow key={row.id} row={row} currentEpisode={currentEpisode} multiServer={multiServer} card={card} />
        ))}
      </ul>

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </>
  );

  if (card) {
    // Same shell and heading treatment as the other cards in the detail grid.
    return (
      <div className="rounded-xl border border-white/6 bg-card p-5 shadow-[var(--shadow-card)] space-y-3">
        <h3 className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          <History className="h-3.5 w-3.5" />
          {heading}
          {!loading && totalCount > 0 && (
            <span className="text-xs font-normal normal-case">({formatPlayCount(totalCount)})</span>
          )}
        </h3>
        {body}
      </div>
    );
  }

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {heading}
        </h2>
        {!loading && totalCount > 0 && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatPlayCount(totalCount)}
          </span>
        )}
      </div>
      {body}
    </section>
  );
}
