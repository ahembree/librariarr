// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderHook, act, render, screen, fireEvent } from "@testing-library/react";
import { Film } from "lucide-react";
import { useLibraryListState } from "@/hooks/use-library-list-state";
import { LibraryEmptyState } from "@/components/library-empty-state";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("useLibraryListState", () => {
  it("starts on the stored view mode at once, and stores a change", () => {
    localStorage.setItem("movies-view-mode", "table");
    const { result } = renderHook(() => useLibraryListState("movies"));
    expect(result.current.viewMode).toBe("table");
    act(() => result.current.setViewMode("cards"));
    expect(result.current.viewMode).toBe("cards");
    expect(localStorage.getItem("movies-view-mode")).toBe("cards");
  });

  it("reads an unknown stored view mode as the default", () => {
    localStorage.setItem("movies-view-mode", "grid");
    expect(renderHook(() => useLibraryListState("movies")).result.current.viewMode).toBe("cards");
    expect(
      renderHook(() => useLibraryListState("other", "title", { defaultViewMode: "table" })).result.current.viewMode,
    ).toBe("table");
  });

  it("toggles the sort as the headers and the picker do", () => {
    const { result } = renderHook(() => useLibraryListState("movies", "title"));
    expect([result.current.sortBy, result.current.sortOrder]).toEqual(["title", "asc"]);
    act(() => result.current.toggleSort("title"));
    expect(result.current.sortOrder).toBe("desc");
    act(() => result.current.toggleSort("year"));
    expect([result.current.sortBy, result.current.sortOrder]).toEqual(["year", "asc"]);
    act(() => result.current.toggleOrder());
    expect(result.current.sortOrder).toBe("desc");
    const desc = renderHook(() => useLibraryListState("h", "watchedAt", { defaultSortOrder: "desc" }));
    expect(desc.result.current.sortOrder).toBe("desc");
  });

  it("starts from the saved filters and keeps them across a visit", () => {
    sessionStorage.setItem("filters-/library/movies", JSON.stringify({ resolution: "4K" }));
    const { result } = renderHook(() => useLibraryListState("movies", "title", { filtersKey: "filters-/library/movies" }));
    expect(result.current.filters).toEqual({ resolution: "4K" });
    expect(result.current.externalFilters).toEqual({ resolution: "4K" });
    expect(result.current.hasFilters).toBe(true);
    act(() => result.current.onFilterChange({ resolution: "1080P" }));
    expect(JSON.parse(sessionStorage.getItem("filters-/library/movies")!)).toEqual({ resolution: "1080P" });
    act(() => result.current.clearFilters());
    expect(result.current.hasFilters).toBe(false);
    expect(sessionStorage.getItem("filters-/library/movies")).toBeNull();
  });

  it("keeps the same filters object for a re-broadcast of the filters it holds", () => {
    const { result } = renderHook(() => useLibraryListState("movies"));
    act(() => result.current.onFilterChange({ genre: "Drama" }));
    const held = result.current.filters;
    act(() => result.current.onFilterChange({ genre: "Drama" }));
    expect(result.current.filters).toBe(held);
  });

  it("stores no filters without a key", () => {
    const { result } = renderHook(() => useLibraryListState("tracks"));
    expect(result.current.externalFilters).toBeUndefined();
    act(() => result.current.onFilterChange({ genre: "Rock" }));
    expect(sessionStorage.length).toBe(0);
  });
});

describe("LibraryEmptyState", () => {
  it("offers Clear Filters when filters emptied the list", () => {
    const onClear = vi.fn();
    render(createElement(LibraryEmptyState, { icon: Film, noun: "movies", hasFilters: true, onClear }));
    expect(screen.getByText("No movies found.")).toBeTruthy();
    expect(screen.getByText("Try adjusting your filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("points at a sync otherwise", () => {
    render(createElement(LibraryEmptyState, { icon: Film, noun: "series", hasFilters: false, onClear: () => {} }));
    expect(screen.getByText("No series found.")).toBeTruthy();
    expect(screen.getByText("Sync a media server to get started.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
