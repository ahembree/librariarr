// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShownList } from "@/hooks/use-shown-list";

describe("useShownList", () => {
  it("reads a load of the list on screen as a refresh", () => {
    const { result } = renderHook(() => useShownList());
    expect(result.current.begin("/l?a=1")).toBe(false);
    result.current.markShown("/l?a=1");
    expect(result.current.begin("/l?a=1")).toBe(true);
  });

  it("forgets the list on screen once another list starts loading", () => {
    const { result } = renderHook(() => useShownList());
    result.current.markShown("/l?a=1");
    // A filter change: the page shows its skeleton.
    expect(result.current.begin("/l?a=2")).toBe(false);
    // Changed back before the other list answered: the skeleton is up, so
    // this is a load, not a refresh of what is on screen.
    expect(result.current.begin("/l?a=1")).toBe(false);
  });

  it("is stable across renders", () => {
    const { result, rerender } = renderHook(() => useShownList());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
