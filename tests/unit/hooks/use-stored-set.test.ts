// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStoredSet } from "@/hooks/use-stored-set";

const KEY = "test-visible-columns";
const DEFAULTS = ["title", "year"];

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useStoredSet", () => {
  it("reads the defaults with nothing stored, and what is stored otherwise", () => {
    expect([...renderHook(() => useStoredSet(KEY, DEFAULTS)).result.current[0]]).toEqual(DEFAULTS);
    localStorage.setItem(KEY, JSON.stringify(["size"]));
    expect([...renderHook(() => useStoredSet(KEY, DEFAULTS)).result.current[0]]).toEqual(["size"]);
  });

  it("reads anything but a list of strings as the defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ size: true }));
    expect([...renderHook(() => useStoredSet(KEY, DEFAULTS)).result.current[0]]).toEqual(DEFAULTS);
    localStorage.setItem(KEY, "not json");
    expect([...renderHook(() => useStoredSet(KEY, DEFAULTS)).result.current[0]]).toEqual(DEFAULTS);
    localStorage.setItem(KEY, JSON.stringify([1, 2]));
    expect([...renderHook(() => useStoredSet(KEY, DEFAULTS)).result.current[0]]).toEqual(DEFAULTS);
  });

  it("stores every change, and every reader of the key follows it", () => {
    const a = renderHook(() => useStoredSet(KEY, DEFAULTS));
    const b = renderHook(() => useStoredSet(KEY, DEFAULTS));
    act(() => a.result.current[1].toggle("size"));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["title", "year", "size"]);
    expect([...b.result.current[0]]).toEqual(["title", "year", "size"]);
    act(() => b.result.current[1].toggle("title"));
    act(() => b.result.current[1].remove("year"));
    act(() => b.result.current[1].add("a", "b"));
    expect([...a.result.current[0]]).toEqual(["size", "a", "b"]);
    act(() => a.result.current[1].replace(["z", "z"]));
    expect([...b.result.current[0]]).toEqual(["z"]);
    act(() => a.result.current[1].clear());
    expect(b.result.current[0].size).toBe(0);
    expect(b.result.current[1].has("z")).toBe(false);
  });

  it("keeps working where localStorage throws (a private window)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useStoredSet(KEY, DEFAULTS));
    expect([...result.current[0]]).toEqual(DEFAULTS);
    expect(() => act(() => result.current[1].toggle("size"))).not.toThrow();
  });
});
