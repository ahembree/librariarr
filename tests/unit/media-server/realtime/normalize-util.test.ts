import { describe, it, expect } from "vitest";
import { isRecord, asArray } from "@/lib/media-server/realtime/normalize-util";

describe("isRecord", () => {
  it("accepts objects and arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true);
  });

  it.each([[null], [undefined], [0], ["x"], [true]])("rejects %o", (v) => {
    expect(isRecord(v)).toBe(false);
  });
});

describe("asArray", () => {
  it("returns an array unchanged", () => {
    const arr = [1, 2];
    expect(asArray(arr)).toBe(arr);
  });

  it("wraps a single value", () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray(0)).toEqual([0]);
    expect(asArray("")).toEqual([""]);
  });

  it("returns an empty array for null or undefined", () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });
});
