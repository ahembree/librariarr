// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, Fragment, useInsertionEffect, useSyncExternalStore } from "react";
import { render, renderHook, act } from "@testing-library/react";
import { readUrlHash, replaceUrlHash, subscribeToUrlHash } from "@/lib/url-hash";

function setHash(hash: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
}

const flushMicrotasks = () => act(async () => {});

afterEach(() => {
  setHash("");
  Reflect.deleteProperty(window, "navigation");
});

describe("readUrlHash", () => {
  it("is the hash with its #, or empty", () => {
    expect(readUrlHash()).toBe("");
    setHash("#servers");
    expect(readUrlHash()).toBe("#servers");
  });
});

describe("replaceUrlHash", () => {
  it("changes the hash without adding a history entry and keeps path and query", () => {
    window.history.replaceState(null, "", "/lifecycle/rules?ruleSet=r1#movies");
    const before = window.history.length;
    replaceUrlHash("#series");
    expect(window.location.pathname).toBe("/lifecycle/rules");
    expect(window.location.search).toBe("?ruleSet=r1");
    expect(window.location.hash).toBe("#series");
    expect(window.history.length).toBe(before);
  });

  it("writes a null history state, so the router records the URL as its own", () => {
    const replace = vi.spyOn(window.history, "replaceState");
    replaceUrlHash("#ai");
    expect(replace).toHaveBeenCalledWith(null, "", "#ai");
    replace.mockRestore();
  });

  it("writes nothing when the hash is already the one asked for", () => {
    setHash("#ai");
    const replace = vi.spyOn(window.history, "replaceState");
    replaceUrlHash("#ai");
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it("tells every subscriber at once, and none that has unsubscribed", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeToUrlHash(first);
    const stopSecond = subscribeToUrlHash(second);
    stopSecond();
    replaceUrlHash("#system");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    stopFirst();
  });
});

describe("subscribeToUrlHash", () => {
  it.each(["hashchange", "popstate"])("reports a %s event after the current task", async (type) => {
    const onChange = vi.fn();
    const stop = subscribeToUrlHash(onChange);
    window.dispatchEvent(new Event(type));
    // Never synchronously: the router writes the URL inside a React commit.
    expect(onChange).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reports a pushState through the Navigation API where the browser has it", async () => {
    const navigation = new EventTarget();
    Object.defineProperty(window, "navigation", { value: navigation, configurable: true });
    const onChange = vi.fn();
    const stop = subscribeToUrlHash(onChange);
    navigation.dispatchEvent(new Event("currententrychange"));
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    navigation.dispatchEvent(new Event("currententrychange"));
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops an event that was still queued when it unsubscribed", async () => {
    const onChange = vi.fn();
    const stop = subscribeToUrlHash(onChange);
    window.dispatchEvent(new Event("hashchange"));
    stop();
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops listening to the window once unsubscribed", async () => {
    const onChange = vi.fn();
    subscribeToUrlHash(onChange)();
    window.dispatchEvent(new Event("hashchange"));
    window.dispatchEvent(new Event("popstate"));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("as a useSyncExternalStore source", () => {
  const useUrlHash = () => useSyncExternalStore(subscribeToUrlHash, readUrlHash, () => "");

  it("picks up a hash the router writes after the page rendered", async () => {
    // A client-side navigation renders the incoming page first and writes the
    // URL from an insertion effect in the same commit (Next's HistoryUpdater):
    // the page's first render still sees the previous page's hash.
    const seen: string[] = [];
    function Page() {
      const hash = useUrlHash();
      seen.push(hash);
      return null;
    }
    function HistoryUpdater() {
      useInsertionEffect(() => {
        window.history.pushState(null, "", "/settings#authentication");
      }, []);
      return null;
    }
    render(createElement(Fragment, null, createElement(Page), createElement(HistoryUpdater)));
    await flushMicrotasks();
    expect(seen[0]).toBe("");
    expect(seen.at(-1)).toBe("#authentication");
  });

  it("follows the page's own tab changes and the browser's", async () => {
    setHash("#general");
    const { result } = renderHook(useUrlHash);
    expect(result.current).toBe("#general");

    act(() => replaceUrlHash("#servers"));
    expect(result.current).toBe("#servers");

    setHash("#integrations");
    window.dispatchEvent(new Event("popstate"));
    await flushMicrotasks();
    expect(result.current).toBe("#integrations");
  });
});
