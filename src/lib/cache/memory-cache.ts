/**
 * Simple in-memory TTL cache for server-side data that changes infrequently.
 * Each entry expires after the configured TTL and can be manually invalidated.
 *
 * - `getOrSet` is single-flight: concurrent misses for the same key share one
 *   in-flight `compute()` promise (prevents cache stampede on cold start).
 * - Invalidation reaches in-flight computes too: a compute that was running
 *   when its key was invalidated still answers the callers already waiting on
 *   it, but is not cached, and later callers start a fresh one. Otherwise a
 *   slow compute that began before a mutation cached its pre-mutation result
 *   for a full TTL right after the mutation's invalidation had run.
 * - The store is bounded: when it exceeds `maxEntries`, expired entries are
 *   swept first, then the oldest entries are evicted (insertion order). This
 *   keeps a long-running process from growing unbounded as keys diversify.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

interface Flight {
  promise: Promise<unknown>;
  /** Set when the key is invalidated mid-compute: the result is not cached. */
  stale: boolean;
}

export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private inflight = new Map<string, Flight>();
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
   *
   * `shouldCache` keeps a result the caller must not reuse out of the cache
   * (a partial answer, say) while still handing it to every caller already
   * waiting on the compute. Evicting such a result after the fact instead left
   * a window in which other callers were served it, and the eviction also
   * abandoned any fresh compute another caller had started meanwhile.
   */
  async getOrSet<T>(
    key: string,
    compute: () => Promise<T>,
    ttlMs?: number,
    options?: { shouldCache?: (value: T) => boolean },
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing.promise as Promise<T>;

    const flight: Flight = { promise: Promise.resolve(), stale: false };
    const promise = (async () => {
      try {
        const data = await compute();
        if (!flight.stale && (options?.shouldCache?.(data) ?? true)) this.set(key, data, ttlMs);
        return data;
      } finally {
        // An invalidation may already have replaced this flight with a newer one.
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
      }
    })();
    flight.promise = promise;
    this.inflight.set(key, flight);
    return promise;
  }

  invalidate(key: string): void {
    this.store.delete(key);
    this.abandonFlight(key);
  }

  /** Invalidate all entries whose key starts with the given prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (key.startsWith(prefix)) this.abandonFlight(key);
    }
  }

  clear(): void {
    this.store.clear();
    for (const key of [...this.inflight.keys()]) this.abandonFlight(key);
  }

  /** Keep an in-flight compute for `key` from caching, and from being joined. */
  private abandonFlight(key: string): void {
    const flight = this.inflight.get(key);
    if (!flight) return;
    flight.stale = true;
    this.inflight.delete(key);
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
