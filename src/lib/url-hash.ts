/**
 * The page URL's hash as an external store for `useSyncExternalStore` — for
 * pages that keep their open tab in it (Settings, Lifecycle Rules).
 *
 * Reading the hash once, in a `useState` initializer, picked the wrong tab on
 * a client-side navigation: the router renders the incoming page before it
 * writes the new URL, so a link from another page to
 * `/settings#authentication` rendered with the previous page's hash, opened
 * General, and then rewrote the URL to `#general`. `useSyncExternalStore`
 * re-reads the snapshot once it has subscribed after mounting, which is after
 * the router's write, so the page re-renders on the right tab.
 *
 * Three things change the hash afterwards: the page itself (a tab click,
 * through `replaceUrlHash`, which notifies the store), the browser (back,
 * forward, a hand-edited hash — `popstate` / `hashchange`), and the router,
 * whose links write the URL with `history.pushState`, which fires neither. A
 * link to another tab while the page is open does not remount it, so the
 * Navigation API's `currententrychange` — which `pushState` does fire — is
 * subscribed where the browser has it.
 */

const listeners = new Set<() => void>();

/** `useSyncExternalStore` snapshot: the hash including its `#`, or "". */
export function readUrlHash(): string {
  return window.location.hash;
}

export function subscribeToUrlHash(onChange: () => void): () => void {
  let active = true;
  // Deferred to a microtask: the router writes the URL from inside a React
  // commit, where scheduling an update is not allowed.
  const notify = () => {
    queueMicrotask(() => {
      if (active) onChange();
    });
  };
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  listeners.add(onChange);
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  navigation?.addEventListener("currententrychange", notify);
  return () => {
    active = false;
    listeners.delete(onChange);
    window.removeEventListener("hashchange", notify);
    window.removeEventListener("popstate", notify);
    navigation?.removeEventListener("currententrychange", notify);
  };
}

/**
 * Point the URL at `hash` without a history entry (a tab change is not a page
 * the back button should step through) and tell every subscriber. The state
 * is `null` so the router copies its own state across and records the new URL
 * as its current one — given its own state it skips that, and its next
 * history write puts the old hash back.
 */
export function replaceUrlHash(hash: string): void {
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash);
  }
  for (const listener of [...listeners]) listener();
}
