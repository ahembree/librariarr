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
  /** Pinned by the user but not applied: there was no room for it. */
  suspended: Set<string>;
}

/** Share of the table's visible width pinned columns may take before further pins pause. */
export const MAX_PINNED_SHARE = 0.6;

export function isColumnPinned(col: PinnableColumn, pinned: ReadonlySet<string>): boolean {
  return !!col.alwaysPinned || pinned.has(col.id);
}

/**
 * `viewportWidth` is the table's visible width. Pins that would take more than
 * `MAX_PINNED_SHARE` of it are paused, from the first one that does not fit:
 * on a phone, Type + Title + Year alone are wider than the screen, and pinning
 * them all left nothing on screen that scrolled. A paused pin stays in the
 * user's list and applies again once there is room. Unknown width (0) pauses
 * nothing.
 */
export function arrangePinnedColumns<C extends PinnableColumn>(
  columns: readonly C[],
  pinned: ReadonlySet<string>,
  widths: Record<string, number>,
  viewportWidth = 0,
): PinnedLayout<C> {
  const budget = viewportWidth > 0 ? viewportWidth * MAX_PINNED_SHARE : Infinity;
  const pinnedCols: C[] = [];
  const suspended = new Set<string>();
  let used = 0;
  for (const col of columns) {
    if (!isColumnPinned(col, pinned)) continue;
    const width = widths[col.id] ?? 0;
    if (!col.alwaysPinned && (suspended.size > 0 || used + width > budget)) {
      suspended.add(col.id);
      continue;
    }
    pinnedCols.push(col);
    used += width;
  }
  const kept = new Set(pinnedCols.map((c) => c.id));
  const rest = columns.filter((c) => !kept.has(c.id));
  const offsets: Record<string, number> = {};
  let left = 0;
  for (const col of pinnedCols) {
    offsets[col.id] = left;
    left += widths[col.id] ?? 0;
  }
  return { ordered: [...pinnedCols, ...rest], pinnedCount: pinnedCols.length, offsets, suspended };
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
