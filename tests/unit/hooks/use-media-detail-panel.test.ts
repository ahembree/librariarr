// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMediaDetailPanel, MEDIA_DETAIL_PANEL_WIDTH_KEY } from "@/hooks/use-media-detail-panel";
import type { MediaItemWithRelations } from "@/lib/types";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const fetchMock = vi.fn();

function record(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Title ${id}`, parentTitle: null, type: "MOVIE", playCount: 2, fileSize: "10", ...extra };
}

function respond(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  toastError.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaDetailPanel", () => {
  it("opens with the fetched record", async () => {
    fetchMock.mockResolvedValue(respond({ item: record("a") }));
    const { result } = renderHook(() => useMediaDetailPanel());
    expect(result.current.panelProps).toBeNull();
    await act(() => result.current.open({ id: "a", mediaType: "MOVIE" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/media/a");
    expect(result.current.panelProps?.item.title).toBe("Title a");
    expect(result.current.selectedId).toBe("a");
    expect(result.current.loading).toBe(false);
  });

  it("shows a seed at once, then the record with the group laid over it", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useMediaDetailPanel());
    const seed = {
      ...record("ep", { title: "The Show", type: "SERIES", matchedEpisodes: 3 }),
      servers: [{ serverId: "s1", serverName: "One", serverType: "PLEX" }],
    } as unknown as MediaItemWithRelations;
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.open({
        id: "ep",
        mediaType: "SERIES",
        seed,
        group: { title: "The Show", memberCount: 3, fileSize: "300", playCount: 9 },
      });
    });
    expect(result.current.panelProps?.item.title).toBe("The Show");
    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolve(respond({ item: record("ep", { title: "Pilot", parentTitle: "The Show", type: "SERIES" }) }));
      await pending;
    });
    const item = result.current.panelProps!.item;
    expect(item.title).toBe("The Show");
    expect(item.parentTitle).toBeNull();
    expect(item.matchedEpisodes).toBe(3);
    expect(item.fileSize).toBe("300");
    expect(item.playCount).toBe(9);
    // The group's servers, not the one copy's.
    expect(item.servers).toEqual(seed.servers);
  });

  it("never lets an earlier click's slower response replace a later one", async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    fetchMock.mockImplementation((url: string) => new Promise((r) => { resolvers[url] = r; }));
    const { result } = renderHook(() => useMediaDetailPanel());
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.open({ id: "a", mediaType: "MOVIE" }); });
    act(() => { second = result.current.open({ id: "b", mediaType: "MOVIE" }); });
    await act(async () => {
      resolvers["/api/media/b"](respond({ item: record("b") }));
      await second;
      resolvers["/api/media/a"](respond({ item: record("a") }));
      await first;
    });
    expect(result.current.selectedId).toBe("b");
  });

  it("close drops the selection and an answer still in flight", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useMediaDetailPanel());
    let pending!: Promise<void>;
    act(() => { pending = result.current.open({ id: "a", mediaType: "MOVIE" }); });
    act(() => result.current.close());
    await act(async () => {
      resolve(respond({ item: record("a") }));
      await pending;
    });
    expect(result.current.panelProps).toBeNull();
  });

  it("passes the context through and remembers one width for every page", async () => {
    localStorage.setItem(MEDIA_DETAIL_PANEL_WIDTH_KEY, "600");
    fetchMock.mockResolvedValue(respond({ item: record("a") }));
    const { result } = renderHook(() => useMediaDetailPanel());
    await act(() => result.current.open({
      id: "a",
      mediaType: "MOVIE",
      title: "Override",
      matchedCriteria: [{ ruleId: "r", field: "f", operator: "o", value: "v", negate: false }],
      actualValues: { r: "1" },
    }));
    await waitFor(() => expect(result.current.panelProps).not.toBeNull());
    const props = result.current.panelProps!;
    expect(props.width).toBe(600);
    expect(props.title).toBe("Override");
    expect(props.matchedCriteria).toHaveLength(1);
    expect(props.allActualValues).toEqual({ r: "1" });
  });

  it("keeps the previous panel when the record cannot be read", async () => {
    fetchMock.mockResolvedValueOnce(respond({ item: record("a") }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useMediaDetailPanel());
    await act(() => result.current.open({ id: "a", mediaType: "MOVIE" }));
    await act(() => result.current.open({ id: "b", mediaType: "MOVIE", label: "B" }));
    expect(result.current.selectedId).toBe("a");
    expect(result.current.loading).toBe(false);
    expect(toastError).toHaveBeenCalledWith("Couldn't load this item", { description: "B" });
  });

  it("says so when the item is gone, naming it", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const { result } = renderHook(() => useMediaDetailPanel());
    await act(() => result.current.open({ id: "a", mediaType: "MOVIE", label: "Alien" }));
    expect(result.current.panelProps).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe('"Alien" is no longer in the library');
  });

  it("closes a seed for an item that is gone, named as its row names it", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const { result } = renderHook(() => useMediaDetailPanel());
    const seed = record("ep", {
      title: "Pilot", parentTitle: "The Show", type: "SERIES", seasonNumber: 1, episodeNumber: 1,
    }) as unknown as MediaItemWithRelations;
    await act(() => result.current.open({ id: "ep", mediaType: "SERIES", seed }));
    expect(result.current.panelProps).toBeNull();
    expect(toastError.mock.calls[0][0]).toBe('"The Show S01E01" is no longer in the library');
  });

  it("keeps a seed on screen without a toast when only the refresh fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useMediaDetailPanel());
    const seed = record("a") as unknown as MediaItemWithRelations;
    await act(() => result.current.open({ id: "a", mediaType: "MOVIE", seed }));
    expect(result.current.selectedId).toBe("a");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says so when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useMediaDetailPanel());
    await act(() => result.current.open({ id: "a", mediaType: "MOVIE", label: "Alien" }));
    expect(toastError).toHaveBeenCalledWith("Couldn't load this item", { description: "Alien" });
    consoleError.mockRestore();
  });

  it("stays quiet about a click a later one replaced", async () => {
    let resolveFirst!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
    fetchMock.mockResolvedValueOnce(respond({ item: record("b") }));
    const { result } = renderHook(() => useMediaDetailPanel());
    let first!: Promise<void>;
    act(() => { first = result.current.open({ id: "a", mediaType: "MOVIE" }); });
    await act(() => result.current.open({ id: "b", mediaType: "MOVIE" }));
    await act(async () => {
      resolveFirst({ ok: false, status: 404, json: async () => ({}) });
      await first;
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.selectedId).toBe("b");
  });
});
