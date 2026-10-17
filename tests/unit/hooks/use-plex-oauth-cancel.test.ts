// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";

/**
 * Cancel must win wherever it lands. It used to be ignored while the PIN
 * request was in flight: the flow went on to send the popup to Plex and poll,
 * and a token arriving then signed the user in after they pressed Cancel.
 */
const INIT = { authUrl: "https://app.plex.tv/auth#?code=abc", pinId: 42, code: "abc", clientId: "cid", product: "Librariarr", version: "1.0" };

let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } };
const fetchMock = vi.fn();

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  popup = { closed: false, close: vi.fn(() => (popup.closed = true)), location: { href: "/login/plex/loading" } };
  vi.stubGlobal("open", vi.fn(() => popup));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The PIN polls: requests to plex.tv itself, compared by host (the app's own
// routes are relative and resolve to the placeholder base).
const pinCalls = () =>
  fetchMock.mock.calls.filter(([url]) => new URL(String(url), "http://app.invalid").host === "plex.tv");

describe("usePlexOAuth cancellation", () => {
  it("does not go on to Plex when cancelled while the PIN request is in flight", async () => {
    const init = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    fetchMock.mockImplementation((url: string) =>
      url === "/api/auth/plex/init" ? init.promise : Promise.resolve({ ok: true, json: async () => ({ authToken: "tok" }) }),
    );
    const onSuccess = vi.fn(async () => {});
    const { result } = renderHook(() => usePlexOAuth({ onSuccess }));

    let started!: Promise<void>;
    act(() => {
      started = result.current.startAuth();
    });
    act(() => result.current.cancel());
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      init.resolve({ ok: true, json: async () => INIT });
      await started;
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(pinCalls()).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(popup.location.href).toBe("/login/plex/loading");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.authUrl).toBeNull();
  });

  it("does not report an init failure for an attempt that was cancelled", async () => {
    const init = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    fetchMock.mockImplementation(() => init.promise);
    const onError = vi.fn();
    const { result } = renderHook(() => usePlexOAuth({ onSuccess: vi.fn(async () => {}), onError }));

    let started!: Promise<void>;
    act(() => {
      started = result.current.startAuth();
    });
    act(() => result.current.cancel());
    await act(async () => {
      init.resolve({ ok: false, json: async () => ({ error: "Failed to initialize Plex authentication" }) });
      await started;
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("ignores a token from a poll that was already in flight when cancelled", async () => {
    const pin = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    fetchMock.mockImplementation((url: string) =>
      url === "/api/auth/plex/init" ? Promise.resolve({ ok: true, json: async () => INIT }) : pin.promise,
    );
    const onSuccess = vi.fn(async () => {});
    const { result } = renderHook(() => usePlexOAuth({ onSuccess }));

    await act(async () => {
      await result.current.startAuth();
    });
    expect(pinCalls()).toHaveLength(1);
    act(() => result.current.cancel());
    await act(async () => {
      pin.resolve({ ok: true, json: async () => ({ authToken: "late" }) });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("a fresh start after a cancel still signs in", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: async () => (url === "/api/auth/plex/init" ? INIT : { authToken: "tok" }) }),
    );
    const onSuccess = vi.fn(async () => {});
    const { result } = renderHook(() => usePlexOAuth({ onSuccess }));
    act(() => result.current.cancel());
    await act(async () => {
      await result.current.startAuth();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSuccess).toHaveBeenCalledWith("tok");
  });
});
