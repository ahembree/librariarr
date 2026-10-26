"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AppEventType } from "@/lib/events/event-bus";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { detailPrefetch, mediaRecordUrl, prefetchMediaDetail, type DetailChildList } from "@/lib/media/detail-prefetch";
import { buildPlayLinks, type PlayServer } from "@/lib/play-url";
import { syncCompletedConcerns } from "@/lib/media/sync-scope";
import type { MediaItemWithRelations } from "@/lib/types";

/** `buildPlayLinks`' link spec: `[label, rating-key field]` per link. */
type PlayLinkSpec = Parameters<typeof buildPlayLinks>[1];

export interface MediaDetailRecordOptions {
  mediaType: "MOVIE" | "SERIES" | "MUSIC";
  /** Start the per-item play list with the record (movie and track pages). */
  plays: boolean;
  /**
   * Start the Arr/Seerr matches with the record (default true). False on the
   * artist and album pages, which show no integration cards: the prefetch
   * would ask every Lidarr instance for an answer nothing reads.
   */
  integrations?: boolean;
  /** Start the page's child list with the record (`detailChildrenUrl`; read it with `useDetailChildren`). */
  children?: DetailChildList;
  /** The play links to build from the record's `playServers`; none keeps them as sent. */
  playLinks?: PlayLinkSpec;
  /**
   * Events after which what the page shows may be stale; each one bumps
   * `syncTick` (a `refreshKey` for the play list). Default `sync:completed`.
   */
  tickOn?: readonly AppEventType[];
  /**
   * Re-read the record itself on every tick (the episode, show and season
   * pages). The movie and track pages refetch only their play list.
   */
  refetchOnTick?: boolean;
}

export interface MediaDetailRecord {
  item: MediaItemWithRelations | null;
  playServers: PlayServer[];
  /** True until the first read for the page answers. */
  loading: boolean;
  /** Bumped by each `tickOn` event. */
  syncTick: number;
}

const DEFAULT_TICK_ON: readonly AppEventType[] = ["sync:completed"];

/**
 * A media detail page's record (`/api/media/[id]`) — what the seven detail
 * pages each loaded the same way: everything else the page needs by id
 * started beside it (`prefetchMediaDetail`, once per id, so a refetch on a
 * sync tick does not start requests the mounted cards will never take), the
 * record read through the prefetch store, and a slower answer for an earlier
 * id never replacing a later one.
 */
export function useMediaDetailRecord(id: string, options: MediaDetailRecordOptions): MediaDetailRecord {
  const { mediaType, plays, integrations = true, children, refetchOnTick = false, tickOn = DEFAULT_TICK_ON } = options;
  const [item, setItem] = useState<MediaItemWithRelations | null>(null);
  const [playServers, setPlayServers] = useState<PlayServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncTick, setSyncTick] = useState(0);
  const latest = useLatestRequest();
  const playLinksRef = useRef(options.playLinks);
  useEffect(() => {
    playLinksRef.current = options.playLinks;
  });

  useRealtimeEvents(tickOn, (data) => {
    // A sync that names the library types it wrote, none of them this page's,
    // changed nothing here (only `sync:completed` carries `libraryTypes`; any
    // other event, and a reconnect's resync, still ticks).
    if (!syncCompletedConcerns(data, { types: mediaType })) return;
    setSyncTick((t) => t + 1);
  });

  // Before the record's own effect, so the record request below is the one
  // started here and is taken from the store rather than asked for twice.
  useEffect(() => {
    prefetchMediaDetail(id, { mediaType, plays, integrations, children });
  }, [id, mediaType, plays, integrations, children]);

  const recordTick = refetchOnTick ? syncTick : 0;
  useEffect(() => {
    const token = latest.begin();
    void (async () => {
      try {
        const { body } = await detailPrefetch.fetch<{ item?: MediaItemWithRelations; playServers?: PlayServer[] }>(
          mediaRecordUrl(id),
        );
        if (!latest.isCurrent(token)) return;
        if (body?.item) {
          setItem(body.item);
          const links = playLinksRef.current;
          setPlayServers(links ? buildPlayLinks(body.playServers || [], links) : body.playServers || []);
        }
      } finally {
        if (latest.isCurrent(token)) setLoading(false);
      }
    })();
  }, [id, recordTick, latest]);

  return { item, playServers, loading, syncTick };
}

/**
 * Where the detail page's Back link goes when it was opened from a listing
 * other than its default one: `?from=/library/series/episodes` with that path
 * in `labels` ("All Episodes") — null for no `from`, or one not listed (a
 * link that could point anywhere is never followed).
 */
export function useBackOverride(labels: Readonly<Record<string, string>>): { href: string; label: string } | null {
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  return useMemo(() => {
    if (!from) return null;
    const label = labels[from];
    return label ? { href: from, label } : null;
  }, [from, labels]);
}
