import { describe, it, expect } from "vitest";
import { actionConfigSignature, type ActionConfig } from "@/lib/lifecycle/action-signature";

const base: ActionConfig = {
  actionType: "DO_NOTHING",
  arrInstanceId: null,
  targetQualityProfileId: null,
  addImportExclusion: false,
  searchAfterAction: false,
  addArrTags: [],
  removeArrTags: [],
};

describe("actionConfigSignature", () => {
  it("is equal for identical configs", () => {
    expect(actionConfigSignature(base)).toBe(actionConfigSignature({ ...base }));
  });

  it("differs when the action type changes", () => {
    expect(actionConfigSignature(base)).not.toBe(
      actionConfigSignature({ ...base, actionType: "UNMONITOR_RADARR" }),
    );
  });

  it("differs when tags change", () => {
    expect(actionConfigSignature({ ...base, addArrTags: ["a"] })).not.toBe(
      actionConfigSignature({ ...base, addArrTags: ["a", "b"] }),
    );
  });

  it("ignores tag order and duplicates (compared as a set)", () => {
    expect(actionConfigSignature({ ...base, addArrTags: ["a", "b"] })).toBe(
      actionConfigSignature({ ...base, addArrTags: ["b", "a", "a"] }),
    );
  });

  it("distinguishes addArrTags from removeArrTags", () => {
    expect(actionConfigSignature({ ...base, addArrTags: ["a"] })).not.toBe(
      actionConfigSignature({ ...base, removeArrTags: ["a"] }),
    );
  });

  it("differs when the target quality profile changes", () => {
    expect(
      actionConfigSignature({ ...base, actionType: "CHANGE_QUALITY_PROFILE_RADARR", targetQualityProfileId: 1 }),
    ).not.toBe(
      actionConfigSignature({ ...base, actionType: "CHANGE_QUALITY_PROFILE_RADARR", targetQualityProfileId: 2 }),
    );
  });

  it("differs when the Arr instance changes", () => {
    expect(actionConfigSignature({ ...base, arrInstanceId: "a" })).not.toBe(
      actionConfigSignature({ ...base, arrInstanceId: "b" }),
    );
  });

  it("differs when searchAfterAction or addImportExclusion change", () => {
    expect(actionConfigSignature(base)).not.toBe(
      actionConfigSignature({ ...base, searchAfterAction: true }),
    );
    expect(actionConfigSignature(base)).not.toBe(
      actionConfigSignature({ ...base, addImportExclusion: true }),
    );
  });
});
