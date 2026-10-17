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
    const { result } = renderHook(() => useQueryColumnValues(rows, ["audioStreamCount"], null));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isPending("audioStreamCount")).toBe(false);
    expect(result.current.values).toEqual({});
  });

  it("posts the rows, visible fields and scope, and is pending until answered", async () => {
    // A grouped show row reads null for a stream count (it would total every episode's tracks).
    fetchMock.mockResolvedValue(
      respond({ a: { audioStreamCount: 3 }, b: { audioStreamCount: null } }, [
        "Arr columns are empty: Request failed with status code 503",
      ]),
    );
    const rows = [{ id: "a" }, { id: "b", matchedEpisodes: 4 }];
    const { result } = renderHook(() => useQueryColumnValues(rows, ["audioStreamCount"], SCOPE));
    expect(result.current.isPending("audioStreamCount")).toBe(true);
    await waitFor(() => expect(result.current.isPending("audioStreamCount")).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/query/column-values");
    expect(JSON.parse(init.body)).toEqual({
      items: [{ id: "a", grouped: false }, { id: "b", grouped: true }],
      fields: ["audioStreamCount"],
      serverIds: ["s1"],
      arrServerIds: { radarr: "r1" },
    });
    expect(result.current.values).toEqual({ a: { audioStreamCount: 3 }, b: { audioStreamCount: null } });
    expect(result.current.warnings).toEqual(["Arr columns are empty: Request failed with status code 503"]);
  });

  it("fetches only a newly shown column for the same result set", async () => {
    fetchMock.mockResolvedValueOnce(respond({ a: { audioStreamCount: 1 } }));
    fetchMock.mockResolvedValueOnce(respond({ a: { arrMonitored: true } }));
    const rows = [{ id: "a" }];
    const { result, rerender } = renderHook(({ fields }) => useQueryColumnValues(rows, fields, SCOPE), {
      initialProps: { fields: ["audioStreamCount"] },
    });
    await waitFor(() => expect(result.current.isPending("audioStreamCount")).toBe(false));
    rerender({ fields: ["audioStreamCount", "arrMonitored"] });
    await waitFor(() => expect(result.current.isPending("arrMonitored")).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fields).toEqual(["arrMonitored"]);
    expect(result.current.values).toEqual({ a: { audioStreamCount: 1, arrMonitored: true } });
  });

  it("drops an answer for a result set that is no longer current", async () => {
    let resolveOld!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
    fetchMock.mockResolvedValueOnce(respond({ b: { audioStreamCount: 7 } }));
    const oldRows = [{ id: "a" }];
    const newRows = [{ id: "b" }];
    const { result, rerender } = renderHook(({ rows }) => useQueryColumnValues(rows, ["audioStreamCount"], SCOPE), {
      initialProps: { rows: oldRows },
    });
    rerender({ rows: newRows });
    await waitFor(() => expect(result.current.isPending("audioStreamCount")).toBe(false));
    await act(async () => {
      resolveOld(respond({ a: { audioStreamCount: 99 } }));
    });
    expect(result.current.values).toEqual({ b: { audioStreamCount: 7 } });
  });

  it("marks a failed column loaded with the server's message as a warning", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Failed to load column values", detail: "Query read timeout" }),
    });
    // Results are keyed by identity, so the row array must be stable across renders.
    const rows = [{ id: "a" }];
    const { result } = renderHook(() => useQueryColumnValues(rows, ["audioStreamCount"], SCOPE));
    await waitFor(() => expect(result.current.isPending("audioStreamCount")).toBe(false));
    expect(result.current.warnings).toEqual(["Query read timeout"]);
    expect(result.current.values).toEqual({});
  });

  it("is never pending for an empty result set and sends nothing", () => {
    const { result } = renderHook(() => useQueryColumnValues([], ["audioStreamCount"], SCOPE));
    expect(result.current.isPending("audioStreamCount")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no request when no column is visible", () => {
    const rows = [{ id: "a" }];
    renderHook(() => useQueryColumnValues(rows, [], SCOPE));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
