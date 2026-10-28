import { describe, it, expect } from "vitest";
import { coverageOf, episodesToExecute, uncoveredEpisodes } from "@/lib/lifecycle/episode-coverage";

const settled = (mediaItemId: string, matchedMediaItemIds: string[]) => ({ mediaItemId, matchedMediaItemIds });

describe("uncoveredEpisodes", () => {
  it("returns the episodes no settled action acted on", () => {
    const coverage = coverageOf([settled("e1", ["e1"]), settled("e3", ["e3"])]);
    expect(uncoveredEpisodes("e1", ["e1", "e2", "e3"], coverage)).toEqual(["e2"]);
  });

  it("returns nothing when every episode was acted on", () => {
    expect(uncoveredEpisodes("e1", ["e1", "e2"], coverageOf([settled("e1", ["e2", "e1"])]))).toEqual([]);
  });

  it("counts an action stored against another representative of the show", () => {
    // Settled under e3; e3 has since stopped matching and e4 stands in.
    expect(uncoveredEpisodes("e4", ["e4", "e5"], coverageOf([settled("e3", ["e3", "e4"])]))).toEqual(["e5"]);
  });

  it("treats a settled action with no member list as having covered its whole series", () => {
    expect(uncoveredEpisodes("e1", ["e1", "e2"], coverageOf([settled("e1", [])]))).toEqual([]);
    expect(uncoveredEpisodes("e2", ["e1", "e2"], coverageOf([settled("e1", [])]))).toEqual([]);
    // Another show's legacy action does not.
    expect(uncoveredEpisodes("e2", ["e2"], coverageOf([settled("x1", [])]))).toEqual(["e2"]);
  });

  it("reads a match that lists no members as its own item", () => {
    expect(uncoveredEpisodes("e1", [], coverageOf([]))).toEqual(["e1"]);
    expect(uncoveredEpisodes("e1", [], coverageOf([settled("e9", ["e1"])]))).toEqual([]);
  });

  it("returns every episode when nothing has settled", () => {
    expect(uncoveredEpisodes("e1", ["e1", "e2"], coverageOf([]))).toEqual(["e1", "e2"]);
  });
});

describe("episodesToExecute", () => {
  it("acts on a scheduled action's own members that still match", () => {
    expect(episodesToExecute("e2", ["e2", "e3", "e4"], ["e2", "e3", "e9"], coverageOf([settled("e1", ["e1"])]))).toEqual(["e2", "e3"]);
  });

  it("acts on only the uncovered episodes of an estimated row", () => {
    expect(episodesToExecute("e1", ["e1", "e2", "e3"], null, coverageOf([settled("e1", ["e1", "e2"])]))).toEqual(["e3"]);
  });

  it("keeps a scheduled action's members when the match lists none", () => {
    expect(episodesToExecute("e1", [], ["e2"], coverageOf([]))).toEqual(["e2"]);
  });

  it("falls back to the uncovered episodes for a scheduled action with no members", () => {
    expect(episodesToExecute("e1", ["e1", "e2"], [], coverageOf([settled("e1", ["e1"])]))).toEqual(["e2"]);
  });
});
