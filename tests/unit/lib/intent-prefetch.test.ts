import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { INTENT_DELAY_MS, intentHandlers } from "@/lib/intent-prefetch";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const element = () => ({}) as Element;

describe("intentHandlers", () => {
  it("is empty without a callback", () => {
    expect(intentHandlers(undefined)).toEqual({});
  });

  it("fires once a mouse pointer has rested on the element", () => {
    const onIntent = vi.fn();
    const h = intentHandlers(onIntent);
    const el = element();
    h.onPointerEnter!({ pointerType: "mouse", currentTarget: el });
    vi.advanceTimersByTime(INTENT_DELAY_MS - 1);
    expect(onIntent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIntent).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a pointer that only passes over", () => {
    const onIntent = vi.fn();
    const h = intentHandlers(onIntent);
    const el = element();
    h.onPointerEnter!({ pointerType: "mouse", currentTarget: el });
    vi.advanceTimersByTime(INTENT_DELAY_MS / 2);
    h.onPointerLeave!({ currentTarget: el });
    vi.advanceTimersByTime(INTENT_DELAY_MS * 2);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("fires at once on a mouse or pen press, or focus", () => {
    const onIntent = vi.fn();
    const h = intentHandlers(onIntent);
    h.onPointerDown!({ pointerType: "mouse" });
    h.onPointerDown!({ pointerType: "pen" });
    h.onFocus!();
    expect(onIntent).toHaveBeenCalledTimes(3);
  });

  it("starts nothing for touch, whose press also begins every scroll", () => {
    const onIntent = vi.fn();
    const h = intentHandlers(onIntent);
    h.onPointerEnter!({ pointerType: "touch", currentTarget: element() });
    vi.advanceTimersByTime(INTENT_DELAY_MS * 2);
    h.onPointerDown!({ pointerType: "touch" });
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("restarts the wait when the pointer re-enters", () => {
    const onIntent = vi.fn();
    const h = intentHandlers(onIntent);
    const el = element();
    h.onPointerEnter!({ pointerType: "mouse", currentTarget: el });
    vi.advanceTimersByTime(INTENT_DELAY_MS - 10);
    h.onPointerEnter!({ pointerType: "mouse", currentTarget: el });
    vi.advanceTimersByTime(INTENT_DELAY_MS - 10);
    expect(onIntent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(onIntent).toHaveBeenCalledTimes(1);
  });
});
