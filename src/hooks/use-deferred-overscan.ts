"use client";

import { useEffect, useState } from "react";

/**
 * Virtualizer overscan that starts narrow and widens once the grid has painted.
 *
 * A poster row is ~400 px tall, so the grids' overscan of three rows mounted
 * 27 off-screen cards beside the 18 on screen; on the movie grid that was
 * ~40 ms of the first paint spent on cards nobody could see yet. The first
 * paint now mounts one row past the viewport, and the full overscan follows in
 * the next task, before anyone can scroll to it.
 */
export function useDeferredOverscan(ready: boolean, full = 3, initial = 1): number {
  const [widened, setWidened] = useState(false);

  useEffect(() => {
    if (!ready || widened) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // A frame, then a task: the widening lands after the first paint.
    const frame = requestAnimationFrame(() => {
      timeout = setTimeout(() => setWidened(true), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [ready, widened]);

  return widened ? full : initial;
}
