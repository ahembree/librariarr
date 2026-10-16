// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    realtime.handlers.set(type, cb);
    return { connected: true, authExpired: false };
  },
}));

import { useServers } from "@/hooks/use-servers";

const fetchMock = vi.fn();

beforeEach(() => {
  realtime.handlers.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useServers", () => {
  it("loads servers, defaulting enabled to true, with 'all' selected", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [
          { id: "1", name: "Plex", type: "PLEX", url: "http://x", accessToken: "secret" },
          { id: "2", name: "Jelly", type: "JELLYFIN", enabled: false },
        ],
      }),
    });
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
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [{ id: "1", name: "A", type: "PLEX" }] }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [] }) });
    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    act(() => realtime.handlers.get("server:changed")!());
    await waitFor(() => expect(result.current.servers).toHaveLength(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the current list on a failed or non-OK response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [{ id: "1", name: "A", type: "PLEX" }] }) });
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    await act(async () => realtime.handlers.get("server:changed")!());
    await act(async () => realtime.handlers.get("server:changed")!());
    expect(result.current.servers).toHaveLength(1);
  });

  it("treats a body with no servers key as an empty list", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    const { result } = renderHook(() => useServers());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.servers).toEqual([]);
  });

  it("lets the caller change the selection", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useServers());
    act(() => result.current.setSelectedServerId("2"));
    expect(result.current.selectedServerId).toBe("2");
  });
});
