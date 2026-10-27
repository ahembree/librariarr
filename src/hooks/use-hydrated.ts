"use client";

import { useSyncExternalStore } from "react";

const subscribeNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * False while server-rendering and while hydrating the server's HTML, true
 * from then on — and on the very first render of a component mounted by a
 * client-side navigation. For content that depends on something only the
 * browser knows (the URL hash, localStorage): render what the server rendered
 * until this turns true, and no hydration mismatch is possible.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNothing, onClient, onServer);
}
