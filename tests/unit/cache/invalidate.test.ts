import { describe, it, expect, vi } from "vitest";
import { appCache } from "@/lib/cache/memory-cache";
import { invalidateMediaCaches, invalidateRuleSetNameCaches } from "@/lib/cache/invalidate";

describe("invalidateMediaCaches", () => {
  it("invalidates every media-derived cache prefix", () => {
    const spy = vi.spyOn(appCache, "invalidatePrefix");
    invalidateMediaCaches();
    const prefixes = spy.mock.calls.map((c) => c[0]);
    for (const p of [
      "server-filter:",
      "distinct-values",
      "query-distinct-values",
      "stats:",
      "group-summary:",
      "cross-tab:",
      "custom-stats:",
      "timeline:",
      "watch-history-filters:",
      "recently-added:",
      "query-action-live:",
    ]) {
      expect(prefixes).toContain(p);
    }
    spy.mockRestore();
  });

  it("drops matching entries but leaves unrelated keys intact", () => {
    appCache.set("stats:user:all:dedup", { a: 1 });
    appCache.set("server-filter:user:all:any", { b: 2 });
    appCache.set("unrelated:key", { c: 3 });

    invalidateMediaCaches();

    expect(appCache.get("stats:user:all:dedup")).toBeUndefined();
    expect(appCache.get("server-filter:user:all:any")).toBeUndefined();
    expect(appCache.get("unrelated:key")).toEqual({ c: 3 });

    appCache.invalidate("unrelated:key");
  });

  it("drops the Query page's distinct values, which no other prefix covers", () => {
    // `query-distinct-values` does not start with `distinct-values`: before it
    // had its own entry the Query page's dropdowns outlived every sync.
    appCache.set("distinct-values", { genre: ["Old"] }, 5 * 60_000);
    appCache.set("query-distinct-values", { genre: ["Old"] }, 5 * 60_000);

    invalidateMediaCaches();

    expect(appCache.get("distinct-values")).toBeUndefined();
    expect(appCache.get("query-distinct-values")).toBeUndefined();
  });
});

describe("invalidateRuleSetNameCaches", () => {
  it("drops both dropdown payloads that list rule set names, and nothing else", () => {
    appCache.set("distinct-values", { matchedByRuleSet: ["Old"] }, 5 * 60_000);
    appCache.set("query-distinct-values", { matchedByRuleSet: ["Old"] }, 5 * 60_000);
    appCache.set("distinct-values:genres", ["Drama"], 5 * 60_000);

    invalidateRuleSetNameCaches();

    expect(appCache.get("distinct-values")).toBeUndefined();
    expect(appCache.get("query-distinct-values")).toBeUndefined();
    expect(appCache.get("distinct-values:genres")).toEqual(["Drama"]);
    appCache.invalidate("distinct-values:genres");
  });
});
