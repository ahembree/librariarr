import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryCache, appCache } from "@/lib/cache/memory-cache";

describe("MemoryCache", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new MemoryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("uses 60000ms as default TTL", () => {
      cache.set("key", "value");
      // Advance just under 60s — should still be cached
      vi.advanceTimersByTime(59999);
      expect(cache.get("key")).toBe("value");
      // Advance past 60s — should be expired
      vi.advanceTimersByTime(2);
      expect(cache.get("key")).toBeUndefined();
    });

    it("accepts a custom default TTL", () => {
      const customCache = new MemoryCache(5000);
      customCache.set("key", "value");
      vi.advanceTimersByTime(4999);
      expect(customCache.get("key")).toBe("value");
      vi.advanceTimersByTime(2);
      expect(customCache.get("key")).toBeUndefined();
    });
  });

  describe("get / set", () => {
    it("returns undefined for a key that was never set", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("stores and retrieves a string value", () => {
      cache.set("greeting", "hello");
      expect(cache.get("greeting")).toBe("hello");
    });

    it("stores and retrieves a number value", () => {
      cache.set("count", 42);
      expect(cache.get("count")).toBe(42);
    });

    it("stores and retrieves an object value", () => {
      const obj = { name: "test", items: [1, 2, 3] };
      cache.set("data", obj);
      expect(cache.get("data")).toEqual(obj);
    });

    it("stores and retrieves null as a value", () => {
      cache.set("nullable", null);
      // null is stored; get checks for undefined, not null
      expect(cache.get("nullable")).toBeNull();
    });

    it("stores and retrieves a boolean false", () => {
      cache.set("flag", false);
      expect(cache.get("flag")).toBe(false);
    });

    it("overwrites an existing key", () => {
      cache.set("key", "first");
      cache.set("key", "second");
      expect(cache.get("key")).toBe("second");
    });

    it("uses a custom TTL when provided", () => {
      cache.set("short", "value", 2000);
      vi.advanceTimersByTime(1999);
      expect(cache.get("short")).toBe("value");
      vi.advanceTimersByTime(2);
      expect(cache.get("short")).toBeUndefined();
    });

    it("supports typed retrieval via generics", () => {
      interface User {
        id: number;
        name: string;
      }
      const user: User = { id: 1, name: "Alice" };
      cache.set<User>("user:1", user);
      const retrieved = cache.get<User>("user:1");
      expect(retrieved).toEqual(user);
      expect(retrieved?.name).toBe("Alice");
    });
  });

  describe("TTL expiry", () => {
    it("returns undefined after default TTL expires", () => {
      cache.set("key", "value");
      vi.advanceTimersByTime(60001);
      expect(cache.get("key")).toBeUndefined();
    });

    it("returns value just before TTL expires", () => {
      cache.set("key", "value", 10000);
      vi.advanceTimersByTime(9999);
      expect(cache.get("key")).toBe("value");
    });

    it("removes expired entry from the store on access", () => {
      cache.set("key", "value", 1000);
      vi.advanceTimersByTime(1001);
      // First get should find it expired and remove it
      expect(cache.get("key")).toBeUndefined();
      // Set a new value at the same key
      cache.set("key", "new");
      expect(cache.get("key")).toBe("new");
    });

    it("handles multiple keys with different TTLs", () => {
      cache.set("short", "a", 1000);
      cache.set("medium", "b", 5000);
      cache.set("long", "c", 10000);

      vi.advanceTimersByTime(1001);
      expect(cache.get("short")).toBeUndefined();
      expect(cache.get("medium")).toBe("b");
      expect(cache.get("long")).toBe("c");

      vi.advanceTimersByTime(4000);
      expect(cache.get("medium")).toBeUndefined();
      expect(cache.get("long")).toBe("c");

      vi.advanceTimersByTime(5000);
      expect(cache.get("long")).toBeUndefined();
    });
  });

  describe("getOrSet", () => {
    it("computes and caches a value on first call", async () => {
      const compute = vi.fn().mockResolvedValue("computed");
      const result = await cache.getOrSet("key", compute);
      expect(result).toBe("computed");
      expect(compute).toHaveBeenCalledOnce();
    });

    it("returns cached value without recomputing on second call", async () => {
      const compute = vi.fn().mockResolvedValue("computed");
      await cache.getOrSet("key", compute);
      const result = await cache.getOrSet("key", compute);
      expect(result).toBe("computed");
      expect(compute).toHaveBeenCalledOnce();
    });

    it("recomputes after TTL expires", async () => {
      let callCount = 0;
      const compute = vi.fn().mockImplementation(async () => {
        callCount++;
        return `value-${callCount}`;
      });

      const first = await cache.getOrSet("key", compute, 5000);
      expect(first).toBe("value-1");

      vi.advanceTimersByTime(5001);

      const second = await cache.getOrSet("key", compute, 5000);
      expect(second).toBe("value-2");
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("uses default TTL when none is specified", async () => {
      const compute = vi.fn().mockResolvedValue("data");
      await cache.getOrSet("key", compute);

      vi.advanceTimersByTime(59999);
      const still = await cache.getOrSet("key", compute);
      expect(still).toBe("data");
      expect(compute).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(2);
      const recomputed = await cache.getOrSet("key", compute);
      expect(recomputed).toBe("data");
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("uses custom TTL when provided", async () => {
      const compute = vi.fn().mockResolvedValue("data");
      await cache.getOrSet("key", compute, 3000);

      vi.advanceTimersByTime(3001);
      await cache.getOrSet("key", compute, 3000);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("caches different keys independently", async () => {
      const computeA = vi.fn().mockResolvedValue("A");
      const computeB = vi.fn().mockResolvedValue("B");

      await cache.getOrSet("a", computeA);
      await cache.getOrSet("b", computeB);

      expect(cache.get("a")).toBe("A");
      expect(cache.get("b")).toBe("B");
    });
  });

  describe("invalidate", () => {
    it("removes a specific key", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.invalidate("a");
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
    });

    it("does nothing for a nonexistent key", () => {
      // Should not throw
      cache.invalidate("nonexistent");
      expect(cache.get("nonexistent")).toBeUndefined();
    });
  });

  describe("invalidatePrefix", () => {
    it("removes all keys matching the prefix", () => {
      cache.set("user:1", "Alice");
      cache.set("user:2", "Bob");
      cache.set("user:3", "Charlie");
      cache.set("post:1", "Hello");

      cache.invalidatePrefix("user:");

      expect(cache.get("user:1")).toBeUndefined();
      expect(cache.get("user:2")).toBeUndefined();
      expect(cache.get("user:3")).toBeUndefined();
      expect(cache.get("post:1")).toBe("Hello");
    });

    it("removes nothing if no keys match the prefix", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.invalidatePrefix("z:");
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
    });

    it("handles empty prefix (removes all keys)", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.invalidatePrefix("");
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.clear();
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBeUndefined();
    });

    it("does nothing on an empty cache", () => {
      // Should not throw
      cache.clear();
    });
  });
});

describe("appCache singleton", () => {
  it("exists and is an instance of MemoryCache", () => {
    expect(appCache).toBeDefined();
    expect(appCache).toBeInstanceOf(MemoryCache);
  });

  it("supports basic get/set operations", () => {
    appCache.set("test-singleton", "works");
    expect(appCache.get("test-singleton")).toBe("works");
    appCache.invalidate("test-singleton");
  });
});
