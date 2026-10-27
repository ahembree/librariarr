// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  publishLiveSessionCount,
  getLiveSessionCount,
  subscribeLiveSessionCount,
  useLiveSessionCount,
} from "@/hooks/use-live-session-count";

afterEach(() => {
  publishLiveSessionCount(null);
});

describe("live session count", () => {
  it("is null until something publishes, and tells subscribers of each change once", () => {
    expect(getLiveSessionCount()).toBeNull();
    const listener = vi.fn();
    const unsubscribe = subscribeLiveSessionCount(listener);
    publishLiveSessionCount(2);
    publishLiveSessionCount(2);
    publishLiveSessionCount(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getLiveSessionCount()).toBe(0);
    unsubscribe();
    publishLiveSessionCount(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("re-renders a reader as the count changes", () => {
    const { result } = renderHook(() => useLiveSessionCount());
    expect(result.current).toBeNull();
    act(() => publishLiveSessionCount(3));
    expect(result.current).toBe(3);
    act(() => publishLiveSessionCount(null));
    expect(result.current).toBeNull();
  });
});
