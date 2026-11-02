"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { resyncIfEventsSince } from "@/hooks/use-realtime";
import type { DashboardSeed, ServerClock } from "@/lib/dashboard/dashboard-seed-types";

interface SeedContextValue {
  seed: DashboardSeed | null;
  clock: ServerClock | null;
}

const SeedContext = createContext<SeedContextValue>({ seed: null, clock: null });

// Seeds already handed out. A back/forward navigation can restore the page
// from the router's cache with the same seed, long after it was read; those
// mounts fetch as a client-side navigation does.
const consumed = new WeakSet<DashboardSeed>();

/**
 * Gives the dashboard's zones what the server render read for them (`seed`,
 * null on a client-side navigation) and the server's clock (`clock`).
 */
export function DashboardSeedProvider({
  seed,
  clock,
  children,
}: {
  seed: DashboardSeed | null;
  clock: ServerClock | null;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!seed || consumed.has(seed)) return;
    consumed.add(seed);
    // The data was read before this tab's event stream existed.
    resyncIfEventsSince(seed.at);
  }, [seed]);

  const value = useMemo(() => ({ seed, clock }), [seed, clock]);
  return <SeedContext.Provider value={value}>{children}</SeedContext.Provider>;
}

/**
 * The server render's answer for `url`, for a zone's initial state: present on
 * the server render and the render that hydrates it, undefined on any mount
 * after that (a client-side navigation, a page restored from history), where
 * the zone fetches as before. Read it only to initialise state.
 *
 * Deliberately not keyed on `useHydrated`: that would re-render every zone
 * once hydration finishes, for nothing — the seed is marked consumed by the
 * provider's effect, which runs after every zone hydrating with it has taken
 * its answer.
 */
export function useDashboardSeed<T>(url: string): T | undefined {
  const { seed } = useContext(SeedContext);
  if (!seed || consumed.has(seed)) return undefined;
  return seed.bodies[url] as T | undefined;
}

/**
 * The time to format "5m ago" and "in 3h" against: the server's render time
 * until hydration has finished, so both renders write the same text, then
 * undefined — the formatters' own `Date.now()`.
 */
export function useRenderNow(): number | undefined {
  const { clock } = useContext(SeedContext);
  const hydrated = useHydrated();
  return hydrated ? undefined : clock?.at;
}

/** The server's clock until hydration has finished, then null (use the browser's). */
export function useServerClock(): ServerClock | null {
  const { clock } = useContext(SeedContext);
  const hydrated = useHydrated();
  return hydrated ? null : clock;
}

const formatCountEnUs = (n: number) => n.toLocaleString("en-US");
const formatCountLocal = (n: number) => n.toLocaleString();

/**
 * Formats a count ("12,345"): in en-US until hydration has finished, so the
 * server's render and the browser's agree whatever the server's or the
 * browser's locale, then in the browser's.
 */
export function useCountFormat(): (n: number) => string {
  return useHydrated() ? formatCountLocal : formatCountEnUs;
}
