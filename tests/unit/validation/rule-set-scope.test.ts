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
    expect(ruleSetCreateSchema.safeParse({ ...base, type: "SERIES", rules: rules("genre", "arrEnded") }).success).toBe(true);
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
});
