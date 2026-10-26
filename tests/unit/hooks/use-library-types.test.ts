// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({
  handlers: new Map<string, Set<() => void>>(),
  preHandlers: new Map<string, () => void>(),
  live: false,
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    if (!realtime.handlers.has(type)) realtime.handlers.set(type, new Set());
    realtime.handlers.get(type)!.add(cb);
    return { connected: true, authExpired: false };
  },
  beforeRealtimeEvents: (types: string[], fn: () => void) => {
    for (const type of types) realtime.preHandlers.set(type, fn);
    return () => {};
  },
  isRealtimeLive: () => realtime.live,
}));

let useLibraryTypes: typeof import("@/hooks/use-library-types").useLibraryTypes;
let shellSettingsWrapper: typeof import("../../setup/shell-settings-wrapper").shellSettingsWrapper;

const fetchMock = vi.fn();
const typeCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/media/library-types").length;
const ok = (body: unknown) => ({ ok: true, json: async () => body });

/** One event as the stream delivers it: the pre-handler, then each subscriber. */
function emit(type: string) {
  realtime.preHandlers.get(type)?.();
  for (const cb of realtime.handlers.get(type) ?? []) cb();
}

beforeEach(async () => {
  vi.resetModules();
  realtime.handlers.clear();
  realtime.preHandlers.clear();
  realtime.live = false;
  fetchMock.mockReset().mockResolvedValue(ok({ types: ["MOVIE", "SERIES"], allTypes: ["MOVIE", "SERIES", "MUSIC"] }));
  vi.stubGlobal("fetch", fetchMock);
  ({ useLibraryTypes } = await import("@/hooks/use-library-types"));
  ({ shellSettingsWrapper } = await import("../../setup/shell-settings-wrapper"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLibraryTypes", () => {
  it("answers from the layout's read on the first render, with no request", async () => {
    const { result } = renderHook(() => useLibraryTypes(), { wrapper: shellSettingsWrapper() });
    expect(result.current).toEqual({ types: ["MOVIE"], allTypes: ["MOVIE"] });
    await act(async () => {});
    expect(typeCalls()).toBe(0);
  });

  it("fetches outside the shell, null until the answer", async () => {
    const { result } = renderHook(() => useLibraryTypes());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual({ types: ["MOVIE", "SERIES"], allTypes: ["MOVIE", "SERIES", "MUSIC"] }));
    expect(typeCalls()).toBe(1);
  });

  it("re-reads on server:changed and sync:completed, once for every reader of the event", async () => {
    const wrapper = shellSettingsWrapper();
    const sidebar = renderHook(() => useLibraryTypes(), { wrapper });
    const page = renderHook(() => useLibraryTypes(), { wrapper });
    await act(async () => emit("server:changed"));
    await waitFor(() => expect(page.result.current?.types).toEqual(["MOVIE", "SERIES"]));
    expect(sidebar.result.current).toEqual(page.result.current);
    // The readers' callbacks are one function, and run in one turn here.
    expect(typeCalls()).toBe(1);
    await act(async () => emit("sync:completed"));
    expect(typeCalls()).toBe(2);
  });

  it("never serves the layout's stale copy after a client-side navigation", async () => {
    realtime.live = true;
    const wrapper = shellSettingsWrapper();
    const sidebar = renderHook(() => useLibraryTypes(), { wrapper });
    // A server added while the dashboard was not mounted: the sidebar re-read.
    fetchMock.mockResolvedValue(ok({ types: ["MOVIE", "MUSIC"], allTypes: ["MOVIE", "MUSIC"] }));
    await act(async () => emit("server:changed"));
    await waitFor(() => expect(sidebar.result.current?.types).toEqual(["MOVIE", "MUSIC"]));
    // The next page mounts under the same, unchanged layout snapshot.
    const page = renderHook(() => useLibraryTypes(), { wrapper });
    expect(page.result.current?.types).toEqual(["MOVIE", "MUSIC"]);
    await act(async () => {});
    expect(typeCalls()).toBe(1);
  });

  it("re-reads on mount after an event no reader heard", async () => {
    realtime.live = true;
    const wrapper = shellSettingsWrapper();
    renderHook(() => useLibraryTypes(), { wrapper }).unmount();
    realtime.preHandlers.get("sync:completed")!();
    const page = renderHook(() => useLibraryTypes(), { wrapper });
    await waitFor(() => expect(page.result.current?.types).toEqual(["MOVIE", "SERIES"]));
    expect(typeCalls()).toBe(1);
  });

  it("keeps the held types when a read fails or brings a body it cannot read", async () => {
    const { result } = renderHook(() => useLibraryTypes(), { wrapper: shellSettingsWrapper() });
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await act(async () => emit("server:changed"));
    fetchMock.mockResolvedValueOnce(ok({ error: "nope" }));
    await act(async () => emit("server:changed"));
    expect(typeCalls()).toBe(2);
    expect(result.current).toEqual({ types: ["MOVIE"], allTypes: ["MOVIE"] });
  });
});
