/**
 * A dashboard card's own display choices — its view, how many values it
 * lists, its type pick and the values left out of its totals — saved with the
 * layout (`CardEntry.display`), so they survive a reload and entering or
 * leaving the layout editor. Only what differs from the defaults is stored.
 */

export type CardMediaType = "MOVIE" | "SERIES" | "MUSIC";

/** A card's own type pick: one type, or "ALL" — every type, whatever the Insights filter says. */
export type CardTypePick = "ALL" | CardMediaType;

export interface CardDisplay {
  /** Breakdown cards: proportion strips ("bars", the default) or a donut. */
  view?: "donut";
  /** Breakdown cards: values listed before the rest fold into "Other" (5 by default); null lists them all. */
  topN?: number | null;
  /**
   * The card's own type pick. Absent, the card follows the Insights type
   * filter; set, it overrides that filter until the filter is changed again
   * (the dashboard then clears every card's pick).
   */
  type?: CardTypePick;
  /** Values left out of the card's totals (clicked off in its list or legend). */
  hidden?: string[];
}

export const TOP_N_CHOICES = [5, 10, 15, 20] as const;
export const DEFAULT_TOP_N = 5;
/** Bounds on a card's hidden values, so a layout stays well inside the saved size cap. */
export const MAX_HIDDEN_VALUES = 30;
export const MAX_HIDDEN_VALUE_LENGTH = 100;

const TYPE_PICKS = new Set<string>(["ALL", "MOVIE", "SERIES", "MUSIC"]);
const DISPLAY_KEYS = new Set(["view", "topN", "type", "hidden"]);

function isTopN(value: unknown): value is number | null {
  return value === null || (TOP_N_CHOICES as readonly unknown[]).includes(value);
}

function isHiddenValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_HIDDEN_VALUE_LENGTH;
}

/** Whether a saved `display` is well formed: known keys only, each in range. */
export function isValidCardDisplay(raw: unknown): raw is CardDisplay {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const display = raw as Record<string, unknown>;
  for (const key of Object.keys(display)) if (!DISPLAY_KEYS.has(key)) return false;
  if (display.view !== undefined && display.view !== "donut") return false;
  if (display.topN !== undefined && !isTopN(display.topN)) return false;
  if (display.type !== undefined && !(typeof display.type === "string" && TYPE_PICKS.has(display.type))) return false;
  if (display.hidden !== undefined) {
    if (!Array.isArray(display.hidden) || display.hidden.length > MAX_HIDDEN_VALUES) return false;
    if (!display.hidden.every(isHiddenValue)) return false;
  }
  return true;
}

/**
 * A saved `display` with anything malformed dropped (a layout saved by an
 * older or newer version still loads), or undefined when nothing is left.
 */
export function normalizeCardDisplay(raw: unknown): CardDisplay | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const display = raw as Record<string, unknown>;
  const hidden = Array.isArray(display.hidden)
    ? [...new Set(display.hidden.filter(isHiddenValue))].slice(0, MAX_HIDDEN_VALUES)
    : [];
  return withDisplay(undefined, {
    ...(display.view === "donut" && { view: "donut" as const }),
    ...(isTopN(display.topN) && { topN: display.topN }),
    ...(typeof display.type === "string" && TYPE_PICKS.has(display.type) && { type: display.type as CardTypePick }),
    hidden,
  });
}

/**
 * `current` with `patch` applied — a key present in the patch with the value
 * undefined clears it — and every value equal to its default dropped. Undefined
 * when nothing differs from the defaults, so a card left at them stores nothing.
 */
export function withDisplay(current: CardDisplay | undefined, patch: Partial<CardDisplay>): CardDisplay | undefined {
  const merged: CardDisplay = { ...current, ...patch };
  const next: CardDisplay = {};
  if (merged.view === "donut") next.view = "donut";
  if (merged.topN !== undefined && merged.topN !== DEFAULT_TOP_N) next.topN = merged.topN;
  if (merged.type !== undefined) next.type = merged.type;
  if (merged.hidden && merged.hidden.length > 0) next.hidden = merged.hidden;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Whether two cards' display choices are the same (a re-read layout carries equal copies). */
export function sameCardDisplay(a: CardDisplay | undefined, b: CardDisplay | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return a === undefined && b === undefined;
  const hiddenA = a.hidden ?? [];
  const hiddenB = b.hidden ?? [];
  return (
    a.view === b.view &&
    a.topN === b.topN &&
    a.type === b.type &&
    hiddenA.length === hiddenB.length &&
    hiddenA.every((v, i) => v === hiddenB[i])
  );
}

/** `hidden` with `value` added, or removed when it is already there (capped at `MAX_HIDDEN_VALUES`). */
export function toggleHiddenValue(hidden: readonly string[] | undefined, value: string): string[] {
  const list = hidden ?? [];
  if (list.includes(value)) return list.filter((v) => v !== value);
  if (!isHiddenValue(value) || list.length >= MAX_HIDDEN_VALUES) return [...list];
  return [...list, value];
}

/**
 * The type a card shows: its own pick, else the Insights filter. A pick of a
 * type the library no longer has is ignored (the card's selector no longer
 * offers it, so it could not be cleared there). Undefined means every type.
 */
export function effectiveCardType(
  pick: CardTypePick | undefined,
  filterType: CardMediaType | undefined,
  availableTypes: readonly string[] | undefined,
): CardMediaType | undefined {
  if (pick === undefined) return filterType;
  if (pick === "ALL") return undefined;
  const available = !availableTypes || availableTypes.length === 0 || availableTypes.includes(pick);
  return available ? pick : filterType;
}

/**
 * The cards with every type pick cleared, for a change of the Insights type
 * filter — the same array when no card had one, so nothing is saved for nothing.
 */
export function clearTypePicks<T extends { display?: CardDisplay }>(cards: T[]): T[] {
  if (!cards.some((c) => c.display?.type !== undefined)) return cards;
  return cards.map((c) => {
    if (c.display?.type === undefined) return c;
    const display = withDisplay(c.display, { type: undefined });
    const { display: _old, ...rest } = c;
    void _old;
    return (display ? { ...rest, display } : rest) as T;
  });
}
