// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { VirtualPosterGrid } from "@/hooks/use-virtual-poster-grid";

const mocks = vi.hoisted(() => ({
  subscribers: [] as { type: string; cb: (data: Record<string, unknown>) => void }[],
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: (data: Record<string, unknown>) => void) => {
    mocks.subscribers.push({ type, cb });
    return { connected: true, authExpired: false };
  },
}));

import { useLibrarySyncRefetch } from "@/hooks/use-library-sync-refetch";
import { useFilterPanelReset } from "@/hooks/use-filter-panel-reset";
import { LIBRARY_CARD_CONTENT_HEIGHT, useLibraryAlphabet } from "@/hooks/use-library-grid";
import { CARD_CONTENT_HEIGHT } from "@/components/media-card";

/** The latest subscriber's callback for `type`, as an arriving event calls it. */
function emit(type: string, data: Record<string, unknown>) {
  act(() => mocks.subscribers.filter((s) => s.type === type).at(-1)!.cb(data));
}

beforeEach(() => {
  mocks.subscribers = [];
});

describe("useLibrarySyncRefetch", () => {
  it("refetches only on a sync that can have changed the view", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook(({ serverId }) => useLibrarySyncRefetch({ types: "MOVIE", serverId }, refetch), {
      initialProps: { serverId: "all" },
    });

    emit("sync:completed", { timestamp: 1, serverId: "s1", libraryTypes: ["SERIES"] });
    expect(refetch).not.toHaveBeenCalled();
    emit("sync:completed", { timestamp: 2, serverId: "s1", libraryTypes: ["MOVIE"] });
    expect(refetch).toHaveBeenCalledTimes(1);
    // A reconnect's resync and an older server send no meta.
    emit("sync:completed", {});
    expect(refetch).toHaveBeenCalledTimes(2);

    // The scope it reads is the latest render's.
    rerender({ serverId: "s2" });
    emit("sync:completed", { timestamp: 3, serverId: "s1", libraryTypes: ["MOVIE"] });
    expect(refetch).toHaveBeenCalledTimes(2);
    emit("sync:completed", { timestamp: 4, serverId: "s2", libraryTypes: ["MOVIE"] });
    expect(refetch).toHaveBeenCalledTimes(3);
  });
});

describe("useFilterPanelReset", () => {
  it("hands the panel the restored filters until a clear, which empties it", () => {
    const clearFilters = vi.fn();
    const restored = { resolution: "4K" };
    const { result } = renderHook(() => useFilterPanelReset(restored, clearFilters));
    expect(result.current.externalFilters).toBe(restored);
    const before = result.current.resetKey;

    act(() => result.current.clear());
    expect(clearFilters).toHaveBeenCalledTimes(1);
    expect(result.current.resetKey).not.toBe(before);
    // Handed again, the emptied panel would re-apply them.
    expect(result.current.externalFilters).toBeUndefined();
  });
});

describe("useLibraryAlphabet", () => {
  const items = [{ title: "Alien" }, { title: "Blade Runner" }, { title: "Brazil" }, { title: "Zodiac" }];

  function fakeGrid(scrollToIndex = vi.fn()): VirtualPosterGrid {
    return {
      columns: 2,
      scrollElement: null,
      virtualizer: { scrollToIndex, getVirtualItems: () => [], options: { scrollMargin: 0 } },
    } as unknown as VirtualPosterGrid;
  }

  it("jumps the grid by row in the card view", () => {
    const scrollToIndex = vi.fn();
    const grid = fakeGrid(scrollToIndex);
    const { result } = renderHook(() => useLibraryAlphabet(items, grid, "cards"));
    expect([...result.current.availableLetters].sort()).toEqual(["A", "B", "Z"]);
    act(() => result.current.onLetterClick("Z"));
    // Zodiac is the fourth item: the second row of two.
    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "start" });
  });

  it("jumps the table by item in the table view", () => {
    const scrollToIndex = vi.fn();
    const grid = fakeGrid(scrollToIndex);
    const { result } = renderHook(() => useLibraryAlphabet(items, grid, "table"));
    const tableScroll = vi.fn();
    result.current.tableScrollToIndexRef.current = tableScroll;
    act(() => result.current.onLetterClick("B"));
    expect(tableScroll).toHaveBeenCalledWith(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("sizes a library card's content as the content block, quality bar and border", () => {
    expect(LIBRARY_CARD_CONTENT_HEIGHT).toBe(CARD_CONTENT_HEIGHT + 12 + 2);
  });
});
