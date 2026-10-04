import { describe, it, expect } from "vitest";
import { collapseActionItems } from "@/lib/query/collapse-actions";

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, parentTitle: null as string | null, seriesKey: null as string | null, externalIds: [] as Array<{ source: string; externalId: string }>, ...over,
});

describe("collapseActionItems", () => {
  it("keeps one copy of a movie per TMDB id, and every movie without one", () => {
    const { items } = collapseActionItems("MOVIE", [
      item("a", { externalIds: [{ source: "TMDB", externalId: "1" }] }),
      item("b", { externalIds: [{ source: "TMDB", externalId: "1" }] }),
      item("c"),
      item("d"),
    ], new Map());
    expect(items.map((i) => i.id)).toEqual(["a", "c", "d"]);
  });

  it("merges a show's members across copies and episodes", () => {
    const { items, members } = collapseActionItems("SERIES", [
      item("e1", { seriesKey: "tvdb:5", externalIds: [{ source: "TVDB", externalId: "5" }] }),
      item("e2", { seriesKey: "tvdb:5", externalIds: [{ source: "TVDB", externalId: "5" }] }),
      item("x1", { seriesKey: "title:other" }),
    ], new Map([["e1", ["e1"]], ["e2", ["e2", "e3"]]]));
    expect(items.map((i) => i.id)).toEqual(["e1", "x1"]);
    expect(members.get("e1")).toEqual(["e1", "e2", "e3"]);
    expect(members.get("x1")).toEqual(["x1"]);
  });

  it("collapses an artist's tracks into one action naming every track", () => {
    const { items, members } = collapseActionItems("MUSIC", [
      item("t1", { parentTitle: "Artist", externalIds: [{ source: "MUSICBRAINZ", externalId: "mb" }] }),
      item("t2", { parentTitle: "Artist", externalIds: [{ source: "MUSICBRAINZ", externalId: "mb" }] }),
      item("t3", { parentTitle: "Other" }),
    ], new Map());
    expect(items.map((i) => i.id)).toEqual(["t1", "t3"]);
    expect(members.get("t1")).toEqual(["t1", "t2"]);
  });
});
