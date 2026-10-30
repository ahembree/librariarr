"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768; // md breakpoint
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches;
}

/**
 * The server's guess at whether the request came from a phone (`isLikelyPhone`,
 * read by the authenticated layout): what the server render and the render
 * that hydrates it lay out. False outside the shell.
 */
export const MobileGuessContext = createContext(false);

export function useIsMobile() {
  const guess = useContext(MobileGuessContext);
  return useSyncExternalStore(subscribe, getSnapshot, () => guess);
}
