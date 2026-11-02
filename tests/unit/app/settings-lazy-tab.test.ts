// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement, useEffect, type ComponentType } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { lazySettingsTab } from "@/app/(authenticated)/settings/lazy-tab";

afterEach(cleanup);

/** A tab whose code answers only when `resolve` is called, counting its mounts. */
function deferredTab() {
  const mounts = { count: 0 };
  function Tab({ label }: { label: string }) {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return createElement("p", null, `tab: ${label}`);
  }
  let resolve!: () => void;
  const code = new Promise<ComponentType<{ label: string }>>((r) => {
    resolve = () => r(Tab);
  });
  return { tab: lazySettingsTab(() => code), resolve, mounts };
}

describe("lazySettingsTab", () => {
  it("renders a tab whose code is in on its first render", async () => {
    const { tab, resolve } = deferredTab();
    const loading = tab.load();
    resolve();
    await loading;
    // No awaiting after render: the tab is there at once, with no fallback frame.
    render(createElement(tab.View, { label: "General" }));
    expect(screen.getByText("tab: General")).toBeTruthy();
  });

  it("shows the skeleton until code that was not loaded yet arrives", async () => {
    const { tab, resolve } = deferredTab();
    const { container } = render(createElement(tab.View, { label: "AI" }));
    expect(screen.queryByText("tab: AI")).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"], .animate-pulse')).toBeTruthy();
    await act(async () => resolve());
    expect(await screen.findByText("tab: AI")).toBeTruthy();
  });

  it("keeps the mounted tab once its code arrives, never remounting it", async () => {
    const { tab, resolve, mounts } = deferredTab();
    const { rerender } = render(createElement(tab.View, { label: "one" }));
    await act(async () => resolve());
    await screen.findByText("tab: one");
    // A re-render after the code is in must not swap to the loaded component,
    // which would remount the tab and drop what its forms hold.
    rerender(createElement(tab.View, { label: "two" }));
    expect(screen.getByText("tab: two")).toBeTruthy();
    expect(mounts.count).toBe(1);
  });

  it("loads the code once however often it is asked for", async () => {
    let calls = 0;
    const tab = lazySettingsTab(async () => {
      calls += 1;
      return () => null;
    });
    await Promise.all([tab.load(), tab.load()]);
    await tab.load();
    expect(calls).toBe(1);
  });
});
