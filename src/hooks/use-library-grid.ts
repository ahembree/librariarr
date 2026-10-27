"use client";

import { useCallback, useRef } from "react";
import { CARD_CONTENT_HEIGHT } from "@/components/media-card";
import { useVirtualGridAlphabet } from "@/hooks/use-virtual-grid-alphabet";
import { useTableAlphabet } from "@/hooks/use-table-alphabet";
import type { VirtualPosterGrid } from "@/hooks/use-virtual-poster-grid";
import type { LibraryViewMode } from "@/hooks/use-library-list-state";

/** The quality bar under a library card's artwork: the 4px bar plus its 8px padding. */
const QUALITY_BAR_HEIGHT = 12;
/** A card's 1px top and bottom border. */
const CARD_BORDER = 2;

/**
 * Everything under the artwork in a library grid card — the content block,
 * the quality bar and the border — for `useVirtualPosterGrid`'s
 * `contentHeight`. Each library page spelled the three out on its own.
 */
export const LIBRARY_CARD_CONTENT_HEIGHT = CARD_CONTENT_HEIGHT + QUALITY_BAR_HEIGHT + CARD_BORDER;

export interface LibraryAlphabet {
  activeLetter: string | null;
  availableLetters: Set<string>;
  /** For `AlphabetFilter`'s `onLetterClick`: jumps the view on screen. */
  onLetterClick: (letter: string) => void;
  /** For the table's `scrollToIndexRef`. */
  tableScrollToIndexRef: React.RefObject<((index: number) => void) | null>;
}

/**
 * The A–Z rail of a library page with a card grid and a table: the grid's
 * letters come from its virtualizer (most cards are not in the DOM), the
 * table's from its own index scroller, and only the view on screen listens
 * for scrolling. `items` must be memoised (one entry per row, in list order).
 */
export function useLibraryAlphabet(
  items: { title: string }[],
  grid: VirtualPosterGrid,
  viewMode: LibraryViewMode,
): LibraryAlphabet {
  const tableScrollToIndexRef = useRef<((index: number) => void) | null>(null);
  const cards = viewMode === "cards";

  const gridAlphabet = useVirtualGridAlphabet({
    items,
    columns: grid.columns,
    virtualizer: grid.virtualizer,
    scrollElement: grid.scrollElement,
    enabled: cards,
  });
  const tableAlphabet = useTableAlphabet({
    items,
    enabled: !cards,
    scrollToIndexRef: tableScrollToIndexRef,
    scrollElement: grid.scrollElement,
  });

  const gridScroll = gridAlphabet.scrollToLetter;
  const tableScroll = tableAlphabet.scrollToLetter;
  const onLetterClick = useCallback(
    (letter: string) => (cards ? gridScroll(letter) : tableScroll(letter)),
    [cards, gridScroll, tableScroll],
  );

  const active = cards ? gridAlphabet : tableAlphabet;
  return {
    activeLetter: active.activeLetter,
    availableLetters: active.availableLetters,
    onLetterClick,
    tableScrollToIndexRef,
  };
}
