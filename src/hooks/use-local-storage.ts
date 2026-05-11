"use client";

import { useCallback, useSyncExternalStore } from "react";

const listenersByKey = new Map<string, Set<() => void>>();

function notify(key: string) {
  const set = listenersByKey.get(key);
  if (!set) return;
  for (const l of set) l();
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listenersByKey.get(key);
  if (!set) {
    set = new Set();
    listenersByKey.set(key, set);
  }
  set.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listenersByKey.delete(key);
    window.removeEventListener("storage", onStorage);
  };
}

export function useLocalStorage<T extends string>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const sub = useCallback((l: () => void) => subscribe(key, l), [key]);
  const getSnapshot = useCallback(
    () => (localStorage.getItem(key) as T | null) ?? defaultValue,
    [key, defaultValue],
  );
  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  const value = useSyncExternalStore(sub, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T) => {
      localStorage.setItem(key, next);
      notify(key);
    },
    [key],
  );

  return [value, setValue];
}

const jsonCache = new Map<string, { raw: string | null; parsed: unknown }>();

export function useLocalStorageJSON<T>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const sub = useCallback((l: () => void) => subscribe(key, l), [key]);
  const getSnapshot = useCallback((): T => {
    const raw = localStorage.getItem(key);
    const cached = jsonCache.get(key);
    if (cached && cached.raw === raw) return cached.parsed as T;
    let parsed: T;
    if (raw == null) {
      parsed = defaultValue;
    } else {
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        parsed = defaultValue;
      }
    }
    jsonCache.set(key, { raw, parsed });
    return parsed;
  }, [key, defaultValue]);
  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  const value = useSyncExternalStore(sub, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T) => {
      const raw = JSON.stringify(next);
      localStorage.setItem(key, raw);
      jsonCache.set(key, { raw, parsed: next });
      notify(key);
    },
    [key],
  );

  return [value, setValue];
}
