import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  markSelfWrites,
  isSelfWrite,
  SELF_WRITE_TTL_MS,
  _resetSelfWritesForTesting,
} from "@/lib/media-server/realtime/self-writes";

describe("self-writes registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSelfWritesForTesting();
  });
  afterEach(() => vi.useRealTimers());

  it("recognises a marked ratingKey on its server only", () => {
    markSelfWrites("s1", ["a", "b"]);
    expect(isSelfWrite("s1", "a")).toBe(true);
    expect(isSelfWrite("s1", "b")).toBe(true);
    expect(isSelfWrite("s1", "c")).toBe(false);
    // Rating keys are per-server rowids; the same key elsewhere is another item.
    expect(isSelfWrite("s2", "a")).toBe(false);
  });

  it("expires a mark after the TTL", () => {
    markSelfWrites("s1", ["a"]);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS - 1);
    expect(isSelfWrite("s1", "a")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSelfWrite("s1", "a")).toBe(false);
  });

  it("re-marking refreshes the window", () => {
    // `collections.ts` re-marks after its last write, so a long ordering pass
    // stays covered even when it outlasts the mark placed before the first one.
    markSelfWrites("s1", ["a"]);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS - 1);
    markSelfWrites("s1", ["a"]);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS - 1);
    expect(isSelfWrite("s1", "a")).toBe(true);
  });

  it("honours a custom TTL", () => {
    markSelfWrites("s1", ["a"], 1_000);
    vi.advanceTimersByTime(999);
    expect(isSelfWrite("s1", "a")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSelfWrite("s1", "a")).toBe(false);
  });

  it("coerces keys to strings, matching the normalizer's String(itemID)", () => {
    markSelfWrites("s1", [123 as unknown as string]);
    expect(isSelfWrite("s1", "123")).toBe(true);
  });

  it("does not keep expired marks alive across later marks", () => {
    // The registry is bounded by what was marked inside one window.
    markSelfWrites("s1", ["old"]);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS + 1);
    markSelfWrites("s1", ["new"]);
    expect(isSelfWrite("s1", "old")).toBe(false);
    expect(isSelfWrite("s1", "new")).toBe(true);
  });

  it("reset forgets every mark", () => {
    markSelfWrites("s1", ["a"]);
    _resetSelfWritesForTesting();
    expect(isSelfWrite("s1", "a")).toBe(false);
  });
});
