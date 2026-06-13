import { describe, it, expect, vi } from "vitest";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";

describe("invalidateMediaCaches", () => {
  it("invalidates every media-derived cache prefix", () => {
    const spy = vi.spyOn(appCache, "invalidatePrefix");
    invalidateMediaCaches();
    const prefixes = spy.mock.calls.map((c) => c[0]);
    for (const p of [
      "server-filter:",
      "distinct-values",
      "stats:",
      "letters:",
      "group-summary:",
      "cross-tab:",
      "custom-stats:",
      "timeline:",
      "watch-history-filters:",
    ]) {
      expect(prefixes).toContain(p);
    }
    spy.mockRestore();
  });

  it("drops matching entries but leaves unrelated keys intact", () => {
    appCache.set("stats:user:all:dedup", { a: 1 });
    appCache.set("server-filter:user:all:any", { b: 2 });
    appCache.set("letters:movies:user:all::", ["A", "B"]);
    appCache.set("unrelated:key", { c: 3 });

    invalidateMediaCaches();

    expect(appCache.get("stats:user:all:dedup")).toBeUndefined();
    expect(appCache.get("server-filter:user:all:any")).toBeUndefined();
    expect(appCache.get("letters:movies:user:all::")).toBeUndefined();
    expect(appCache.get("unrelated:key")).toEqual({ c: 3 });

    appCache.invalidate("unrelated:key");
  });
});
