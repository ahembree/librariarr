// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  preHandlers: new Map<string, () => void>(),
  live: false,
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    realtime.handlers.set(type, cb);
    return { connected: true, authExpired: false };
  },
  beforeRealtimeEvents: (types: string[], fn: () => void) => {
    for (const type of types) realtime.preHandlers.set(type, fn);
    return () => {};
  },
  isRealtimeLive: () => realtime.live,
}));

let useServers: typeof import("@/hooks/use-servers").useServers;

const fetchMock = vi.fn();
const serverCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/servers").length;

/** An event as the stream delivers it: the pre-handler, then the subscriber. */
function emit(type: string) {
  realtime.preHandlers.get(type)?.();
  return realtime.handlers.get(type)?.();
}

beforeEach(async () => {
  vi.resetModules();
  realtime.handlers.clear();
  realtime.preHandlers.clear();
  realtime.live = false;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // A fresh store per test: it lives for the tab.
  ({ useServers } = await import("@/hooks/use-servers"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ok = (body: unknown) => ({ ok: true, json: async () => body });

describe("useServers", () => {
  it("loads servers, defaulting enabled to true, with 'all' selected", async () => {
    fetchMock.mockResolvedValue(
      ok({
        servers: [
          // The route masks credentials; the hook keeps only what pickers need.
          { id: "1", name: "Plex", type: "PLEX", url: "http://192.168.1.10:32400", accessToken: "••••••••" },
          { id: "2", name: "Jelly", type: "JELLYFIN", enabled: false },
        ],
      }),
    );
    const { result } = renderHook(() => useServers());
    expect(result.current.selectedServerId).toBe("all");
    await waitFor(() => expect(result.current.servers).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/servers");
    expect(result.current.servers).toEqual([
      { id: "1", name: "Plex", type: "PLEX", enabled: true },
      { id: "2", name: "Jelly", type: "JELLYFIN", enabled: false },
    ]);
  });

  it("refetches on server:changed", async () => {
    fetchMock.mockResolvedValueOnce(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    fetchMock.mockResolvedValueOnce(ok({ servers: [] }));
    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    await act(async () => emit("server:changed"));
    await waitFor(() => expect(result.current.servers).toHaveLength(0));
    expect(serverCalls()).toBe(2);
  });

  it("keeps the current list on a failed or non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    await act(async () => emit("server:changed"));
    await act(async () => emit("server:changed"));
    expect(serverCalls()).toBe(3);
    expect(result.current.servers).toEqual([{ id: "1", name: "A", type: "PLEX", enabled: true }]);
  });

  it("treats a body with no servers key as an empty list", async () => {
    fetchMock.mockResolvedValueOnce(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    fetchMock.mockResolvedValueOnce(ok({}));
    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    await act(async () => emit("server:changed"));
    expect(serverCalls()).toBe(2);
    expect(result.current.servers).toEqual([]);
  });

  it("lets each caller change its own selection", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const a = renderHook(() => useServers());
    const b = renderHook(() => useServers());
    act(() => a.result.current.setSelectedServerId("2"));
    expect(a.result.current.selectedServerId).toBe("2");
    expect(b.result.current.selectedServerId).toBe("all");
  });

  it("shares one request between the pickers mounting together", async () => {
    fetchMock.mockResolvedValue(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    const a = renderHook(() => useServers());
    const b = renderHook(() => useServers());
    await waitFor(() => expect(b.result.current.servers).toHaveLength(1));
    expect(a.result.current.servers).toEqual(b.result.current.servers);
    expect(serverCalls()).toBe(1);
  });

  it("does not refetch on a later navigation while the stream is delivering", async () => {
    fetchMock.mockResolvedValue(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    realtime.live = true;
    const page = renderHook(() => useServers());
    await waitFor(() => expect(page.result.current.servers).toHaveLength(1));
    page.unmount();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000);
    const next = renderHook(() => useServers());
    // The held list paints at once, with no request.
    expect(next.result.current.servers).toHaveLength(1);
    await act(async () => {});
    expect(serverCalls()).toBe(1);
  });

  it("refetches on the next mount after a server:changed nobody was mounted to hear", async () => {
    fetchMock.mockResolvedValueOnce(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    fetchMock.mockResolvedValueOnce(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }, { id: "2", name: "B", type: "EMBY" }] }));
    realtime.live = true;
    const page = renderHook(() => useServers());
    await waitFor(() => expect(page.result.current.servers).toHaveLength(1));
    page.unmount();
    // Only the pre-handler hears it: no picker is mounted.
    realtime.preHandlers.get("server:changed")!();
    const next = renderHook(() => useServers());
    await waitFor(() => expect(next.result.current.servers).toHaveLength(2));
    expect(serverCalls()).toBe(2);
  });

  it("refetches on mount when the stream is not delivering and the list is not recent", async () => {
    fetchMock.mockResolvedValue(ok({ servers: [{ id: "1", name: "A", type: "PLEX" }] }));
    const page = renderHook(() => useServers());
    await waitFor(() => expect(page.result.current.servers).toHaveLength(1));
    page.unmount();
    // Within the trust window (pickers mounting in one page load): no request.
    renderHook(() => useServers()).unmount();
    await act(async () => {});
    expect(serverCalls()).toBe(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_001);
    renderHook(() => useServers());
    await act(async () => {});
    expect(serverCalls()).toBe(2);
  });

  it("never lets an older answer replace a newer one", async () => {
    const answers: ((body: unknown) => void)[] = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => answers.push((body) => resolve(ok(body)))),
    );
    const { result } = renderHook(() => useServers());
    await act(async () => {});
    // A second read, issued after an event, answers first.
    await act(async () => {
      void emit("server:changed");
    });
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]({ servers: [{ id: "new", name: "New", type: "PLEX" }] }));
    await act(async () => answers[0]({ servers: [{ id: "old", name: "Old", type: "PLEX" }] }));
    expect(result.current.servers.map((s) => s.id)).toEqual(["new"]);
  });
});
