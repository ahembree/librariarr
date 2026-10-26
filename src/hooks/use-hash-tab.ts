"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readUrlHash, replaceUrlHash, subscribeToUrlHash } from "@/lib/url-hash";

/** Server snapshot for the URL hash: the server never sees it. */
const noUrlHash = () => "";

/** The tab a URL hash names, or null for no hash or one that names none. */
export function tabFromHash<T extends string>(hash: string, validTabs: readonly T[]): T | null {
  const tab = hash.slice(1);
  return (validTabs as readonly string[]).includes(tab) ? (tab as T) : null;
}

/**
 * A page tab that IS the URL hash (`/settings#servers`), read through the
 * store in `src/lib/url-hash.ts` — see there for why not once on mount: on a
 * client-side navigation the router renders the incoming page before writing
 * the URL, so a one-time read took the previous page's hash.
 *
 * Returns the open tab (`fallback` for no hash or an unknown one) and the
 * setter, which replaces the hash without a history entry. A URL naming no
 * tab is pointed at the fallback it shows — read live, not from this render's
 * tab, since on a client-side navigation that effect runs before the store
 * has re-read the hash the router just wrote, and normalising from the
 * render's value would overwrite the hash the link asked for.
 *
 * On the server and while hydrating, the hash reads as empty, so the tab is
 * `fallback`; a page whose content depends on the tab renders a placeholder
 * until `useHydrated()` turns true.
 */
export function useHashTab<T extends string>(validTabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const urlHash = useSyncExternalStore(subscribeToUrlHash, readUrlHash, noUrlHash);
  const tabsKey = validTabs.join("\n");
  const activeTab = tabFromHash(urlHash, validTabs) ?? fallback;

  useEffect(() => {
    if (!tabFromHash(readUrlHash(), tabsKey.split("\n"))) replaceUrlHash(`#${fallback}`);
  }, [urlHash, tabsKey, fallback]);

  const setTab = useCallback((tab: T) => replaceUrlHash(`#${tab}`), []);
  return [activeTab, setTab];
}
