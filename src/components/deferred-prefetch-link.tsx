"use client";

import type { ComponentProps } from "react";
import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";

/** How long a busy page may hold prefetching back once it has loaded. */
const IDLE_TIMEOUT_MS = 2000;
/** Safari has no `requestIdleCallback`: wait this long after `load` instead. */
const NO_IDLE_CALLBACK_DELAY_MS = 500;
/**
 * The longest prefetching waits for `load`, which a slow image (a poster the
 * media server is still resizing) holds back for as long as it takes.
 */
const LOAD_WAIT_CAP_MS = 5000;

let ready = false;
let armed = false;
const listeners = new Set<() => void>();

function markReady() {
  if (ready) return;
  ready = true;
  for (const listener of listeners) listener();
}

function arm() {
  if (armed) return;
  armed = true;
  let waited = false;
  const whenIdle = () => {
    if (waited) return;
    waited = true;
    window.removeEventListener("load", whenIdle);
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(markReady, { timeout: IDLE_TIMEOUT_MS });
    } else {
      setTimeout(markReady, NO_IDLE_CALLBACK_DELAY_MS);
    }
  };
  if (document.readyState === "complete") {
    whenIdle();
  } else {
    window.addEventListener("load", whenIdle, { once: true });
    setTimeout(whenIdle, LOAD_WAIT_CAP_MS);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isReady = () => ready;
const notReady = () => false;

/**
 * Whether links may prefetch: false until the page the tab opened on has
 * loaded and the browser is idle, then true for the life of the tab.
 *
 * Every link in view prefetches as soon as it mounts, and on a page load that
 * is while the page is still hydrating. A phone spent the start of the
 * dashboard's load rendering four other pages on the server and parsing their
 * payloads beside its own hydration, twice. A client-side navigation after
 * that prefetches at once, as before.
 */
export function usePrefetchReady(): boolean {
  const value = useSyncExternalStore(subscribe, isReady, notReady);
  useEffect(arm, []);
  return value;
}

/**
 * `next/link` whose prefetch (`prefetch` as given — full, or the default when
 * absent) starts only once `usePrefetchReady` allows it. A click before then
 * navigates as an unprefetched link does.
 */
export function DeferredPrefetchLink({ prefetch, ...props }: ComponentProps<typeof Link>) {
  const prefetchReady = usePrefetchReady();
  return <Link {...props} prefetch={prefetchReady ? prefetch : false} />;
}
