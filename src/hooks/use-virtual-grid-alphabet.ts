"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

interface UseVirtualGridAlphabetOptions {
  /**
   * The first item index of each starting letter, over the whole list — the
   * listing's `index.letters` (`src/lib/media/list-index.ts`), sent by the
   * server: a paged list holds only the pages scrolled to, so the rail cannot
   * read the letters off the rows it has.
   */
  letters: Record<string, number> | undefined;
  /** The letter of the item at `index` (its title when loaded), for the active letter. */
  letterAt: (index: number) => string | null;
  columns: number;
  virtualizer: Virtualizer<HTMLElement, Element>;
  scrollElement: HTMLElement | null;
  /** When false, disables the scroll listener to avoid unnecessary re-renders (e.g. in table mode). */
  enabled?: boolean;
}

/**
 * Alphabet navigation for virtualized grids, where most items are not in the
 * DOM — and, on a paged listing, not loaded either.
 *
 * Letters and their positions come from the listing's index; the jump scrolls
 * the virtualizer to the letter's row (its page loads as the rows come into
 * view), and the active letter follows the row at 40% of the viewport.
 */
export function useVirtualGridAlphabet({
  letters,
  letterAt,
  columns,
  virtualizer,
  scrollElement,
  enabled = true,
}: UseVirtualGridAlphabetOptions) {
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const scrollingRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const availableLetters = useMemo(() => new Set(Object.keys(letters ?? {})), [letters]);

  const scrollToLetter = useCallback(
    (letter: string) => {
      const itemIndex = letters?.[letter];
      if (itemIndex === undefined) return;
      scrollingRef.current = true;
      setActiveLetter(letter);
      virtualizer.scrollToIndex(Math.floor(itemIndex / Math.max(1, columns)), { align: "start" });
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        scrollingRef.current = false;
      }, 100);
    },
    [letters, columns, virtualizer],
  );

  // Track active letter from scroll position
  useEffect(() => {
    if (!scrollElement || !enabled) return;

    const handleScroll = () => {
      if (scrollingRef.current) return;

      const virtualItems = virtualizer.getVirtualItems();
      if (virtualItems.length === 0) {
        setActiveLetter(null);
        return;
      }

      const scrollMargin = virtualizer.options.scrollMargin;
      const scrollOffset = virtualizer.scrollOffset ?? 0;
      const viewportHeight = scrollElement.clientHeight;
      const viewportTarget = scrollOffset + viewportHeight * 0.4 - scrollMargin;

      let currentLetter: string | null = null;
      for (const vItem of virtualItems) {
        if (vItem.start <= viewportTarget) {
          currentLetter = letterAt(vItem.index * Math.max(1, columns));
        } else {
          break;
        }
      }

      setActiveLetter(currentLetter);
    };

    let ticking = false;
    const throttledScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
      }
    };

    scrollElement.addEventListener("scroll", throttledScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", throttledScroll);
      clearTimeout(scrollTimerRef.current);
    };
  }, [virtualizer, letterAt, columns, scrollElement, enabled]);

  return { activeLetter, availableLetters, scrollToLetter };
}
