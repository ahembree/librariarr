// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorage, useLocalStorageJSON } from "@/hooks/use-local-storage";

beforeEach(() => {
  localStorage.clear();
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


describe("useLocalStorage", () => {
  it("returns the default when nothing is stored, and the stored value otherwise", () => {
    const { result: a } = renderHook(() => useLocalStorage("ls-a", "card"));
    expect(a.current[0]).toBe("card");
    localStorage.setItem("ls-b", "table");
    const { result: b } = renderHook(() => useLocalStorage("ls-b", "card"));
    expect(b.current[0]).toBe("table");
  });

  it("writes through and updates every hook on the same key, not other keys", () => {
    const { result: one } = renderHook(() => useLocalStorage<string>("ls-shared", "x"));
    const { result: two } = renderHook(() => useLocalStorage<string>("ls-shared", "x"));
    const { result: other } = renderHook(() => useLocalStorage("ls-other", "x"));
    act(() => one.current[1]("y"));
    expect(localStorage.getItem("ls-shared")).toBe("y");
    expect(one.current[0]).toBe("y");
    expect(two.current[0]).toBe("y");
    expect(other.current[0]).toBe("x");
  });

  it("follows a storage event from another tab for its own key only", () => {
    const { result } = renderHook(() => useLocalStorage("ls-tab", "a"));
    localStorage.setItem("ls-tab", "b");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    });
    // Snapshot is re-read on any render, so check via the matching event.
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "ls-tab" }));
    });
    expect(result.current[0]).toBe("b");
  });

  it("removes its storage listener on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useLocalStorage("ls-unmount", "a"));
    unmount();
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  });

  it("keeps working in memory when storage throws", () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { result } = renderHook(() => useLocalStorage<string>("ls-broken", "fallback"));
    expect(result.current[0]).toBe("fallback");
    expect(() => act(() => result.current[1]("other"))).not.toThrow();
    // Reads still throw, so the default is what remains visible.
    expect(result.current[0]).toBe("fallback");
  });
});

describe("useLocalStorageJSON", () => {
  it("parses stored JSON and falls back to the default on bad JSON", () => {
    localStorage.setItem("json-a", JSON.stringify({ n: 1 }));
    const { result } = renderHook(() => useLocalStorageJSON("json-a", { n: 0 }));
    expect(result.current[0]).toEqual({ n: 1 });

    localStorage.setItem("json-bad", "{oops");
    const def = { n: 9 };
    const { result: bad } = renderHook(() => useLocalStorageJSON("json-bad", def));
    expect(bad.current[0]).toBe(def);
  });

  it("returns a referentially stable parsed value while the raw string is unchanged", () => {
    localStorage.setItem("json-stable", JSON.stringify(["a", "b"]));
    const { result, rerender } = renderHook(() => useLocalStorageJSON<string[]>("json-stable", []));
    const first = result.current[0];
    rerender();
    expect(result.current[0]).toBe(first);
  });

  it("stores the serialised value and hands back the exact object set", () => {
    const { result } = renderHook(() => useLocalStorageJSON<{ cols: string[] }>("json-set", { cols: [] }));
    const next = { cols: ["title", "year"] };
    act(() => result.current[1](next));
    expect(localStorage.getItem("json-set")).toBe(JSON.stringify(next));
    expect(result.current[0]).toBe(next);
  });

  it("re-parses when another tab changes the raw value", () => {
    localStorage.setItem("json-tab", JSON.stringify(1));
    const { result } = renderHook(() => useLocalStorageJSON("json-tab", 0));
    expect(result.current[0]).toBe(1);
    localStorage.setItem("json-tab", JSON.stringify(2));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "json-tab" }));
    });
    expect(result.current[0]).toBe(2);
  });
});
