"use client";

import { useCallback, useMemo, useRef } from "react";

export interface LatestRequest {
  /** Start a request: its token, which every earlier token stops being current to. */
  begin(): number;
  /** Whether `token` is still the latest request (no later `begin` or `cancel`). */
  isCurrent(token: number): boolean;
  /** Make every request started so far stale — on unmount, or when the input is cleared. */
  cancel(): void;
}

/**
 * The guard a component puts around a request whose answer may arrive after
 * a newer one was started (a filter changed, another item was clicked): only
 * the latest request's answer is applied.
 *
 * ```ts
 * const latest = useLatestRequest();
 * const load = async () => {
 *   const token = latest.begin();
 *   const data = await fetchSomething();
 *   if (!latest.isCurrent(token)) return;
 *   setData(data);
 * };
 * ```
 *
 * The same `reqToken = useRef(0)` pattern was written out by hand in some
 * twenty-five components. The returned object is stable.
 */
export function useLatestRequest(): LatestRequest {
  const counter = useRef(0);
  const begin = useCallback(() => {
    counter.current += 1;
    return counter.current;
  }, []);
  const isCurrent = useCallback((token: number) => token === counter.current, []);
  const cancel = useCallback(() => {
    counter.current += 1;
  }, []);
  return useMemo(() => ({ begin, isCurrent, cancel }), [begin, isCurrent, cancel]);
}
