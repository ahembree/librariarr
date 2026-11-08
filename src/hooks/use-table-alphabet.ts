"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";

interface UseTableAlphabetOptions {
  /**
   * The first row index of each starting letter, over the whole list — the
   * listing's `index.letters` (`src/lib/media/list-index.ts`), sent by the
   * server: a paged list holds only the pages scrolled to.
   */
  letters: Record<string, number> | undefined;
  /** The letter of the row at `index` (its title when loaded), for the active letter. */
  letterAt: (index: number) => string | null;
  /** When false the hook is inert (e.g. in card mode). */
  enabled?: boolean;
  /** The virtualized table's index scroller (`scrollToIndexRef` on `MediaTable`/`DataTable`). */
  scrollToIndexRef: React.RefObject<((index: number) => void) | null>;
  /** Scroll container element for tracking active letter on scroll. */
  scrollElement?: HTMLElement | null;
}

/**
 * Alphabet navigation for virtualized table views: the jump scrolls the table
 * to the letter's first row (its page loads as it comes into view), and the
 * active letter follows the rendered row at 40% of the viewport.
 */
export function useTableAlphabet({
  letters,
  letterAt,
  enabled = true,
  scrollToIndexRef,
  scrollElement,
}: UseTableAlphabetOptions) {
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const scrollingRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const availableLetters = useMemo(() => new Set(Object.keys(letters ?? {})), [letters]);

  const scrollToLetter = useCallback(
    (letter: string) => {
      if (!enabled) return;
      const targetIndex = letters?.[letter];
      if (targetIndex === undefined || !scrollToIndexRef.current) return;

      scrollingRef.current = true;
      setActiveLetter(letter);
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        scrollingRef.current = false;
      }, 100);
      scrollToIndexRef.current(targetIndex);
    },
    [enabled, letters, scrollToIndexRef],
  );

  // Track active letter from scroll position
  useEffect(() => {
    if (!scrollElement || !enabled) return;

    const handleScroll = () => {
      if (scrollingRef.current) return;

      // Find the first visible row in the viewport by querying virtualized rows
      const rows = document.querySelectorAll<HTMLElement>("tbody tr[data-index]");
      if (rows.length === 0) {
        setActiveLetter(null);
        return;
      }

      const scrollTop = scrollElement.scrollTop;
      const viewportTarget = scrollTop + scrollElement.clientHeight * 0.4;

      let currentLetter: string | null = null;
      for (const row of rows) {
        const rowTop = row.getBoundingClientRect().top + scrollTop - scrollElement.getBoundingClientRect().top;
        if (rowTop <= viewportTarget) {
          const index = parseInt(row.dataset.index ?? "", 10);
          if (!isNaN(index)) currentLetter = letterAt(index) ?? currentLetter;
        } else {
          break;
        }
      }

      if (currentLetter !== null) {
        setActiveLetter(currentLetter);
      }
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
  }, [scrollElement, enabled, letterAt]);

  return { activeLetter, availableLetters, scrollToLetter };
}
