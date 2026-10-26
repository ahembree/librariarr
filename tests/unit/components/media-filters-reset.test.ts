// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { MediaFilters } from "@/components/media-filters";

/**
 * A library page's own "Clear Filters" empties the filter panel through
 * `resetKey` (see `useFilterPanelReset`) instead of remounting it, so the
 * options the panel fetched stay loaded and nothing is re-sent to the page.
 */

const fetchMock = vi.fn();
const distinctCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/media/distinct-values").length;

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ resolution: ["4K", "1080P"] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function panel(props: { resetKey: number; externalFilters?: Record<string, string>; onFilterChange: () => void }) {
  return createElement(MediaFilters, { mediaType: "MOVIE", ...props });
}

describe("MediaFilters resetKey", () => {
  it("empties the panel in place, keeping its options and sending the page nothing", async () => {
    vi.useFakeTimers();
    const onFilterChange = vi.fn();
    const restored = { search: "alien", resolution: "4K" };
    const { rerender } = render(panel({ resetKey: 0, externalFilters: restored, onFilterChange }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const box = screen.getByPlaceholderText("Search titles...") as HTMLInputElement;
    expect(box.value).toBe("alien");
    expect(screen.getByText("Search:")).toBeTruthy();
    // The restored filters are handed back once, as the page's own copy.
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenLastCalledWith(restored);
    expect(distinctCalls()).toBe(1);

    // The page cleared its copy and no longer hands the restored filters over.
    rerender(panel({ resetKey: 1, externalFilters: undefined, onFilterChange }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(box.value).toBe("");
    expect(screen.queryByText("Search:")).toBeNull();
    // Not remounted: the box is the same element and the options were not fetched again.
    expect(screen.getByPlaceholderText("Search titles...")).toBe(box);
    expect(distinctCalls()).toBe(1);
    // Nothing is re-sent: not the empty set (the page already holds it), and
    // not a late search debounce for the emptied box.
    expect(onFilterChange).toHaveBeenCalledTimes(1);
  });

  it("still applies a search typed after the reset", async () => {
    vi.useFakeTimers();
    const onFilterChange = vi.fn();
    const { rerender } = render(panel({ resetKey: 0, onFilterChange }));
    rerender(panel({ resetKey: 1, onFilterChange }));

    const box = screen.getByPlaceholderText("Search titles...");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(box, "blade");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(onFilterChange).toHaveBeenLastCalledWith({ search: "blade" });
  });
});
