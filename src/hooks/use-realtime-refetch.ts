"use client";

import { useCallback, useEffect, useRef } from "react";
import { isRealtimeLive, useRealtimeEvents } from "@/hooks/use-realtime";

type EventData = Record<string, unknown>;

/**
 * How long a request that the server announces waits for the announcement
 * before re-reading by itself. The routes emit before they answer, so the
 * event usually lands first; this only covers it arriving a moment after the
 * response, and is what a lost event costs before the page re-reads anyway.
 */
export const OWN_EVENT_GRACE_MS = 1500;

export interface SettleOptions {
  /**
   * The server announces this request's outcome with one of the events (an
   * Execute that ran something, a detection run that answered). False — a
   * refusal, nothing run — re-reads at once.
   */
  expectEvent?: boolean;
  /** Picks this request's announcement out of the events of its types (by its meta). */
  isOwn?: (data: EventData) => boolean;
}

export interface RefetchTicket {
  /**
   * The request has answered: re-read the page's data unless the request's
   * own event reached the page (whose subscription re-read it already), and
   * resolve once the data is re-read either way.
   */
  settle(options?: SettleOptions): Promise<void>;
  /** The request failed or changed nothing: stop watching, re-read nothing. */
  cancel(): void;
}

type Watcher = (data: EventData, reread: Promise<void>) => void;

const anyEvent = () => true;
const noop = () => undefined;

/**
 * A page's re-read on realtime events, shared with the requests of its own
 * those events announce. Every lifecycle run the page starts — Execute,
 * Re-evaluate — re-read the listing when its POST answered, and the event the
 * route emits for the same run re-read it again: two identical requests per
 * click, the slow Pending listing among them.
 *
 * Call `begin()` before the request and `settle()` after it. The event's own
 * re-read is kept, being the one that never misses a change made elsewhere;
 * the direct re-read is skipped when the request's own event arrived during
 * the request or within `OWN_EVENT_GRACE_MS` of its answer. It is never
 * skipped when the stream is not delivering (`isRealtimeLive()` false — a
 * buffering proxy, a dropped connection), so a lost event still leaves one
 * re-read behind it.
 */
export function useRealtimeRefetch(
  eventTypes: readonly string[],
  refetch: () => unknown,
): { begin: () => RefetchTicket } {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });
  const watchers = useRef(new Set<Watcher>());

  // Called synchronously, so inside an event it runs in the event's request
  // scope (`fetchJsonShared`). Its failure is the refetch's to report.
  const reread = useCallback((): Promise<void> => {
    try {
      return Promise.resolve(refetchRef.current()).then(noop, noop);
    } catch {
      return Promise.resolve();
    }
  }, []);

  // A reconnect's resync runs this too (with no meta), which no `isOwn` reads as a request's own.
  useRealtimeEvents(eventTypes, (data) => {
    const done = reread();
    for (const watch of [...watchers.current]) watch(data, done);
  });

  const begin = useCallback((): RefetchTicket => {
    const seen: Array<{ data: EventData; done: Promise<void> }> = [];
    const record: Watcher = (data, done) => {
      seen.push({ data, done });
    };
    watchers.current.add(record);
    let open = true;
    const close = () => {
      open = false;
      watchers.current.delete(record);
    };

    return {
      async settle({ expectEvent = true, isOwn = anyEvent }: SettleOptions = {}) {
        if (!open) return;
        try {
          const arrived = seen.find((s) => isOwn(s.data));
          if (arrived) return await arrived.done;
          if (expectEvent && isRealtimeLive()) {
            // Wrapped: a promise resolved with a promise adopts it, and the
            // re-read's `undefined` would read as "no event".
            const late = await new Promise<{ done: Promise<void> } | null>((resolve) => {
              const wait: Watcher = (data, done) => {
                if (!isOwn(data)) return;
                clearTimeout(timer);
                watchers.current.delete(wait);
                resolve({ done });
              };
              const timer = setTimeout(() => {
                watchers.current.delete(wait);
                resolve(null);
              }, OWN_EVENT_GRACE_MS);
              watchers.current.add(wait);
            });
            if (late) return await late.done;
          }
          await reread();
        } finally {
          close();
        }
      },
      cancel: close,
    };
  }, [reread]);

  return { begin };
}
