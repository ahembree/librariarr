// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, renderHook } from "@testing-library/react";
import type { DashboardSeed, ServerClock } from "@/lib/dashboard/dashboard-seed-types";

const realtime = vi.hoisted(() => ({ resyncIfEventsSince: vi.fn() }));
vi.mock("@/hooks/use-realtime", () => ({ resyncIfEventsSince: realtime.resyncIfEventsSince }));

let mod: typeof import("@/components/dashboard/dashboard-seed");

const RENDERED_AT = Date.parse("2026-03-10T12:00:00Z");
const clock: ServerClock = { at: RENDERED_AT, hour: 12, weekday: "Tuesday", monthDay: "March 10" };

function seedOf(bodies: Record<string, unknown>): DashboardSeed {
  return { at: RENDERED_AT, bodies };
}

/** The provider around `children`. Its props type requires `children`, which lint wants as the third argument. */
function provider(seed: DashboardSeed | null, children: ReactNode) {
  const props = { seed, clock } as Parameters<typeof mod.DashboardSeedProvider>[0];
  return createElement(mod.DashboardSeedProvider, props, children);
}

function wrapperFor(seed: DashboardSeed | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return provider(seed, children);
  };
}

beforeEach(async () => {
  vi.resetModules();
  realtime.resyncIfEventsSince.mockReset();
  mod = await import("@/components/dashboard/dashboard-seed");
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useDashboardSeed", () => {
  it("hands the first mount the server's answer, and a later mount nothing", async () => {
    const seed = seedOf({ "/api/media/stats": { movieCount: 7 } });
    const first = renderHook(() => mod.useDashboardSeed("/api/media/stats"), { wrapper: wrapperFor(seed) });
    expect(first.result.current).toEqual({ movieCount: 7 });
    // A page restored from history mounts with the same seed: it fetches.
    const later = renderHook(() => mod.useDashboardSeed("/api/media/stats"), { wrapper: wrapperFor(seed) });
    expect(later.result.current).toBeUndefined();
  });

  it("answers undefined for a read the server did not answer, or with no seed", () => {
    const seed = seedOf({});
    expect(renderHook(() => mod.useDashboardSeed("/api/lifecycle/summary"), { wrapper: wrapperFor(seed) }).result.current).toBeUndefined();
    expect(renderHook(() => mod.useDashboardSeed("/api/media/stats"), { wrapper: wrapperFor(null) }).result.current).toBeUndefined();
  });

  it("asks once for a resync of events emitted since the server read the data", () => {
    const seed = seedOf({});
    const first = renderHook(() => null, { wrapper: wrapperFor(seed) });
    first.rerender();
    renderHook(() => null, { wrapper: wrapperFor(seed) });
    expect(realtime.resyncIfEventsSince).toHaveBeenCalledTimes(1);
    expect(realtime.resyncIfEventsSince).toHaveBeenCalledWith(RENDERED_AT);
  });

  it("asks for no resync without a seed (a client-side navigation)", () => {
    renderHook(() => null, { wrapper: wrapperFor(null) });
    expect(realtime.resyncIfEventsSince).not.toHaveBeenCalled();
  });
});

describe("the server's clock and number format", () => {
  it("are the server's while rendering on the server", () => {
    function Probe() {
      const now = mod.useRenderNow();
      const server = mod.useServerClock();
      const format = mod.useCountFormat();
      return createElement("span", null, `${now}|${server?.weekday}|${format(1234567)}`);
    }
    const html = renderToString(provider(null, createElement(Probe)));
    expect(html).toContain(`${RENDERED_AT}|Tuesday|1,234,567`);
  });

  it("are the browser's on a client mount", () => {
    const { result } = renderHook(
      () => [mod.useRenderNow(), mod.useServerClock()] as const,
      { wrapper: wrapperFor(null) },
    );
    expect(result.current).toEqual([undefined, null]);
  });

  it("hydrate what the server wrote, minutes and a time zone later, without a mismatch", async () => {
    const { formatRelativeDate } = await import("@/lib/format");
    // Written at 11:58:30 against a render at 12:00:00: "1m ago".
    const syncedAt = new Date(RENDERED_AT - 90_000).toISOString();
    function Tile() {
      const now = mod.useRenderNow();
      const server = mod.useServerClock();
      const hour = server?.hour ?? new Date().getHours();
      return createElement("p", null, `${hour < 12 ? "morning" : "afternoon"} · ${formatRelativeDate(syncedAt, { now })}`);
    }
    const tree = () => provider(seedOf({}), createElement(Tile));

    vi.useFakeTimers({ toFake: ["Date"], now: RENDERED_AT });
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree());
    document.body.appendChild(container);
    expect(container.textContent).toBe("afternoon · 1m ago");

    // The browser hydrates four minutes later, so "5m ago" by its own clock.
    vi.setSystemTime(RENDERED_AT + 4 * 60_000);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, tree(), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    // Then switches to its own clock.
    expect(container.textContent).toMatch(/· 5m ago$/);
  });
});
