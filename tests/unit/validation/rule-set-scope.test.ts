/**
 * A Series or Music rule set judging whole shows or artists may not use a
 * criterion that describes one episode or track: the create schema refuses it
 * (`ruleSetCreateSchema`), and `ruleSetScopeError` answers an update the same
 * way once merged with the stored rule set.
 */
import { describe, it, expect } from "vitest";
import { ruleSetCreateSchema, ruleSetScopeError } from "@/lib/validation";

function rules(...fields: string[]) {
  return [{
    id: "g1",
    condition: "AND",
    rules: fields.map((field, i) => ({ id: `r${i}`, field, operator: "equals", value: "x", condition: "AND" })),
    groups: [],
  }];
}

const base = { name: "Rule set", serverIds: ["s1"] };

describe("ruleSetCreateSchema", () => {
  it("refuses a per-episode criterion with series scope on, or left to its default", () => {
    for (const body of [
      { ...base, type: "SERIES", rules: rules("playCount", "resolution"), seriesScope: true },
      { ...base, type: "SERIES", rules: rules("playCount", "resolution") },
    ]) {
      const result = ruleSetCreateSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ path: ["rules"], message: expect.stringContaining("describe one episode or file: Resolution.") }),
      ]);
    }
  });

  it("refuses a per-track criterion with artist scope on", () => {
    const result = ruleSetCreateSchema.safeParse({ ...base, type: "MUSIC", rules: rules("albumTitle"), seriesScope: true });
    expect(result.error?.issues[0].message).toContain("describe one track or file: Album.");
  });

  it("accepts the same rules with the scope off, on a movie rule set, and show-level criteria with it on", () => {
    expect(ruleSetCreateSchema.safeParse({ ...base, type: "SERIES", rules: rules("resolution"), seriesScope: false }).success).toBe(true);
    expect(ruleSetCreateSchema.safeParse({ ...base, type: "MUSIC", rules: rules("audioCodec"), seriesScope: false }).success).toBe(true);
    expect(ruleSetCreateSchema.safeParse({ ...base, type: "MOVIE", rules: rules("resolution") }).success).toBe(true);
    expect(ruleSetCreateSchema.safeParse({ ...base, type: "SERIES", rules: rules("playCount", "arrEnded") }).success).toBe(true);
  });

  it("refuses genre at artist scope: a track keeps its own genres", () => {
    const result = ruleSetCreateSchema.safeParse({ ...base, type: "MUSIC", rules: rules("genre"), seriesScope: true });
    expect(result.error?.issues[0].message).toContain("describe one track or file: Genre.");
  });

  it("refuses an armed whole-show action following per-episode criteria with the scope off, on the action", () => {
    const body = { ...base, type: "SERIES", rules: rules("resolution"), seriesScope: false, actionType: "DELETE_SONARR" };
    const refused = ruleSetCreateSchema.safeParse({ ...body, actionEnabled: true });
    expect(refused.error?.issues).toEqual([
      expect.objectContaining({ path: ["actionType"], message: expect.stringMatching(/^"Delete from Sonarr" acts on the whole show, so with "Match against entire series" off it can't follow criteria that describe one episode or file: Resolution/) }),
    ]);
    // Created with the action off (the default), it saves: nothing would run.
    expect(ruleSetCreateSchema.safeParse(body).success).toBe(true);
    expect(ruleSetCreateSchema.safeParse({ ...body, actionEnabled: false }).success).toBe(true);
    // Arr tags make any action act on the whole show.
    expect(ruleSetCreateSchema.safeParse({ ...body, actionEnabled: true, actionType: "DO_NOTHING", addArrTags: ["x"] }).success).toBe(false);
    expect(ruleSetCreateSchema.safeParse({ ...body, actionEnabled: true, actionType: "DELETE_FILES_SONARR" }).success).toBe(true);
  });
});

describe("ruleSetScopeError", () => {
  it("answers 400 in the validation shape, naming what the request changed", async () => {
    const byRules = ruleSetScopeError({ type: "SERIES", seriesScope: true, rules: rules("year") }, "rules");
    expect(byRules?.status).toBe(400);
    expect(await byRules?.json()).toEqual({
      error: "Validation failed",
      details: [expect.stringMatching(/^rules: With "Match against entire series" on, .*one episode or file: Year\./)],
    });

    const byScope = ruleSetScopeError({ type: "MUSIC", seriesScope: true, rules: rules("duration") }, "seriesScope");
    expect((await byScope?.json()).details[0]).toMatch(/^seriesScope: .*one track or file: Duration \(min\)\./);
  });

  it("allows a valid merged state", () => {
    expect(ruleSetScopeError({ type: "SERIES", seriesScope: false, rules: rules("year") }, "rules")).toBeNull();
    expect(ruleSetScopeError({ type: "SERIES", seriesScope: true, rules: rules("title") }, "seriesScope")).toBeNull();
    expect(ruleSetScopeError({ type: "MOVIE", seriesScope: true, rules: rules("year") }, "rules")).toBeNull();
  });

  it("refuses arming a whole-show action over per-episode rules with the scope off", async () => {
    const merged = { type: "SERIES", seriesScope: false, rules: rules("year"), actionEnabled: true, actionType: "CHANGE_QUALITY_PROFILE_SONARR" };
    const refused = ruleSetScopeError(merged, "actionEnabled", { actionCausedOnly: true });
    expect((await refused?.json()).details[0]).toMatch(/^actionEnabled: "Change Quality Profile" acts on the whole show/);
    expect(ruleSetScopeError({ ...merged, actionEnabled: false }, "actionEnabled", { actionCausedOnly: true })).toBeNull();
  });

  it("lets an action-only change through on a rule set already invalid for its scope", () => {
    // Saved before the rule: series scope on with a per-episode criterion. Its
    // action can still be changed (or turned off) without fixing the rules.
    const legacy = { type: "SERIES", seriesScope: true, rules: rules("year"), actionEnabled: true, actionType: "DELETE_SONARR" };
    expect(ruleSetScopeError(legacy, "actionType", { actionCausedOnly: true })).toBeNull();
    expect(ruleSetScopeError(legacy, "rules")).not.toBeNull();
  });
});
