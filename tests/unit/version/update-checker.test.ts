import { describe, it, expect } from "vitest";
import { compareSemver } from "@/lib/version/update-checker";

describe("compareSemver", () => {
  it("compares numeric major/minor/patch", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
  });

  it("ignores a leading v and missing segments", () => {
    expect(compareSemver("v1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });

  it("ranks a pre-release below the matching final release", () => {
    expect(compareSemver("1.2.0-rc1", "1.2.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.2.0-rc1")).toBe(1);
  });

  it("does not treat a pre-release patch as 0 (no false-equal with the prior release)", () => {
    // Old behavior parsed "0-rc1" → 0, making 1.2.0-rc1 equal to 1.2.0.
    expect(compareSemver("1.2.0-rc1", "1.2.0")).not.toBe(0);
  });

  it("orders pre-releases lexically when cores match", () => {
    expect(compareSemver("1.2.0-rc1", "1.2.0-rc2")).toBe(-1);
    expect(compareSemver("1.2.0-rc2", "1.2.0-rc1")).toBe(1);
    expect(compareSemver("1.2.0-rc1", "1.2.0-rc1")).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(compareSemver("1.2.0+build5", "1.2.0")).toBe(0);
  });
});
