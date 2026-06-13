import { describe, it, expect, vi } from "vitest";
import { subProgress, splitProgress } from "@/lib/progress/fraction";

describe("subProgress", () => {
  it("returns undefined when there is no parent reporter", () => {
    expect(subProgress(undefined, 0.1, 0.9)).toBeUndefined();
  });

  it("scales a child fraction into the [lo, hi] sub-range", () => {
    const seen: number[] = [];
    const scaled = subProgress((f) => seen.push(f), 0.2, 0.8)!;
    scaled(0);
    scaled(0.5);
    scaled(1);
    expect(seen).toEqual([0.2, 0.5, 0.8]);
  });

  it("clamps out-of-range and NaN child fractions", () => {
    const seen: number[] = [];
    const scaled = subProgress((f) => seen.push(f), 0, 1)!;
    scaled(-1);
    scaled(2);
    scaled(NaN);
    expect(seen).toEqual([0, 1, 0]);
  });
});

describe("splitProgress", () => {
  it("returns an empty array for n <= 0", () => {
    expect(splitProgress(() => {}, 0)).toEqual([]);
  });

  it("forwards the mean of all children to the parent", () => {
    const report = vi.fn();
    const [a, b] = splitProgress(report, 2);
    a(1); // (1 + 0) / 2
    b(1); // (1 + 1) / 2
    expect(report).toHaveBeenNthCalledWith(1, 0.5);
    expect(report).toHaveBeenNthCalledWith(2, 1);
  });

  it("stays monotonic as children advance independently", () => {
    const values: number[] = [];
    const [a, b, c] = splitProgress((f) => values.push(f), 3);
    a(0.5); // 0.5/3
    b(1); //   (0.5 + 1)/3
    a(1); //   (1 + 1)/3
    c(1); //   (1 + 1 + 1)/3
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
    expect(values[values.length - 1]).toBe(1);
  });

  it("produces working no-op reporters when there is no parent", () => {
    const reporters = splitProgress(undefined, 2);
    expect(reporters).toHaveLength(2);
    // Should not throw.
    expect(() => reporters.forEach((r) => r(0.5))).not.toThrow();
  });
});
