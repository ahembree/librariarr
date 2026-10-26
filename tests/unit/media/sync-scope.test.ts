import { describe, it, expect } from "vitest";
import { syncCompletedConcerns } from "@/lib/media/sync-scope";
import { syncCompletedMeta } from "@/lib/sync/sync-completed-meta";

// What the SSE route sends for the event: the timestamp beside the meta.
const event = (meta: object) => ({ timestamp: 1, ...meta });

describe("syncCompletedConcerns", () => {
  it("refetches when the event says nothing (an older server, a resync's {})", () => {
    expect(syncCompletedConcerns({}, { types: "MOVIE", serverId: "all" })).toBe(true);
    expect(syncCompletedConcerns(undefined, { types: "MOVIE" })).toBe(true);
    expect(syncCompletedConcerns(null, { types: "MOVIE" })).toBe(true);
    expect(syncCompletedConcerns("nonsense", { types: "MOVIE" })).toBe(true);
    // A run that could not say which types it touched leaves the field out.
    expect(syncCompletedConcerns(event(syncCompletedMeta("s1", [])), { types: "MOVIE" })).toBe(true);
  });

  it("skips a view whose type the run did not touch", () => {
    const seriesSync = event(syncCompletedMeta("s1", ["SERIES"]));
    expect(syncCompletedConcerns(seriesSync, { types: "MOVIE" })).toBe(false);
    expect(syncCompletedConcerns(seriesSync, { types: "SERIES" })).toBe(true);
    expect(syncCompletedConcerns(event(syncCompletedMeta("s1", ["MOVIE", "MUSIC"])), { types: "MUSIC" })).toBe(true);
  });

  it("refetches a view spanning several types when any of them changed", () => {
    const musicSync = event(syncCompletedMeta("s1", ["MUSIC"]));
    expect(syncCompletedConcerns(musicSync, { types: ["MOVIE", "SERIES"] })).toBe(false);
    expect(syncCompletedConcerns(musicSync, { types: ["MOVIE", "MUSIC"] })).toBe(true);
    // No type scope at all (every type) always cares.
    expect(syncCompletedConcerns(musicSync, { types: null })).toBe(true);
    expect(syncCompletedConcerns(musicSync, { types: [] })).toBe(true);
  });

  it("skips a single-server view when another server synced", () => {
    const sync = event(syncCompletedMeta("s2", ["MOVIE"]));
    expect(syncCompletedConcerns(sync, { types: "MOVIE", serverId: "s1" })).toBe(false);
    expect(syncCompletedConcerns(sync, { types: "MOVIE", serverId: "s2" })).toBe(true);
  });

  it("refetches an all-servers view whichever server synced", () => {
    const sync = event(syncCompletedMeta("s2", ["MOVIE"]));
    expect(syncCompletedConcerns(sync, { types: "MOVIE", serverId: "all" })).toBe(true);
    expect(syncCompletedConcerns(sync, { types: "MOVIE", serverId: null })).toBe(true);
    expect(syncCompletedConcerns(sync, { types: "MOVIE" })).toBe(true);
  });

  it("refetches a single-server view when the event names no server", () => {
    expect(syncCompletedConcerns(event({ libraryTypes: ["MOVIE"] }), { types: "MOVIE", serverId: "s1" })).toBe(true);
  });

  it("ignores a malformed libraryTypes rather than skipping on it", () => {
    expect(syncCompletedConcerns(event({ serverId: "s1", libraryTypes: "MOVIE" }), { types: "SERIES" })).toBe(true);
  });
});
