"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { getLetterForTitle } from "@/lib/utils";

interface UseTableAlphabetOptions {
  items: { title: string }[];
  /** When false the hook is inert (e.g. in card mode). */
  enabled?: boolean;
  /** When provided, uses index-based scrolling for virtualized tables. */
  scrollToIndexRef?: React.RefObject<((index: number) => void) | null>;
  /** Scroll container element for tracking active letter on scroll. */
  scrollElement?: HTMLElement | null;
}

/**
 * Alphabet navigation for table views.
 * Supports both virtualized tables (via scrollToIndexRef) and non-virtualized
 * tables (DOM query fallback).
 */
export function useTableAlphabet({
  items,
  enabled = true,
  scrollToIndexRef,
  scrollElement,
}: UseTableAlphabetOptions) {
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const scrollingRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const availableLetters = useMemo(() => {
    const letters = new Set<string>();
    for (const item of items) {
      if (item.title) letters.add(getLetterForTitle(item.title));
    }
    return letters;
  }, [items]);

  const scrollToLetter = useCallback(
    (letter: string) => {
      if (!enabled) return;

      scrollingRef.current = true;
      setActiveLetter(letter);
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        scrollingRef.current = false;
      }, 100);

      // Virtualized path: find index and scroll via ref
      if (scrollToIndexRef?.current) {
        const targetIndex = items.findIndex(
          (item) => getLetterForTitle(item.title) === letter,
        );
        if (targetIndex >= 0) scrollToIndexRef.current(targetIndex);
        return;
      }

      // Non-virtualized fallback: DOM query
      const rows = document.querySelectorAll("tbody tr");
      for (const row of rows) {
        const cell = row.querySelector("td");
        if (!cell) continue;
        const text = cell.textContent?.trim() ?? "";
        const rowLetter = getLetterForTitle(text);
        if (rowLetter === letter) {
          row.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      }
    },
    [enabled, items, scrollToIndexRef],
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
          if (!isNaN(index) && index < items.length) {
            currentLetter = getLetterForTitle(items[index].title);
          }
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
  }, [scrollElement, enabled, items]);

  return { activeLetter, availableLetters, scrollToLetter };
}
