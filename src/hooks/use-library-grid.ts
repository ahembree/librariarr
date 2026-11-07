"use client";

import { useCallback, useEffect, useRef } from "react";
import { CARD_CONTENT_HEIGHT } from "@/components/media-card";
import { useVirtualGridAlphabet } from "@/hooks/use-virtual-grid-alphabet";
import { useTableAlphabet } from "@/hooks/use-table-alphabet";
import type { VirtualPosterGrid } from "@/hooks/use-virtual-poster-grid";
import type { LibraryViewMode } from "@/hooks/use-library-list-state";
import { letterAt as letterAtOffset } from "@/lib/media/list-index";
import { getLetterForTitle } from "@/lib/utils";

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

export interface LibraryAlphabetOptions<T> {
  /** The listing's `index.letters` — the first row of each starting letter over the whole list. */
  letters: Record<string, number> | undefined;
  /** The rows (`useLibraryList().items`; `undefined` where a page has not loaded). */
  items: readonly (T | undefined)[];
  /** The title a row's letter comes from — the one the server's letters are read from. */
  titleOf: (item: T) => string | null | undefined;
  /**
   * The list is sorted by that title, so each letter is one run of rows and a
   * row not loaded yet reads its letter off the offsets. Under any other sort
   * the letters interleave and such a row has none until it loads.
   */
  titleSorted: boolean;
  grid: VirtualPosterGrid;
  viewMode: LibraryViewMode;
}

/**
 * The A–Z rail of a library page with a card grid and a table. The letters
 * and where each starts come from the listing's index (the server's, since a
 * paged list holds only the pages scrolled to); the grid jumps through its
 * virtualizer, the table through its own index scroller, and only the view on
 * screen listens for scrolling. The active letter is a loaded row's own title,
 * or — for a row not loaded yet, in a title sort — the letter whose run it
 * falls in.
 */
export function useLibraryAlphabet<T>({
  letters,
  items,
  titleOf,
  titleSorted,
  grid,
  viewMode,
}: LibraryAlphabetOptions<T>): LibraryAlphabet {
  const tableScrollToIndexRef = useRef<((index: number) => void) | null>(null);
  const cards = viewMode === "cards";
  const titleOfRef = useRef(titleOf);
  useEffect(() => {
    titleOfRef.current = titleOf;
  });

  const letterAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return titleSorted ? letterAtOffset(letters, index) : null;
      const title = titleOfRef.current(item);
      return title ? getLetterForTitle(title) : null;
    },
    [items, letters, titleSorted],
  );

  const gridAlphabet = useVirtualGridAlphabet({
    letters,
    letterAt,
    columns: grid.columns,
    virtualizer: grid.virtualizer,
    scrollElement: grid.scrollElement,
    enabled: cards,
  });
  const tableAlphabet = useTableAlphabet({
    letters,
    letterAt,
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
