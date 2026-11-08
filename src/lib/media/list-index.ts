/**
 * The index of a paged library listing: what a library page needs about the
 * WHOLE list while it holds only the pages the user has scrolled to.
 *
 * The pages ask for it with `?index=1` on their first page; the routes answer
 * it beside that page as `index`. It stays a few dozen numbers however large
 * the library is:
 *
 * - `total` — rows in the listing (the virtualizers' row count and the
 *   header's count);
 * - `letters` — the row offset of the first row whose title starts with each
 *   letter (`getLetterForTitle`: A–Z, `#` for anything else), in list order —
 *   what the A–Z rail jumps to. Only the listings whose pages have the rail
 *   (movies and the grouped listings) send it;
 * - `sums` — totals over every row the header shows (a series listing's
 *   seasons and episodes, an artist listing's albums and tracks).
 *
 * Client-safe: the pages read the types and `letterAt`.
 */

import { getLetterForTitle } from "@/lib/utils";

export interface ListIndex {
  total: number;
  letters?: Record<string, number>;
  sums?: Record<string, number>;
}

/** The query parameter that asks a listing route for its `index`. */
export const LIST_INDEX_PARAM = "index";

/** Whether the request asks for the listing's index (`?index=1` or `?index=true`). */
export function wantsListIndex(searchParams: URLSearchParams): boolean {
  const value = searchParams.get(LIST_INDEX_PARAM);
  return value === "1" || value === "true";
}

/**
 * The first row offset of each starting letter, over titles in list order —
 * the same `getLetterForTitle` the rail labels and the pages used when they
 * held the whole list. A row with no title starts no letter.
 */
export function letterOffsets(titles: Iterable<string | null | undefined>): Record<string, number> {
  const offsets: Record<string, number> = {};
  let index = 0;
  for (const title of titles) {
    if (title) {
      const letter = getLetterForTitle(title);
      if (!(letter in offsets)) offsets[letter] = index;
    }
    index++;
  }
  return offsets;
}

/**
 * The letter of the row at `index`, read from the offsets alone: the letter
 * whose first row is the last one at or before `index`. Exact only while the
 * list is sorted by the title the letters come from (each letter is then one
 * contiguous run); for another sort the page reads the row's own title when
 * it has loaded it.
 */
export function letterAt(letters: Record<string, number> | undefined, index: number): string | null {
  if (!letters) return null;
  let best: string | null = null;
  let bestOffset = -1;
  for (const [letter, offset] of Object.entries(letters)) {
    if (offset <= index && offset > bestOffset) {
      best = letter;
      bestOffset = offset;
    }
  }
  return best;
}

/** Sum `pick` over `rows` — the index's `sums`. */
export function sumOf<T>(rows: readonly T[], pick: (row: T) => number): number {
  let total = 0;
  for (const row of rows) total += pick(row) || 0;
  return total;
}
