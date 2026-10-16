/**
 * Loads a module once, on first request, and remembers it. React-free so it can
 * be tested; `lazyComponent` (src/components/lazy-component.tsx) is the React
 * side.
 *
 * A failed load is forgotten rather than cached, so the next request tries
 * again (a chunk can fail to load on a flaky connection or after a deploy
 * replaced it).
 */
interface ModuleLoader<T> {
  /** The loaded value, or null while it has not loaded. */
  get(): T | null;
  /** Start the load if it has not started; resolves with the value. */
  load(): Promise<T>;
}

export function createModuleLoader<T>(load: () => Promise<T>): ModuleLoader<T> {
  let value: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    get: () => value,
    load: () => {
      if (value !== null) return Promise.resolve(value);
      pending ??= load().then(
        (loaded) => {
          value = loaded;
          return loaded;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
  };
}
