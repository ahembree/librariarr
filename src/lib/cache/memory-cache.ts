/**
 * Simple in-memory TTL cache for server-side data that changes infrequently.
 * Each entry expires after the configured TTL and can be manually invalidated.
 *
 * - `getOrSet` is single-flight: concurrent misses for the same key share one
 *   in-flight `compute()` promise (prevents cache stampede on cold start).
 * - The store is bounded: when it exceeds `maxEntries`, expired entries are
 *   swept first, then the oldest entries are evicted (insertion order). This
 *   keeps a long-running process from growing unbounded as keys diversify.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  private defaultTtlMs: number;
  private maxEntries: number;

  constructor(defaultTtlMs: number = 60_000, maxEntries: number = 10_000) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs?: number): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.evict();
    }
    this.store.set(key, {
      data,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /**
   * Get cached value or compute and cache it. Concurrent callers that miss the
   * same key await a single shared `compute()` invocation (single-flight).
   */
  async getOrSet<T>(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = (async () => {
      try {
        const data = await compute();
        this.set(key, data, ttlMs);
        return data;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all entries whose key starts with the given prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  /** Drop expired entries; if still over capacity, evict oldest by insertion order. */
  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

/** Shared singleton for app-wide caching. 60s default TTL. */
export const appCache = new MemoryCache(60_000);
