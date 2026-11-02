// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { renderHook, act } from "@testing-library/react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { MobileGuessProvider } from "@/components/mobile-guess-provider";

/** The provider around `children`. Its props type requires `children`, which lint wants as the third argument. */
function guessing(guess: boolean, children: ReactNode) {
  const props = { guess } as Parameters<typeof MobileGuessProvider>[0];
  return createElement(MobileGuessProvider, props, children);
}

function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    };
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    queries,
    listeners,
    set(value: boolean) {
      matches = value;
      for (const l of [...listeners]) l();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsMobile", () => {
  it("reads the md breakpoint media query", () => {
    const mm = stubMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect(mm.queries).toContain("(max-width: 767px)");
  });

  it("updates when the media query changes and unsubscribes on unmount", () => {
    const mm = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    expect(mm.listeners.size).toBe(1);

    act(() => mm.set(true));
    expect(result.current).toBe(true);
    act(() => mm.set(false));
    expect(result.current).toBe(false);

    unmount();
    expect(mm.listeners.size).toBe(0);
  });

  it("renders the server's guess on the server, and false outside the shell", () => {
    function Probe() {
      return createElement("span", null, String(useIsMobile()));
    }
    expect(renderToString(guessing(true, createElement(Probe)))).toContain("true");
    expect(renderToString(createElement(Probe))).toContain("false");
  });

  it("a client mount reads the screen, whatever the guess", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useIsMobile(), {
      wrapper: ({ children }) => guessing(true, children),
    });
    expect(result.current).toBe(false);
  });
});

