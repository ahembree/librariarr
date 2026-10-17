// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { useScrollToTop } from "@/hooks/use-scroll-to-top";

let main: HTMLElement;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  main = document.createElement("main");
  scrollTo = vi.fn();
  main.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  document.body.append(main);
  nav.pathname = "/library/movies";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useScrollToTop", () => {
  it("does not scroll on the first render", () => {
    renderHook(() => useScrollToTop());
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls <main> to the top on a route change, once per change", () => {
    const { rerender } = renderHook(() => useScrollToTop());
    nav.pathname = "/library/series";
    rerender();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    rerender();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("scrolls the nested overflow container when the page has one", () => {
    const wrapper = document.createElement("div");
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    const innerScroll = vi.fn();
    inner.scrollTo = innerScroll as unknown as HTMLElement["scrollTo"];
    wrapper.append(inner);
    main.append(wrapper);
    const { rerender } = renderHook(() => useScrollToTop());
    nav.pathname = "/lifecycle/rules";
    rerender();
    expect(innerScroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves positioning to scroll restoration when the page asked to be preserved", () => {
    const { rerender } = renderHook(() => useScrollToTop());
    sessionStorage.setItem("scroll-/library/series-preserve", "true");
    nav.pathname = "/library/series";
    rerender();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("still scrolls when sessionStorage throws", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => {
      throw new Error("SecurityError");
    } });
    const { rerender } = renderHook(() => useScrollToTop());
    nav.pathname = "/settings";
    rerender();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a <main>", () => {
    main.remove();
    const { rerender } = renderHook(() => useScrollToTop());
    nav.pathname = "/settings";
    expect(() => rerender()).not.toThrow();
  });
});
