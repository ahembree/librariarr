import { cn } from "@/lib/utils";

/**
 * A table row's change against a stored set — the rule editor's preview marks
 * rows a rule change would add to or remove from the rule set's matches.
 */
export type RowTone = "added" | "removed";

/** What each tone says in words, beside its colour (`RowToneChip`). */
export const ROW_TONE_LABELS: Record<RowTone, { short: string; long: string }> = {
  added: { short: "New", long: "New match: not among the rule set's current matches" },
  removed: { short: "Removed", long: "Removed: a current match these rules no longer match" },
};

const INTERACTIVE = "cursor-pointer hover:bg-white/3 hover:ring-1 hover:ring-primary/20";

// A toned row keeps its fill on hover: a `hover:` background or ring colour
// outranks the tone's plain classes (a class plus `:hover` against a class),
// so the hover answers in the tone's own hue instead of replacing it. The
// fill is repeated as `hover:bg-*` because shadcn's `TableRow` carries
// `hover:bg-muted/50`; its `cn()` merge lets this one replace it.
const TONE_CLASSES: Record<RowTone, { surface: string; interactive: string }> = {
  added: {
    surface: "bg-green-dim hover:bg-green-dim ring-1 ring-inset ring-green/40",
    interactive: "cursor-pointer hover:ring-green/80",
  },
  removed: {
    surface: "bg-amber-dim hover:bg-amber-dim ring-1 ring-inset ring-amber/40 opacity-60",
    interactive: "cursor-pointer hover:ring-amber/80 hover:opacity-80",
  },
};

interface RowSurfaceOptions {
  /** The row's index in the whole list (a virtual row's `index`). */
  index: number;
  tone?: RowTone;
  /** The row opens something on click: pointer cursor and hover feedback. */
  interactive?: boolean;
}

/**
 * The one rule for a data row's background, hover and tone in the app's
 * tables. The zebra stripe follows the row's index in the list, never
 * `even:`/`odd:`: the tables are virtualized, so a row's `:nth-child` position
 * shifts as the rendered window moves (and a top spacer row counts too), which
 * made every stripe flip on each row scrolled. A toned row takes no stripe.
 */
export function rowSurfaceClass({ index, tone, interactive = false }: RowSurfaceOptions): string {
  if (tone) {
    const classes = TONE_CLASSES[tone];
    return cn("transition-colors duration-200", classes.surface, interactive && classes.interactive);
  }
  return cn("transition-colors duration-200", index % 2 === 1 && "bg-white/1.5", interactive && INTERACTIVE);
}
