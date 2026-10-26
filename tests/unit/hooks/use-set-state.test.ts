// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSetState } from "@/hooks/use-set-state";

describe("useSetState", () => {
  it("starts from the initial values (or a lazy initializer)", () => {
    expect([...renderHook(() => useSetState(["a", "b"])).result.current[0]]).toEqual(["a", "b"]);
    expect([...renderHook(() => useSetState(() => [1])).result.current[0]]).toEqual([1]);
    expect(renderHook(() => useSetState<string>()).result.current[0].size).toBe(0);
  });

  it("toggles, adds, removes, replaces and clears, each a new set", () => {
    const { result } = renderHook(() => useSetState<string>());
    const seen = [result.current[0]];
    act(() => result.current[1].toggle("a"));
    act(() => result.current[1].add("b", "c"));
    act(() => result.current[1].toggle("a"));
    act(() => result.current[1].remove("c"));
    expect([...result.current[0]]).toEqual(["b"]);
    expect(result.current[1].has("b")).toBe(true);
    act(() => result.current[1].replace(["x", "y", "x"]));
    expect([...result.current[0]]).toEqual(["x", "y"]);
    seen.push(result.current[0]);
    act(() => result.current[1].clear());
    expect(result.current[0].size).toBe(0);
    seen.push(result.current[0]);
    expect(new Set(seen).size).toBe(3);
  });

  it("keeps the same set for an update that changes nothing", () => {
    const { result } = renderHook(() => useSetState(["a"]));
    const before = result.current[0];
    act(() => result.current[1].add("a"));
    act(() => result.current[1].remove("zz"));
    expect(result.current[0]).toBe(before);
    act(() => result.current[1].clear());
    const empty = result.current[0];
    act(() => result.current[1].clear());
    expect(result.current[0]).toBe(empty);
  });

  it("keeps its updaters stable", () => {
    const { result } = renderHook(() => useSetState<string>());
    const { toggle, add, remove, clear, replace } = result.current[1];
    act(() => toggle("a"));
    expect(result.current[1].toggle).toBe(toggle);
    expect(result.current[1].add).toBe(add);
    expect(result.current[1].remove).toBe(remove);
    expect(result.current[1].clear).toBe(clear);
    expect(result.current[1].replace).toBe(replace);
  });
});
