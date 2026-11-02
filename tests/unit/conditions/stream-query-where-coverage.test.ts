import { describe, it, expect } from "vitest";
import {
  buildStreamQueryClause,
  streamQueryNeedsInMemory,
} from "@/lib/conditions/stream-query-where";
import { UNSATISFIABLE_WHERE } from "@/lib/conditions/where-builder";
import type { Condition, ConditionGroup } from "@/lib/conditions/types";

function rule(r: Partial<Condition> & Pick<Condition, "field" | "operator" | "value">): Condition {
  return { id: "r", condition: "AND", ...r };
}

function sq(
  rules: Condition[],
  streamType: "audio" | "video" | "subtitle" = "audio",
  quantifier?: "any" | "none" | "all",
): ConditionGroup {
  return {
    id: "g",
    condition: "AND",
    rules,
    groups: [],
    streamQuery: quantifier ? { streamType, quantifier } : { streamType },
  };
}

/** Extract the single stream condition of an `any` clause. */
function inner(group: ConditionGroup) {
  const clause = buildStreamQueryClause(group) as {
    streams: { some: { streamType: number; AND: Record<string, unknown>[] } };
  };
  return clause.streams.some;
}

describe("streamQueryNeedsInMemory", () => {
  it("is false for a non-stream group", () => {
    expect(streamQueryNeedsInMemory({ id: "x", condition: "AND", rules: [], groups: [] })).toBe(false);
  });

  it("is true for the all quantifier even with plain rules", () => {
    expect(streamQueryNeedsInMemory(sq([rule({ field: "sqCodec", operator: "equals", value: "aac" })], "audio", "all"))).toBe(true);
  });

  it("is true for computed fields and wildcard operators, ignoring disabled rules", () => {
    expect(streamQueryNeedsInMemory(sq([rule({ field: "sqAudioProfile", operator: "equals", value: "Dolby Atmos" })]))).toBe(true);
    expect(streamQueryNeedsInMemory(sq([rule({ field: "sqCodec", operator: "matchesWildcard", value: "a*" })]))).toBe(true);
    expect(streamQueryNeedsInMemory(sq([rule({ field: "sqCodec", operator: "notMatchesWildcard", value: "a*" })]))).toBe(true);
    expect(streamQueryNeedsInMemory(sq([rule({ field: "sqAudioProfile", operator: "equals", value: "x", enabled: false })]))).toBe(false);
    expect(streamQueryNeedsInMemory(sq([rule({ field: "sqCodec", operator: "equals", value: "aac" })], "audio", "none"))).toBe(false);
  });
});

