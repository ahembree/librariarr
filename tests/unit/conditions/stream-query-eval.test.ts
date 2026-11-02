import { describe, it, expect } from "vitest";
import {
  evaluateStreamQueryGroupInMemory,
  evaluateStreamQueryRuleAgainstStream,
} from "@/lib/conditions/stream-query-eval";
import { evaluateAllRulesInMemory } from "@/lib/rules/lifecycle-engine";
import { evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import type { LifecycleRuleGroup } from "@/lib/rules/types";
import type { QueryGroup } from "@/lib/query/types";

const AUDIO = 2;
const rule = (field: string, operator: string, value: string | number, negate = false) => ({
  id: "r", field, operator, value, negate, condition: "AND" as const,
});
const group = (
  rules: ReturnType<typeof rule>[],
  quantifier: "any" | "none" | "all" = "any",
) => ({ id: "sq", condition: "AND" as const, groups: [], rules, streamQuery: { streamType: "audio" as const, quantifier } });

describe("evaluateStreamQueryRuleAgainstStream", () => {
  it("compares numbers, and treats a missing value as false unless negated", () => {
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqChannels", "greaterThan", 2), { channels: 6 })).toBe(true);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqChannels", "between", "2,6"), { channels: 6 })).toBe(true);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqChannels", "between", "2,6"), { channels: null })).toBe(false);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqChannels", "between", "2,6", true), { channels: null })).toBe(true);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqChannels", "isNull", ""), { channels: null })).toBe(true);
  });

  it("matches text case-insensitively, with wildcards", () => {
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqCodec", "equals", "AAC"), { codec: "aac" })).toBe(true);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqCodec", "matchesWildcard", "e*3"), { codec: "eac3" })).toBe(true);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqCodec", "notMatchesWildcard", "e*3"), { codec: "eac3" })).toBe(false);
  });

  it("reads computed fields from the stream", () => {
    expect(
      evaluateStreamQueryRuleAgainstStream(rule("sqAudioProfile", "equals", "Dolby Atmos"), {
        codec: "truehd", displayTitle: "TrueHD Atmos 7.1",
      }),
    ).toBe(true);
  });

  it("matches nothing for a rule it cannot evaluate, negated or not", () => {
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqCodec", "contains", ""), { codec: "aac" })).toBe(false);
    expect(evaluateStreamQueryRuleAgainstStream(rule("sqCodec", "greaterThan", 1, true), { codec: "aac" })).toBe(false);
    expect(evaluateStreamQueryRuleAgainstStream(rule("notAStreamField", "equals", "x", true), { codec: "aac" })).toBe(false);
  });
});

describe("evaluateStreamQueryGroupInMemory", () => {
  const item = {
    streams: [
      { streamType: AUDIO, codec: "aac", channels: 2 },
      { streamType: AUDIO, codec: "eac3", channels: 6 },
      { streamType: 3, codec: "srt" },
    ],
  };

  it("applies the any, none and all quantifiers to the group's stream type", () => {
    const sixChannels = [rule("sqChannels", "equals", 6)];
    expect(evaluateStreamQueryGroupInMemory(group(sixChannels, "any"), item)).toBe(true);
    expect(evaluateStreamQueryGroupInMemory(group(sixChannels, "none"), item)).toBe(false);
    expect(evaluateStreamQueryGroupInMemory(group(sixChannels, "all"), item)).toBe(false);
    expect(evaluateStreamQueryGroupInMemory(group([rule("sqChannels", "greaterThan", 1)], "all"), item)).toBe(true);
  });

  it("is false for 'all' over no stream of the type, and for a group that cannot be evaluated", () => {
    expect(evaluateStreamQueryGroupInMemory(group([rule("sqChannels", "greaterThan", 1)], "all"), { streams: [] })).toBe(false);
    // An unconfigured rule would make "none" vacuously true.
    expect(evaluateStreamQueryGroupInMemory(group([rule("sqCodec", "contains", "")], "none"), item)).toBe(false);
    expect(evaluateStreamQueryGroupInMemory(group([], "none"), item)).toBe(false);
    expect(evaluateStreamQueryGroupInMemory({ rules: [] }, item)).toBe(false);
  });

  it("answers as both engines do through their own evaluators", () => {
    const cases = [
      group([rule("sqChannels", "between", "2,6", true)], "any"),
      group([rule("sqCodec", "notMatchesWildcard", "a*")], "all"),
      group([rule("sqChannels", "greaterThan", 6)], "none"),
    ];
    for (const g of cases) {
      const wrapped = [{ id: "g", condition: "AND" as const, rules: [], groups: [g] }];
      const expected = evaluateStreamQueryGroupInMemory(g, item);
      expect(evaluateAllRulesInMemory(wrapped as unknown as LifecycleRuleGroup[], item)).toBe(expected);
      expect(evaluateAllQueryRulesInMemory(wrapped as unknown as QueryGroup[], item, undefined, undefined)).toBe(expected);
    }
  });
});
