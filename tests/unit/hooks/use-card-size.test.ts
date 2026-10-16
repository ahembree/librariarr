// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCardSize, estimateContentWidth } from "@/hooks/use-card-size";

function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
}

beforeEach(() => {
  localStorage.clear();
  setWidth(1400);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const throwingStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};


describe("estimateContentWidth", () => {
  it("subtracts the chrome for each breakpoint", () => {
    expect(estimateContentWidth(1400)).toBe(1100);
    expect(estimateContentWidth(1100)).toBe(1000);
    expect(estimateContentWidth(800)).toBe(720);
    expect(estimateContentWidth(375)).toBe(327);
  });
});

describe("useCardSize", () => {
  it("defaults to medium and derives the desktop columns", () => {
    const { result } = renderHook(() => useCardSize());
    expect(result.current.size).toBe("medium");
    expect(result.current.cardWidth).toBe(125);
    // (1100 + 16) / (125 + 16) = 7.9
    expect(result.current.columns).toBe(7);
    expect(result.current.gridStyle.gridTemplateColumns).toBe("repeat(auto-fill, minmax(125px, 1fr))");
    expect(result.current.landscapeGridStyle.gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(200px, 1fr))",
    );
  });

  it("reads a stored size and ignores an unknown one", () => {
    localStorage.setItem("library-card-size", "large");
    const { result } = renderHook(() => useCardSize());
    expect(result.current.size).toBe("large");
    expect(result.current.cardWidth).toBe(175);

    localStorage.setItem("library-card-size", "huge");
    const { result: r2 } = renderHook(() => useCardSize());
    expect(r2.current.size).toBe("medium");
  });

  it("setSize persists and updates every mounted hook", () => {
    const { result: a } = renderHook(() => useCardSize());
    const { result: b } = renderHook(() => useCardSize());
    act(() => a.current.setSize("small"));
    expect(localStorage.getItem("library-card-size")).toBe("small");
    expect(a.current.size).toBe("small");
    expect(b.current.size).toBe("small");
    expect(b.current.cardWidth).toBe(100);
  });

  it("uses the mobile widths below md and never fewer than two columns", () => {
    setWidth(375);
    const { result } = renderHook(() => useCardSize());
    expect(result.current.cardWidth).toBe(100);
    expect(result.current.columns).toBe(2);
    expect(result.current.landscapeGridStyle.gridTemplateColumns).toContain("140px");
    act(() => result.current.setSize("small"));
    expect(result.current.cardWidth).toBe(80);
    // (327 + 16) / (80 + 16) = 3.57
    expect(result.current.columns).toBe(3);

    setWidth(200);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    act(() => result.current.setSize("large"));
    expect(result.current.columns).toBe(2);
  });

  it("recomputes on window resize", () => {
    const { result } = renderHook(() => useCardSize());
    expect(result.current.columns).toBe(7);
    setWidth(1100);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // lg: (1000 + 16) / 141 = 7.2
    expect(result.current.columns).toBe(7);
    setWidth(800);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // md: (720 + 16) / 141 = 5.2
    expect(result.current.columns).toBe(5);
  });

  it("adds the resize listener for the first subscriber and removes it after the last", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const a = renderHook(() => useCardSize());
    const b = renderHook(() => useCardSize());
    expect(add.mock.calls.filter(([t]) => t === "resize")).toHaveLength(1);
    a.unmount();
    expect(remove.mock.calls.filter(([t]) => t === "resize")).toHaveLength(0);
    b.unmount();
    expect(remove.mock.calls.filter(([t]) => t === "resize")).toHaveLength(1);
  });

  it("survives storage throwing", () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { result } = renderHook(() => useCardSize());
    expect(result.current.size).toBe("medium");
    expect(() => act(() => result.current.setSize("large"))).not.toThrow();
  });
});
