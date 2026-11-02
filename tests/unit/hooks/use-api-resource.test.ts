// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ subscriptions: [] as { types: readonly string[]; cb: () => void }[] }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtimeEvents: (types: readonly string[], cb: () => void) => {
    realtime.subscriptions.push({ types, cb });
    return { connected: true, authExpired: false };
  },
}));

import { useApiResource } from "@/hooks/use-api-resource";

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** The latest subscription for `type` (each render re-subscribes in the mock). */
const fire = (type: string) => realtime.subscriptions.filter((s) => s.types.includes(type)).at(-1)!.cb();

beforeEach(() => {
  realtime.subscriptions = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useApiResource", () => {
  it("loads the URL, applying select, and reports loading until it answers", async () => {
    fetchMock.mockResolvedValue(ok({ items: [1, 2] }));
    const { result } = renderHook(() =>
      useApiResource<number[], { items: number[] }>("/api/x", { select: (b) => b.items }),
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual([1, 2]));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/x");
  });

  it("loads nothing for a null URL", async () => {
    const { result } = renderHook(() => useApiResource<unknown>(null));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, loading: false, error: null });
  });

  it("reports the route's error, keeping a value it already had", async () => {
    fetchMock.mockResolvedValueOnce(ok({ n: 1 }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "Down for a bit" }) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error("not json"); } });
    const { result } = renderHook(() => useApiResource<{ n: number }>("/api/x"));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    await act(() => result.current.refetch());
    expect(result.current.error).toBe("Down for a bit");
    expect(result.current.data).toEqual({ n: 1 });
    await act(() => result.current.refetch());
    expect(result.current.error).toBe("Request failed (500)");
  });

  it("says so when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useApiResource("/api/x"));
    await waitFor(() => expect(result.current.error).toBe("The request failed"));
    expect(result.current.loading).toBe(false);
  });

  it("never shows an older URL's answer for a newer URL", async () => {
    const answers = new Map<string, (body: unknown) => void>();
    fetchMock.mockImplementation((url: string) => new Promise((resolve) => answers.set(url, (b) => resolve(ok(b)))));
    const { result, rerender } = renderHook(({ url }) => useApiResource<{ id: string }>(url), {
      initialProps: { url: "/api/a" },
    });
    await act(async () => {});
    rerender({ url: "/api/b" });
    await act(async () => {});
    expect(result.current.loading).toBe(true);
    await act(async () => answers.get("/api/b")!({ id: "b" }));
    await act(async () => answers.get("/api/a")!({ id: "a" }));
    expect(result.current.data).toEqual({ id: "b" });
  });

  it("refetches on its realtime events, keeping the value meanwhile", async () => {
    fetchMock.mockResolvedValueOnce(ok({ n: 1 }));
    let release!: () => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { release = () => resolve(ok({ n: 2 })); }));
    const { result } = renderHook(() => useApiResource<{ n: number }>("/api/x", { realtime: ["sync:completed"] }));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => fire("sync:completed"));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual({ n: 1 });
    await act(async () => release());
    expect(result.current.data).toEqual({ n: 2 });
    expect(result.current.loading).toBe(false);
  });

  it("subscribes to nothing without realtime events", () => {
    fetchMock.mockResolvedValue(ok({}));
    renderHook(() => useApiResource("/api/x"));
    expect(realtime.subscriptions.at(-1)!.types).toEqual([]);
  });
});
