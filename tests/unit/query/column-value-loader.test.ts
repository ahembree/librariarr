import { describe, it, expect, vi } from "vitest";
import { ColumnValueLoader, type ColumnChunkFetcher } from "@/lib/query/column-value-loader";

const scope = { serverIds: [] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ColumnValueLoader", () => {
  it("drops a slow answer for an older result set instead of replacing the newer one", async () => {
    const pending: Array<ReturnType<typeof deferred<Awaited<ReturnType<ColumnChunkFetcher>>>>> = [];
    const fetcher = vi.fn<ColumnChunkFetcher>(() => {
      const d = deferred<Awaited<ReturnType<ColumnChunkFetcher>>>();
      pending.push(d);
      return d.promise;
    });
    const loader = new ColumnValueLoader(fetcher);
    const oldRows = [{ id: "old" }];
    const newRows = [{ id: "new" }];

    loader.load(oldRows, ["studio"], scope);
    loader.load(newRows, ["studio"], scope);
    // The newer run answers first, the older one last.
    pending[1].resolve({ values: { new: { studio: "B" } }, warnings: [] });
    await flush();
    pending[0].resolve({ values: { old: { studio: "A" } }, warnings: [] });
    await flush();

    expect(loader.get(newRows).values).toEqual({ new: { studio: "B" } });
    expect(loader.get(newRows).loaded.has("studio")).toBe(true);
    // Nothing left to fetch: the column is not stuck waiting.
    loader.load(newRows, ["studio"], scope);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fetches each column once per result set, and again for a new one", async () => {
    const fetcher = vi.fn<ColumnChunkFetcher>(async (items, fields) => ({
      values: Object.fromEntries(items.map((i) => [i.id, Object.fromEntries(fields.map((f) => [f, i.id]))])),
      warnings: [],
    }));
    const loader = new ColumnValueLoader(fetcher);
    const rows = [{ id: "a" }, { id: "b", matchedEpisodes: 3 }];

    loader.load(rows, ["studio"], scope);
    loader.load(rows, ["studio"], scope); // still in flight
    await flush();
    loader.load(rows, ["studio", "genre"], scope);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toEqual([{ id: "a", grouped: false }, { id: "b", grouped: true }]);
    expect(fetcher.mock.calls[1][1]).toEqual(["genre"]);
    expect(loader.get(rows).values).toEqual({ a: { studio: "a", genre: "a" }, b: { studio: "b", genre: "b" } });

    const rerun = [...rows];
    expect(loader.get(rerun).loaded.size).toBe(0);
    loader.load(rerun, ["studio"], scope);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("splits a large result set into requests the route accepts", async () => {
    const fetcher = vi.fn<ColumnChunkFetcher>(async (items) => ({
      values: Object.fromEntries(items.map((i) => [i.id, { studio: i.id }])),
      warnings: ["note"],
    }));
    const loader = new ColumnValueLoader(fetcher, 2);
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }];

    loader.load(rows, ["studio"], scope);
    await flush();

    expect(fetcher.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
    expect(Object.keys(loader.get(rows).values)).toEqual(["1", "2", "3", "4", "5"]);
    expect(loader.get(rows).warnings).toEqual(["note"]);
  });

  it("marks a failed column as answered, with the reason", async () => {
    const fetcher = vi.fn<ColumnChunkFetcher>(async () => { throw new Error("Validation failed"); });
    const loader = new ColumnValueLoader(fetcher);
    const rows = [{ id: "a" }];

    loader.load(rows, ["studio"], scope);
    await flush();

    expect(loader.get(rows).loaded.has("studio")).toBe(true);
    expect(loader.get(rows).warnings).toEqual(["Validation failed"]);
    loader.load(rows, ["studio"], scope);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers when values arrive", async () => {
    const loader = new ColumnValueLoader(async () => ({ values: {}, warnings: [] }));
    const listener = vi.fn();
    const unsubscribe = loader.subscribe(listener);
    const before = loader.getVersion();

    loader.load([{ id: "a" }], ["studio"], scope);
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(loader.getVersion()).toBe(before + 1);
    unsubscribe();
  });
});
