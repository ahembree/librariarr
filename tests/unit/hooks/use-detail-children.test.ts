// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDetailChildren } from "@/hooks/use-detail-children";
import { detailChildrenUrl, detailPrefetch, prefetchMediaDetail } from "@/lib/media/detail-prefetch";

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const pickSeasons = (body: Record<string, unknown>) => body.seasons as { n: number }[] | undefined;
const seasonsUrl = (id: string) => detailChildrenUrl("seasons", id);
const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).length;

beforeEach(() => {
  detailPrefetch.clear();
  fetchMock.mockReset().mockImplementation((url: string) => Promise.resolve(ok({ seasons: [{ n: url.length }] })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDetailChildren", () => {
  it("reads the list by the page's id, and is not loaded until it answers", async () => {
    const { result } = renderHook(() => useDetailChildren("s1", "seasons", 0, pickSeasons));
    expect(result.current).toEqual({ items: [], loaded: false });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.items).toHaveLength(1);
    expect(calls(seasonsUrl("s1"))).toBe(1);
  });

  it("takes the list the record's prefetch started instead of asking again", async () => {
    prefetchMediaDetail("s1", { mediaType: "SERIES", plays: false, integrations: false, children: "seasons" });
    const { result } = renderHook(() => useDetailChildren("s1", "seasons", 0, pickSeasons));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(calls(seasonsUrl("s1"))).toBe(1);
  });

  it("re-reads on every tick", async () => {
    const { result, rerender } = renderHook(({ tick }) => useDetailChildren("s1", "seasons", tick, pickSeasons), {
      initialProps: { tick: 0 },
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    rerender({ tick: 1 });
    await waitFor(() => expect(calls(seasonsUrl("s1"))).toBe(2));
  });

  it("shows none for an answer without the list (a 404), but keeps the list across a failed request", async () => {
    const { result, rerender } = renderHook(({ tick }) => useDetailChildren("s1", "seasons", tick, pickSeasons), {
      initialProps: { tick: 0 },
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    rerender({ tick: 1 });
    await act(async () => {});
    expect(result.current.items).toHaveLength(1);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "Not found" }) });
    rerender({ tick: 2 });
    await waitFor(() => expect(result.current.items).toHaveLength(0));
    expect(result.current.loaded).toBe(true);
  });

  it("never shows an earlier id's list for a later one", async () => {
    const answers = new Map<string, () => void>();
    fetchMock.mockImplementation(
      (url: string) => new Promise((resolve) => answers.set(url, () => resolve(ok({ seasons: [{ n: url.length }] })))),
    );
    const { result, rerender } = renderHook(({ id }) => useDetailChildren(id, "seasons", 0, pickSeasons), {
      initialProps: { id: "a" },
    });
    rerender({ id: "bb" });
    expect(result.current.loaded).toBe(false);
    await act(async () => answers.get(seasonsUrl("bb"))!());
    await act(async () => answers.get(seasonsUrl("a"))!());
    expect(result.current.items).toEqual([{ n: seasonsUrl("bb").length }]);
  });
});
