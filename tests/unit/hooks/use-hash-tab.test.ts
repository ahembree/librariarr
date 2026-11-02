// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { useHashTab, tabFromHash } from "@/hooks/use-hash-tab";
import { useHydrated } from "@/hooks/use-hydrated";

const TABS = ["general", "servers", "system"] as const;
type Tab = (typeof TABS)[number];

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
});

const flush = () => act(async () => {});

describe("tabFromHash", () => {
  it("names a valid tab, or none", () => {
    expect(tabFromHash("#servers", TABS)).toBe("servers");
    expect(tabFromHash("#nope", TABS)).toBeNull();
    expect(tabFromHash("", TABS)).toBeNull();
  });
});

describe("useHashTab", () => {
  it("reads the tab from the hash", () => {
    window.history.replaceState(null, "", "/settings#system");
    const { result } = renderHook(() => useHashTab<Tab>(TABS, "general"));
    expect(result.current[0]).toBe("system");
  });

  it("points a URL naming no tab at the fallback it shows", async () => {
    const { result } = renderHook(() => useHashTab<Tab>(TABS, "general"));
    await flush();
    expect(result.current[0]).toBe("general");
    expect(window.location.hash).toBe("#general");
    window.history.replaceState(null, "", "/settings#bogus");
    renderHook(() => useHashTab<Tab>(TABS, "general"));
    await flush();
    expect(window.location.hash).toBe("#general");
  });

  it("changes tab by replacing the hash, with no history entry", async () => {
    const before = window.history.length;
    const { result } = renderHook(() => useHashTab<Tab>(TABS, "general"));
    act(() => result.current[1]("servers"));
    await flush();
    expect(window.location.hash).toBe("#servers");
    expect(result.current[0]).toBe("servers");
    expect(window.history.length).toBe(before);
  });

  it("follows the hash when the browser changes it", async () => {
    const { result } = renderHook(() => useHashTab<Tab>(TABS, "general"));
    await flush();
    act(() => {
      window.history.replaceState(null, "", "/settings#system");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();
    expect(result.current[0]).toBe("system");
  });

  it("renders the fallback on the server, which cannot see the hash", () => {
    window.history.replaceState(null, "", "/settings#system");
    function Probe() {
      const [tab] = useHashTab<Tab>(TABS, "general");
      return createElement("span", null, tab);
    }
    expect(renderToString(createElement(Probe))).toContain("general");
  });
});

describe("useHydrated", () => {
  it("is false on the server render and true on the client", () => {
    function Probe() {
      return createElement("span", null, String(useHydrated()));
    }
    expect(renderToString(createElement(Probe))).toContain("false");
    expect(renderHook(() => useHydrated()).result.current).toBe(true);
  });
});
