"use client";

import { useCallback, useMemo } from "react";
import { useLocalStorageJSON } from "@/hooks/use-local-storage";
import type { SetActions } from "@/hooks/use-set-state";

const NONE: readonly string[] = [];

/**
 * A set of strings kept in this browser's localStorage under `key` — a
 * table's visible columns, say. Read through `useLocalStorageJSON`, so the
 * server render and hydration use `defaults` (no mismatch), a private window
 * or blocked storage falls back to them instead of throwing, and every reader
 * of the key, in this tab or another, follows a change.
 *
 * Something stored that is not a list of strings reads as `defaults`.
 */
export function useStoredSet(
  key: string,
  defaults: readonly string[] = NONE,
): [ReadonlySet<string>, SetActions<string>] {
  const [stored, setStored] = useLocalStorageJSON<unknown>(key, defaults);
  const values = Array.isArray(stored) && stored.every((v) => typeof v === "string") ? (stored as string[]) : defaults;
  const set = useMemo(() => new Set(values), [values]);

  const write = useCallback((next: Iterable<string>) => setStored([...new Set(next)]), [setStored]);

  const toggle = useCallback(
    (value: string) => write(set.has(value) ? [...set].filter((v) => v !== value) : [...set, value]),
    [set, write],
  );
  const add = useCallback(
    (...more: string[]) => {
      if (more.every((v) => set.has(v))) return;
      write([...set, ...more]);
    },
    [set, write],
  );
  const remove = useCallback(
    (...gone: string[]) => {
      if (!gone.some((v) => set.has(v))) return;
      write([...set].filter((v) => !gone.includes(v)));
    },
    [set, write],
  );
  const clear = useCallback(() => {
    if (set.size > 0) write([]);
  }, [set, write]);
  const has = useCallback((value: string) => set.has(value), [set]);

  const actions = useMemo(
    () => ({ toggle, add, remove, clear, has, replace: write }),
    [toggle, add, remove, clear, has, write],
  );
  return [set, actions];
}
