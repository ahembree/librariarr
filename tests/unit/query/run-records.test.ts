import { describe, it, expect } from "vitest";
import { actedRecords, markRecordsActed } from "@/lib/query/run-records";

describe("query run records", () => {
  it("remembers what a run acted on, apart from other runs", () => {
    markRecordsActed("run-a", ["TMDB:1", "TMDB:2"], 1_000);
    expect([...actedRecords("run-a", 1_000)]).toEqual(["TMDB:1", "TMDB:2"]);
    expect(actedRecords("run-b", 1_000).size).toBe(0);
  });

  it("adds to a run across batches and expires it ten minutes after the last one", () => {
    markRecordsActed("run-c", ["TMDB:1"], 0);
    markRecordsActed("run-c", ["TMDB:3"], 5 * 60_000);
    expect(actedRecords("run-c", 14 * 60_000).has("TMDB:1")).toBe(true);
    expect(actedRecords("run-c", 16 * 60_000).size).toBe(0);
  });

  it("is one store per process, whichever module copy loads it", () => {
    // Pinned to globalThis, so the route bundle and any other copy share it.
    markRecordsActed("run-d", ["x"], 0);
    const store = (globalThis as unknown as { queryRunRecords?: Map<string, unknown> }).queryRunRecords;
    expect(store?.has("run-d")).toBe(true);
  });
});
