// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFilterPersistence } from "@/hooks/use-filter-persistence";

const KEY = "filters-/library/movies";

beforeEach(() => {
  sessionStorage.clear();
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


describe("useFilterPersistence", () => {
  it("starts with no saved filters", () => {
    const { result } = renderHook(() => useFilterPersistence(KEY));
    expect(result.current.savedFilters).toEqual({});
  });

  it("restores filters saved under its key", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ resolution: "4K" }));
    const { result } = renderHook(() => useFilterPersistence(KEY));
    expect(result.current.savedFilters).toEqual({ resolution: "4K" });
  });

  it("reads storage once, so savedFilters keeps its identity across renders", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ genre: "Drama" }));
    const { result, rerender } = renderHook(() => useFilterPersistence(KEY));
    const first = result.current.savedFilters;
    sessionStorage.setItem(KEY, JSON.stringify({ genre: "Comedy" }));
    rerender();
    expect(result.current.savedFilters).toBe(first);
  });

  it("falls back to no filters on corrupt JSON", () => {
    sessionStorage.setItem(KEY, "{not json");
    const { result } = renderHook(() => useFilterPersistence(KEY));
    expect(result.current.savedFilters).toEqual({});
  });

  it("persists non-empty filters and removes the key for empty ones", () => {
    const { result } = renderHook(() => useFilterPersistence(KEY));
    result.current.persistFilters({ genre: "Drama", yearConditions: "gte:2020", yearLogic: "and" });
    expect(JSON.parse(sessionStorage.getItem(KEY)!)).toEqual({ genre: "Drama", yearConditions: "gte:2020", yearLogic: "and" });
    result.current.persistFilters({});
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("survives sessionStorage throwing on read and write", () => {
    vi.stubGlobal("sessionStorage", throwingStorage);
    const { result } = renderHook(() => useFilterPersistence(KEY));
    expect(result.current.savedFilters).toEqual({});
    expect(() => result.current.persistFilters({ genre: "Drama" })).not.toThrow();
    expect(() => result.current.persistFilters({})).not.toThrow();
  });
});
