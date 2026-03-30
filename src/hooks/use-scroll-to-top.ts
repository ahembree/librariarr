"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { findScrollContainer } from "@/lib/scroll-utils";

/**
 * Scrolls the main scroll container to the top on every route change.
 *
 * Next.js App Router resets `window.scrollTop` on navigation, but this app
 * uses `<main>` with `overflow-y-auto` as the scroll container, so the
 * built-in reset has no effect. This hook fills that gap.
 *
 * Pages that use `useScrollRestoration` are unaffected — their
 * `requestAnimationFrame`-based restore fires after this hook's `useEffect`,
 * so back-navigation still restores the saved position.
 */
export function useScrollToTop() {
  const pathname = usePathname();
  const prevPathname = useRef(pathname);

  useEffect(() => {
    if (pathname === prevPathname.current) return;
    prevPathname.current = pathname;

    findScrollContainer()?.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);
}
