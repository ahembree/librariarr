"use client";

import { useMemo, useState, useCallback } from "react";
import { getLetterForTitle } from "@/lib/utils";

interface UseTableAlphabetOptions {
  items: { title: string }[];
  /** When false the hook is inert (e.g. in card mode). */
  enabled?: boolean;
  /** When provided, uses index-based scrolling for virtualized tables. */
  scrollToIndexRef?: React.RefObject<((index: number) => void) | null>;
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
}: UseTableAlphabetOptions) {
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

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

      setActiveLetter(letter);

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

  return { activeLetter, availableLetters, scrollToLetter };
}
