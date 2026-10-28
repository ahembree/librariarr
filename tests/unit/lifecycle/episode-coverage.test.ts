import { describe, it, expect } from "vitest";
import { episodesToExecute, uncoveredMembers } from "@/lib/lifecycle/episode-coverage";

describe("uncoveredMembers", () => {
  it("returns the episodes no settled action acted on", () => {
    expect(uncoveredMembers(["e1", "e2", "e3"], [{ matchedMediaItemIds: ["e1"] }, { matchedMediaItemIds: ["e3"] }])).toEqual(["e2"]);
  });

  it("returns nothing when every episode was acted on", () => {
    expect(uncoveredMembers(["e1", "e2"], [{ matchedMediaItemIds: ["e2", "e1"] }])).toEqual([]);
  });

  it("treats a settled action with no member list as having covered the whole series", () => {
    expect(uncoveredMembers(["e1", "e2"], [{ matchedMediaItemIds: ["e1"] }, { matchedMediaItemIds: [] }])).toEqual([]);
  });

  it("returns every episode when nothing has settled", () => {
    expect(uncoveredMembers(["e1"], [])).toEqual(["e1"]);
  });
});

describe("episodesToExecute", () => {
  it("acts on a scheduled action's own members that still match", () => {
    expect(episodesToExecute(["e2", "e3", "e4"], ["e2", "e3", "e9"], [{ matchedMediaItemIds: ["e1"] }])).toEqual(["e2", "e3"]);
  });

  it("acts on only the uncovered episodes of an estimated row", () => {
    expect(episodesToExecute(["e1", "e2", "e3"], null, [{ matchedMediaItemIds: ["e1", "e2"] }])).toEqual(["e3"]);
  });

  it("keeps a scheduled action's members when the match lists none", () => {
    expect(episodesToExecute([], ["e2"], [])).toEqual(["e2"]);
  });

  it("falls back to the uncovered episodes for a scheduled action with no members", () => {
    expect(episodesToExecute(["e1", "e2"], [], [{ matchedMediaItemIds: ["e1"] }])).toEqual(["e2"]);
  });
});
