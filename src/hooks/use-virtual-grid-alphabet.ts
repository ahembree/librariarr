"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { getLetterForTitle } from "@/lib/utils";

interface UseVirtualGridAlphabetOptions {
  items: { title: string }[];
  columns: number;
  virtualizer: Virtualizer<HTMLElement, Element>;
  scrollElement: HTMLElement | null;
  /** When false, disables the scroll listener to avoid unnecessary re-renders (e.g. in table mode). */
  enabled?: boolean;
}

/**
 * Data-driven alphabet navigation for virtualized grids.
 * Replaces useAlphabetScroll for grids where most items are not in the DOM.
 *
 * Computes letter positions from the data array and virtualizer state
 * instead of querying DOM elements.
 */
export function useVirtualGridAlphabet({
  items,
  columns,
  virtualizer,
  scrollElement,
  enabled = true,
}: UseVirtualGridAlphabetOptions) {
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

  // Letter → first row index containing that letter
  const letterRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < items.length; i++) {
      const letter = getLetterForTitle(items[i].title);
      if (!map.has(letter)) {
        map.set(letter, Math.floor(i / columns));
      }
    }
    return map;
  }, [items, columns]);

  // Row index → letter of first item in that row
  const rowLetters = useMemo(() => {
    const totalRows = Math.ceil(items.length / columns);
    const result: string[] = new Array(totalRows);
    for (let row = 0; row < totalRows; row++) {
      const itemIndex = row * columns;
      if (itemIndex < items.length) {
        result[row] = getLetterForTitle(items[itemIndex].title);
      }
    }
    return result;
  }, [items, columns]);

  const scrollToLetter = useCallback(
    (letter: string) => {
      const rowIndex = letterRowIndex.get(letter);
      if (rowIndex !== undefined) {
        scrollingRef.current = true;
        setActiveLetter(letter);
        virtualizer.scrollToIndex(rowIndex, { align: "start" });
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = setTimeout(() => {
          scrollingRef.current = false;
        }, 100);
      }
    },
    [letterRowIndex, virtualizer]
  );

  // Track active letter from scroll position
  useEffect(() => {
    if (!scrollElement || !enabled) return;

    const handleScroll = () => {
      if (scrollingRef.current) return;

      const virtualItems = virtualizer.getVirtualItems();
      if (virtualItems.length === 0) return;

      const scrollMargin = virtualizer.options.scrollMargin;
      const scrollOffset = virtualizer.scrollOffset ?? 0;
      const viewportHeight = scrollElement.clientHeight;
      const viewportTarget = scrollOffset + viewportHeight * 0.4 - scrollMargin;

      let currentLetter: string | null = null;
      for (const vItem of virtualItems) {
        if (vItem.start <= viewportTarget) {
          currentLetter = rowLetters[vItem.index] ?? null;
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
  }, [virtualizer, rowLetters, scrollElement, enabled]);

  return { activeLetter, availableLetters, scrollToLetter };
}
