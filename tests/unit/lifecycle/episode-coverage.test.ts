import { describe, it, expect } from "vitest";
import { uncoveredMembers } from "@/lib/lifecycle/episode-coverage";

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
