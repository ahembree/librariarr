"use client";

import { useCallback, useMemo, useState } from "react";

export interface SetActions<T> {
  /** Add `value` if absent, remove it if present. */
  toggle(value: T): void;
  add(...values: T[]): void;
  remove(...values: T[]): void;
  clear(): void;
  /** Whether the current set holds `value`. */
  has(value: T): boolean;
  /** Replace the whole set. */
  replace(values: Iterable<T>): void;
}

/**
 * A `Set` held as state — selections, expanded rows, ids in flight — with
 * the updates every caller wrote as `setX((prev) => { const next = new
 * Set(prev); … return next; })`. Each update hands React a new set (a set
 * mutated in place would not re-render), and an update that changes nothing
 * keeps the old one, so nothing re-renders for it. The actions object is
 * stable apart from `has`, which reads the current set.
 */
export function useSetState<T>(initial?: Iterable<T> | (() => Iterable<T>)): [ReadonlySet<T>, SetActions<T>] {
  const [set, setSet] = useState<Set<T>>(() => new Set(typeof initial === "function" ? initial() : initial));

  const toggle = useCallback((value: T) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const add = useCallback((...values: T[]) => {
    setSet((prev) => {
      if (values.every((v) => prev.has(v))) return prev;
      const next = new Set(prev);
      for (const v of values) next.add(v);
      return next;
    });
  }, []);

  const remove = useCallback((...values: T[]) => {
    setSet((prev) => {
      if (!values.some((v) => prev.has(v))) return prev;
      const next = new Set(prev);
      for (const v of values) next.delete(v);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSet((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  const replace = useCallback((values: Iterable<T>) => {
    setSet(new Set(values));
  }, []);

  const has = useCallback((value: T) => set.has(value), [set]);

  const actions = useMemo(
    () => ({ toggle, add, remove, clear, has, replace }),
    [toggle, add, remove, clear, has, replace],
  );
  return [set, actions];
}
