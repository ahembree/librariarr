"use client";

import { useEffect, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { detailChildrenUrl, detailPrefetch, type DetailChildList } from "@/lib/media/detail-prefetch";

export interface DetailChildren<T> {
  /** The list for this id; empty until it has answered. */
  items: T[];
  /** Whether the list for this id has answered (or failed) at least once. */
  loaded: boolean;
}

/**
 * The child list under a detail page's record — a show's seasons, a season's
 * episodes, an album's tracks, an artist's albums — asked for by the page's
 * own id, so it starts beside the record instead of a round trip after it
 * (`useMediaDetailRecord` with the same `children` starts it once per id; the
 * first read here takes that request). Re-read whenever `tick` moves, in
 * parallel with the record's own re-read.
 *
 * `pick` takes the list out of the route's answer (`seasons`, `items`, …). A
 * request that never answered keeps what is on screen; an answer without the
 * list (a 404 for an id that is gone) shows none, as the pages always did.
 */
export function useDetailChildren<T>(
  id: string,
  kind: DetailChildList,
  tick: number,
  pick: (body: Record<string, unknown>) => T[] | undefined,
): DetailChildren<T> {
  const [state, setState] = useState<{ forId: string | null; items: T[] }>({ forId: null, items: [] });
  const latest = useLatestRequest();
  const pickRef = useRef(pick);
  useEffect(() => {
    pickRef.current = pick;
  });

  useEffect(() => {
    const token = latest.begin();
    void detailPrefetch.fetch<Record<string, unknown>>(detailChildrenUrl(kind, id)).then(({ body }) => {
      if (!latest.isCurrent(token)) return;
      setState((prev) => ({
        forId: id,
        items: body ? (pickRef.current(body) ?? []) : prev.forId === id ? prev.items : [],
      }));
    });
  }, [id, kind, tick, latest]);

  const current = state.forId === id;
  return { items: current ? state.items : NONE, loaded: current };
}

// One empty list for every not-yet-answered read, so it is stable for memos.
const NONE: never[] = [];
