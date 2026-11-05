"use client";

import { useCallback, useState } from "react";
import { withDisplay, type CardDisplay } from "@/lib/dashboard/card-display";

const AT_DEFAULTS: CardDisplay = {};

/**
 * A dashboard card's display choices (`card-display.ts`) and their setter.
 *
 * On the dashboard the choices are the layout's (`display`, saved through
 * `onChange`), so they survive a reload and the layout editor. Without
 * `onChange` (the custom-card dialog's preview) they are the card's own, and a
 * change of the outside type filter drops the card's type pick, as the
 * dashboard does for every card when its filter changes.
 */
export function useDashboardCardDisplay(
  display: CardDisplay | undefined,
  onChange: ((next: CardDisplay | undefined) => void) | undefined,
  filterType: string | undefined,
): [CardDisplay, (patch: Partial<CardDisplay>) => void] {
  const [local, setLocal] = useState<CardDisplay | undefined>(display);
  const [seenFilter, setSeenFilter] = useState(filterType);
  if (seenFilter !== filterType) {
    setSeenFilter(filterType);
    if (!onChange) setLocal((prev) => withDisplay(prev, { type: undefined }));
  }

  const current = onChange ? display : local;
  const update = useCallback(
    (patch: Partial<CardDisplay>) => {
      if (onChange) onChange(withDisplay(display, patch));
      else setLocal((prev) => withDisplay(prev, patch));
    },
    [display, onChange],
  );
  return [current ?? AT_DEFAULTS, update];
}
