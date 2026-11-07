import { describe, it, expect } from "vitest";
import { tagListsDisjoint, withoutTags } from "@/lib/lifecycle/arr-tag-lists";

describe("withoutTags", () => {
  it("drops picked labels, trimmed and case-insensitively", () => {
    expect(withoutTags(["Keep", "new ", "other"], ["keep", "NEW"])).toEqual(["other"]);
  });

  it("returns the list unchanged when nothing is picked", () => {
    expect(withoutTags(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("tagListsDisjoint", () => {
  it("is true for distinct lists or a missing list", () => {
    expect(tagListsDisjoint({ addArrTags: ["a"], removeArrTags: ["b"] })).toBe(true);
    expect(tagListsDisjoint({ addArrTags: ["a"] })).toBe(true);
    expect(tagListsDisjoint({ removeArrTags: ["a"] })).toBe(true);
    expect(tagListsDisjoint({})).toBe(true);
  });

  it("is false when a label is in both, trimmed and case-insensitively", () => {
    expect(tagListsDisjoint({ addArrTags: ["Archived"], removeArrTags: [" archived"] })).toBe(false);
  });
});
