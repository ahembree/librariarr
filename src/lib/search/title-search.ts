import type { Prisma } from "@/generated/prisma/client";
import { escapeLike } from "@/lib/filters/escape-like";

/** A title search as the user typed it. */
export interface TitleSearch {
  /** The text to look for, trimmed, without the quotes. */
  text: string;
  /** The whole title is the text (any case), not just a part of it. */
  exact: boolean;
}

/**
 * Reads a title search. A query that starts with a double quote is an exact
 * title: `"ER"` finds the show ER, not Heroes, Very Bad Things or Mercy Street,
 * which `ER` alone finds by containing it. Case still does not matter. The
 * closing quote may be left off, so the results follow the query while it is
 * being typed (`"E`, `"ER`, `"ER"`).
 */
export function parseTitleSearch(raw: string): TitleSearch {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"')) return { text: trimmed, exact: false };
  const inner = trimmed.slice(1);
  return { text: (inner.endsWith('"') ? inner.slice(0, -1) : inner).trim(), exact: true };
}

/**
 * The `ILIKE` pattern for a search: the text itself, or the text anywhere in
 * the title. Escaped (`escapeLike`), so a `%` or `_` in it is that character.
 */
export function titleSearchPattern(search: TitleSearch): string {
  const escaped = escapeLike(search.text);
  return search.exact ? escaped : `%${escaped}%`;
}

/**
 * The Prisma string filter for a search, case-insensitive. Prisma's
 * insensitive `equals` and `contains` are both `ILIKE`, so the text is
 * escaped for either.
 */
export function titleSearchFilter(search: TitleSearch): Prisma.StringFilter {
  const escaped = escapeLike(search.text);
  return search.exact
    ? { equals: escaped, mode: "insensitive" }
    : { contains: escaped, mode: "insensitive" };
}
