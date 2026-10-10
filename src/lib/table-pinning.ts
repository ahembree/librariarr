/**
 * Column pinning for `DataTable` (client-safe, pure). Pinned columns render
 * first, keep their relative order, and stick to the table's left edge at the
 * summed width of the pinned columns before them.
 */

export interface PinnableColumn {
  id: string;
  /** Always pinned and never offered an unpin (e.g. a row-selection checkbox). */
  alwaysPinned?: boolean;
}

export interface PinnedLayout<C> {
  /** Pinned columns first, then the rest, each group in its original order. */
  ordered: C[];
  /** How many of `ordered` are pinned. */
  pinnedCount: number;
  /** Sticky `left` offset (px) of each pinned column. */
  offsets: Record<string, number>;
}

export function isColumnPinned(col: PinnableColumn, pinned: ReadonlySet<string>): boolean {
  return !!col.alwaysPinned || pinned.has(col.id);
}

export function arrangePinnedColumns<C extends PinnableColumn>(
  columns: readonly C[],
  pinned: ReadonlySet<string>,
  widths: Record<string, number>,
): PinnedLayout<C> {
  const pinnedCols = columns.filter((c) => isColumnPinned(c, pinned));
  const rest = columns.filter((c) => !isColumnPinned(c, pinned));
  const offsets: Record<string, number> = {};
  let left = 0;
  for (const col of pinnedCols) {
    offsets[col.id] = left;
    left += widths[col.id] ?? 0;
  }
  return { ordered: [...pinnedCols, ...rest], pinnedCount: pinnedCols.length, offsets };
}

export function togglePinnedId(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
}

/** Stored pins, or `fallback` when nothing (or nothing valid) is stored. */
export function parseStoredPins(raw: string | null, fallback: readonly string[]): string[] {
  if (raw === null) return [...fallback];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) return parsed;
  } catch {
    /* fall through */
  }
  return [...fallback];
}