describe("buildStreamQueryClause", () => {
  it("returns null for a non-stream group and for a group with only Phase-2/disabled rules", () => {
    expect(buildStreamQueryClause({ id: "x", condition: "AND", rules: [], groups: [] })).toBeNull();
    expect(buildStreamQueryClause(sq([
      rule({ field: "sqCodec", operator: "equals", value: "aac", enabled: false }),
      rule({ field: "sqAudioProfile", operator: "equals", value: "Dolby Atmos" }),
      rule({ field: "sqCodec", operator: "matchesWildcard", value: "a*" }),
    ]))).toBeNull();
  });

  it("fails the group on an unconfigured contains, an inapplicable operator, or a malformed value", () => {
    expect(buildStreamQueryClause(sq([rule({ field: "sqCodec", operator: "contains", value: "" })]))).toBe(UNSATISFIABLE_WHERE);
    expect(buildStreamQueryClause(sq([rule({ field: "sqIsDefault", operator: "contains", value: "x" })]))).toBe(UNSATISFIABLE_WHERE);
    expect(buildStreamQueryClause(sq([rule({ field: "sqChannels", operator: "greaterThan", value: "abc" })]))).toBe(UNSATISFIABLE_WHERE);
  });

  it("maps the stream type to its integer", () => {
    expect(inner(sq([rule({ field: "sqCodec", operator: "equals", value: "h264" })], "video")).streamType).toBe(1);
    expect(inner(sq([rule({ field: "sqCodec", operator: "equals", value: "aac" })], "audio")).streamType).toBe(2);
    expect(inner(sq([rule({ field: "sqForced", operator: "equals", value: "true" })], "subtitle")).streamType).toBe(3);
  });

  describe("boolean fields", () => {
    it("equals true / notEquals false match the true side", () => {
      expect(inner(sq([rule({ field: "sqIsDefault", operator: "equals", value: "true" })])).AND).toEqual([{ isDefault: true }]);
      expect(inner(sq([rule({ field: "sqIsDefault", operator: "notEquals", value: "false" })])).AND).toEqual([{ isDefault: true }]);
    });

    it("equals false includes NULL rows; negate flips to the other side and is not re-wrapped", () => {
      expect(inner(sq([rule({ field: "sqIsDefault", operator: "equals", value: "FALSE" })])).AND)
        .toEqual([{ OR: [{ isDefault: false }, { isDefault: null }] }]);
      expect(inner(sq([rule({ field: "sqIsDefault", operator: "equals", value: "true", negate: true })])).AND)
        .toEqual([{ OR: [{ isDefault: false }, { isDefault: null }] }]);
      expect(inner(sq([rule({ field: "sqForced", operator: "notEquals", value: "true", negate: true })], "subtitle")).AND)
        .toEqual([{ forced: true }]);
    });

    it("isNull/isNotNull are self-safe under negate", () => {
      expect(inner(sq([rule({ field: "sqForced", operator: "isNotNull", value: "" })], "subtitle")).AND).toEqual([{ forced: { not: null } }]);
      expect(inner(sq([rule({ field: "sqForced", operator: "isNull", value: "", negate: true })], "subtitle")).AND)
        .toEqual([{ NOT: { forced: null } }]);
    });
  });

  describe("numeric fields", () => {
    const cases: Array<[string, string, unknown]> = [
      ["equals", "6", { channels: 6 }],
      ["notEquals", "6", { channels: { not: 6 } }],
      ["greaterThan", "2", { channels: { gt: 2 } }],
      ["greaterThanOrEqual", "2", { channels: { gte: 2 } }],
      ["lessThan", "8", { channels: { lt: 8 } }],
      ["lessThanOrEqual", "8", { channels: { lte: 8 } }],
      ["between", "2,6", { channels: { gte: 2, lte: 6 } }],
      ["isNull", "", { channels: null }],
      ["isNotNull", "", { channels: { not: null } }],
    ];
    it.each(cases)("%s", (operator, value, expected) => {
      expect(inner(sq([rule({ field: "sqChannels", operator, value })])).AND).toEqual([expected]);
    });

    it("negating a positive comparison admits NULL columns", () => {
      expect(inner(sq([rule({ field: "sqBitrate", operator: "greaterThan", value: "1000", negate: true })])).AND)
        .toEqual([{ OR: [{ bitrate: null }, { NOT: { bitrate: { gt: 1000 } } }] }]);
    });

    it("negating isNull is a plain NOT", () => {
      expect(inner(sq([rule({ field: "sqWidth", operator: "isNull", value: "", negate: true })], "video")).AND)
        .toEqual([{ NOT: { width: null } }]);
    });
  });

  describe("text fields", () => {
    it("equals escapes LIKE metacharacters, case-insensitively", () => {
      expect(inner(sq([rule({ field: "sqDisplayTitle", operator: "equals", value: "50%_x" })])).AND)
        .toEqual([{ displayTitle: { equals: "50\\%\\_x", mode: "insensitive" } }]);
    });

    it("notEquals includes NULL rows and is wrapped in a plain NOT under negate", () => {
      const notEq = { OR: [{ language: null }, { language: { not: "English", mode: "insensitive" } }] };
      expect(inner(sq([rule({ field: "sqLanguage", operator: "notEquals", value: "English" })])).AND).toEqual([notEq]);
      expect(inner(sq([rule({ field: "sqLanguage", operator: "notEquals", value: "English", negate: true })])).AND)
        .toEqual([{ NOT: notEq }]);
    });

    it("contains on an enumerable field splits pipe values into exact matches", () => {
      expect(inner(sq([rule({ field: "sqCodec", operator: "contains", value: "aac|ac3|" })])).AND).toEqual([
        { OR: [
          { codec: { equals: "aac", mode: "insensitive" } },
          { codec: { equals: "ac3", mode: "insensitive" } },
        ] },
      ]);
    });

    it("contains on a non-enumerable field is a substring match, and negate admits NULLs", () => {
      expect(inner(sq([rule({ field: "sqDisplayTitle", operator: "contains", value: "Atmos" })])).AND)
        .toEqual([{ displayTitle: { contains: "Atmos", mode: "insensitive" } }]);
      expect(inner(sq([rule({ field: "sqDisplayTitle", operator: "contains", value: "Atmos", negate: true })])).AND)
        .toEqual([{ OR: [{ displayTitle: null }, { NOT: { displayTitle: { contains: "Atmos", mode: "insensitive" } } }] }]);
    });

    it("notContains on enumerable and non-enumerable fields includes NULL rows", () => {
      expect(inner(sq([rule({ field: "sqCodec", operator: "notContains", value: "aac|dts" })])).AND).toEqual([
        { OR: [
          { codec: null },
          { AND: [
            { NOT: { codec: { equals: "aac", mode: "insensitive" } } },
            { NOT: { codec: { equals: "dts", mode: "insensitive" } } },
          ] },
        ] },
      ]);
      expect(inner(sq([rule({ field: "sqExtDisplayTitle", operator: "notContains", value: "Commentary" })])).AND).toEqual([
        { OR: [
          { extendedDisplayTitle: null },
          { NOT: { extendedDisplayTitle: { contains: "Commentary", mode: "insensitive" } } },
        ] },
      ]);
    });

    it("isNull / isNotNull treat empty strings as empty", () => {
      expect(inner(sq([rule({ field: "sqProfile", operator: "isNull", value: "" })])).AND)
        .toEqual([{ OR: [{ profile: null }, { profile: "" }] }]);
      expect(inner(sq([rule({ field: "sqProfile", operator: "isNotNull", value: "" })])).AND)
        .toEqual([{ AND: [{ profile: { not: null } }, { NOT: { profile: "" } }] }]);
    });
  });

  it("none quantifier wraps the conditions in streams.none", () => {
    expect(buildStreamQueryClause(sq([rule({ field: "sqCodec", operator: "equals", value: "dts" })], "audio", "none"))).toEqual({
      streams: { none: { streamType: 2, AND: [{ codec: { equals: "dts", mode: "insensitive" } }] } },
    });
  });

  it("all quantifier requires one stream and none failing", () => {
    const conds = [{ codec: { equals: "dts", mode: "insensitive" } }];
    expect(buildStreamQueryClause(sq([rule({ field: "sqCodec", operator: "equals", value: "dts" })], "audio", "all"))).toEqual({
      AND: [
        { streams: { some: { streamType: 2 } } },
        { streams: { none: { streamType: 2, NOT: { AND: conds } } } },
      ],
    });
  });
});
