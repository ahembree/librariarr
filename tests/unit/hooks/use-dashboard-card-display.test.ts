// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDashboardCardDisplay } from "@/hooks/use-dashboard-card-display";
import type { CardDisplay } from "@/lib/dashboard/card-display";

describe("useDashboardCardDisplay", () => {
  it("on the dashboard, hands every change to onChange with the defaults dropped", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDashboardCardDisplay({ view: "donut" }, onChange, undefined));
    expect(result.current[0]).toEqual({ view: "donut" });

    act(() => result.current[1]({ topN: 10 }));
    expect(onChange).toHaveBeenLastCalledWith({ view: "donut", topN: 10 });
    act(() => result.current[1]({ view: undefined }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("shows what the layout holds, not a copy of its own", () => {
    let display: CardDisplay | undefined = { topN: 10 };
    const { result, rerender } = renderHook(() => useDashboardCardDisplay(display, vi.fn(), undefined));
    display = { topN: 20 };
    rerender();
    expect(result.current[0]).toEqual({ topN: 20 });
  });

  it("without onChange keeps its own choices, and drops its type pick when the outside filter changes", () => {
    const { result, rerender } = renderHook(
      ({ filter }: { filter: string | undefined }) => useDashboardCardDisplay(undefined, undefined, filter),
      { initialProps: { filter: undefined as string | undefined } },
    );
    expect(result.current[0]).toEqual({});

    act(() => result.current[1]({ type: "SERIES", view: "donut" }));
    expect(result.current[0]).toEqual({ type: "SERIES", view: "donut" });

    rerender({ filter: "MOVIE" });
    expect(result.current[0]).toEqual({ view: "donut" });
  });
});
