// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useQueryColumnValues, type ColumnValueScope } from "@/hooks/use-query-column-values";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(values: Record<string, Record<string, unknown>>, warnings: string[] = []) {
  return { ok: true, json: async () => ({ values, warnings }) };
}

const SCOPE: ColumnValueScope = { serverIds: ["s1"], arrServerIds: { radarr: "r1" } };

describe("useQueryColumnValues", () => {
  it("loads nothing while there is no scope", () => {
    const rows = [{ id: "a" }];
    const { result } = renderHook(() => useQueryColumnValues(rows, ["playCount"], null));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isPending("playCount")).toBe(false);
    expect(result.current.values).toEqual({});
  });

  it("posts the rows, visible fields and scope, and is pending until answered", async () => {
    fetchMock.mockResolvedValue(respond({ a: { playCount: 3 }, b: { playCount: 0 } }, ["Radarr unreachable"]));
    const rows = [{ id: "a" }, { id: "b", matchedEpisodes: 4 }];
    const { result } = renderHook(() => useQueryColumnValues(rows, ["playCount"], SCOPE));
    expect(result.current.isPending("playCount")).toBe(true);
    await waitFor(() => expect(result.current.isPending("playCount")).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/query/column-values");
    expect(JSON.parse(init.body)).toEqual({
      items: [{ id: "a", grouped: false }, { id: "b", grouped: true }],
      fields: ["playCount"],
      serverIds: ["s1"],
      arrServerIds: { radarr: "r1" },
    });
    expect(result.current.values).toEqual({ a: { playCount: 3 }, b: { playCount: 0 } });
    expect(result.current.warnings).toEqual(["Radarr unreachable"]);
  });

  it("fetches only a newly shown column for the same result set", async () => {
    fetchMock.mockResolvedValueOnce(respond({ a: { playCount: 1 } }));
    fetchMock.mockResolvedValueOnce(respond({ a: { year: 1999 } }));
    const rows = [{ id: "a" }];
    const { result, rerender } = renderHook(({ fields }) => useQueryColumnValues(rows, fields, SCOPE), {
      initialProps: { fields: ["playCount"] },
    });
    await waitFor(() => expect(result.current.isPending("playCount")).toBe(false));
    rerender({ fields: ["playCount", "year"] });
    await waitFor(() => expect(result.current.isPending("year")).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).toEqual(["year"]);
    expect(result.current.values).toEqual({ a: { playCount: 1, year: 1999 } });
  });

  it("drops an answer for a result set that is no longer current", async () => {
    let resolveOld!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
    fetchMock.mockResolvedValueOnce(respond({ b: { playCount: 7 } }));
    const oldRows = [{ id: "a" }];
    const newRows = [{ id: "b" }];
    const { result, rerender } = renderHook(({ rows }) => useQueryColumnValues(rows, ["playCount"], SCOPE), {
      initialProps: { rows: oldRows },
    });
    rerender({ rows: newRows });
    await waitFor(() => expect(result.current.isPending("playCount")).toBe(false));
    await act(async () => {
      resolveOld(respond({ a: { playCount: 99 } }));
    });
    expect(result.current.values).toEqual({ b: { playCount: 7 } });
  });

  it("marks a failed column loaded with the server's message as a warning", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Too many items" }) });
    // Results are keyed by identity, so the row array must be stable across renders.
    const rows = [{ id: "a" }];
    const { result } = renderHook(() => useQueryColumnValues(rows, ["playCount"], SCOPE));
    await waitFor(() => expect(result.current.isPending("playCount")).toBe(false));
    expect(result.current.warnings).toEqual(["Too many items"]);
    expect(result.current.values).toEqual({});
  });

  it("is never pending for an empty result set and sends nothing", () => {
    const { result } = renderHook(() => useQueryColumnValues([], ["playCount"], SCOPE));
    expect(result.current.isPending("playCount")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no request when no column is visible", () => {
    const rows = [{ id: "a" }];
    renderHook(() => useQueryColumnValues(rows, [], SCOPE));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
