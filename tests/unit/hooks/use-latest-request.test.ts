// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLatestRequest } from "@/hooks/use-latest-request";

describe("useLatestRequest", () => {
  it("keeps only the latest token current", () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(true);
    const second = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
  });

  it("makes every started request stale on cancel", () => {
    const { result } = renderHook(() => useLatestRequest());
    const token = result.current.begin();
    result.current.cancel();
    expect(result.current.isCurrent(token)).toBe(false);
  });

  it("is one stable object across renders", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
