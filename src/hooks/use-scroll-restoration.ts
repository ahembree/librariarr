"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Optional callbacks for index-based scroll restoration with virtualized lists.
 * Pixel-based restoration is inaccurate for virtualized grids because estimated
 * row heights differ from measured heights. Index-based restoration scrolls to
 * the correct data item regardless of height calculations.
 */
interface ScrollRestorationOptions {
  /** Return the data index of the item at the center of the viewport. */
  getFirstVisibleIndex?: () => number;
  /** Scroll to center the item at the given data index. Return true if handled. */
  scrollToIndex?: (index: number) => boolean;
}

/**
 * Saves and restores scroll position across navigations.
 * Uses sessionStorage keyed by the provided key.
 *
 * Targets the <main> element as the scroll container (the app shell uses
 * overflow-y-auto on <main>).
 *
 * Scroll state is saved on every scroll event (debounced 150ms) rather than
 * on unmount, because Next.js resets main.scrollTop to 0 during navigation
 * transitions before cleanup effects run — making unmount-time DOM reads
 * unreliable.
 *
 * Scroll is only restored when the user navigated to a child/detail page and
 * came back. Navigating to an unrelated page (e.g., sidebar link) clears the
 * saved state so the page starts at the top on next visit.
 *
 * Call `markChildNavigation()` before `router.push()` to a detail page so
 * that returning will restore scroll position.
 *
 * For virtualized grid pages, pass `options` with callbacks for accurate
 * index-based restoration. Without options, falls back to pixel-based.
 *
 * @param key - A unique key for this page (e.g., "/library/series")
 * @param ready - True when data has loaded and items are rendered
 * @param visibleCount - Current number of visible items (for infinite scroll pages)
 * @param setVisibleCount - Setter to restore visible count before scrolling
 * @param options - Optional virtualizer callbacks for index-based restoration
 */
export function useScrollRestoration(
  key: string,
  ready: boolean,
  visibleCount?: number,
  setVisibleCount?: (n: number) => void,
  options?: ScrollRestorationOptions
) {
  const restored = useRef(false);
  const visibleCountRef = useRef(visibleCount);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    visibleCountRef.current = visibleCount;
  }, [visibleCount]);

  // Save scroll state on every scroll event (debounced).
  // This captures state during normal browsing when DOM values are reliable,
  // avoiding the unmount timing issue where Next.js has already reset scrollTop.
  useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (!main) return;

    let saveTimeout: ReturnType<typeof setTimeout>;

    const saveState = () => {
      const scrollTop = main.scrollTop;
      if (scrollTop <= 0) return;

      const firstVisibleIndex = optionsRef.current?.getFirstVisibleIndex?.() ?? -1;
      const data = {
        scrollTop,
        firstVisibleIndex,
        visibleCount: visibleCountRef.current,
      };
      sessionStorage.setItem(`scroll-${key}`, JSON.stringify(data));
    };

    const onScroll = () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveState, 150);
    };

    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(saveTimeout);
      main.removeEventListener("scroll", onScroll);
    };
  }, [key]);

  // Restore scroll position when data is ready, but only if the user
  // navigated to a child page and came back (preserve flag is set).
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;

    const preserve = sessionStorage.getItem(`scroll-${key}-preserve`);
    sessionStorage.removeItem(`scroll-${key}-preserve`);

    if (!preserve) {
      // Not returning from a child page — clear saved state so page starts at top
      sessionStorage.removeItem(`scroll-${key}`);
      return;
    }

    const saved = sessionStorage.getItem(`scroll-${key}`);
    if (!saved) return;

    sessionStorage.removeItem(`scroll-${key}`);

    try {
      const { scrollTop, firstVisibleIndex, visibleCount: savedVisibleCount } = JSON.parse(saved);

      // Restore visible count first so enough items are rendered
      if (setVisibleCount && savedVisibleCount && savedVisibleCount > 0) {
        setVisibleCount(savedVisibleCount);
      }

      if (!scrollTop || scrollTop <= 0) return;

      const main = document.querySelector<HTMLElement>("main");
      if (!main) return;

      // Two-pass restore:
      // Pass 1: Set approximate scroll position so the virtualizer renders nearby rows.
      // Pass 2: After layout settles, fine-tune with index-based centering.
      requestAnimationFrame(() => {
        main.scrollTop = scrollTop;

        if (firstVisibleIndex >= 0) {
          requestAnimationFrame(() => {
            optionsRef.current?.scrollToIndex?.(firstVisibleIndex);
          });
        }
      });
    } catch {
      // Invalid stored data, ignore
    }
  }, [key, ready, setVisibleCount]);

  /**
   * Call this before navigating to a child/detail page (e.g., before router.push).
   * Sets a flag so that returning to this page will restore scroll position.
   */
  const markChildNavigation = useCallback(() => {
    sessionStorage.setItem(`scroll-${key}-preserve`, "true");
  }, [key]);

  return { markChildNavigation };
}
