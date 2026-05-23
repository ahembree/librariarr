import { describe, it, expect } from "vitest";
import type { QueryDefinition } from "@/lib/query/types";
import {
  ConvertQueryError,
  convertQueryToRuleSetBody,
} from "@/lib/query/convert-to-rule";
import { ruleSetCreateSchema } from "@/lib/validation";

function makeQuery(overrides: Partial<QueryDefinition> = {}): QueryDefinition {
  return {
    mediaTypes: ["MOVIE"],
    serverIds: ["srv1"],
    groups: [
      {
        id: "g1",
        condition: "AND",
        rules: [
          {
            id: "r1",
            field: "title",
            operator: "contains",
            value: "matrix",
            condition: "AND",
          },
        ],
        groups: [],
      },
    ],
    sortBy: "title",
    sortOrder: "asc",
    ...overrides,
  };
}

describe("convertQueryToRuleSetBody", () => {
  it("produces a body that validates against ruleSetCreateSchema", () => {
    const body = convertQueryToRuleSetBody(makeQuery(), {
      name: "Old Movies",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    const result = ruleSetCreateSchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it("sets enabled=true and actionEnabled=false; omits actionType", () => {
    const body = convertQueryToRuleSetBody(makeQuery(), {
      name: "Test",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    expect(body.enabled).toBe(true);
    expect(body.actionEnabled).toBe(false);
    expect("actionType" in body).toBe(false);
  });

  it("sets seriesScope=true only when target is SERIES", () => {
    const movieBody = convertQueryToRuleSetBody(makeQuery(), {
      name: "M",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    expect("seriesScope" in movieBody).toBe(false);

    const seriesBody = convertQueryToRuleSetBody(
      makeQuery({ mediaTypes: ["SERIES"] }),
      { name: "S", targetLibraryType: "SERIES", serverIds: ["srv1"] },
    );
    expect(seriesBody.seriesScope).toBe(true);
  });

  it("removes incompatible rules from the cleaned rules tree", () => {
    const query = makeQuery({
      mediaTypes: ["MOVIE", "SERIES"],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "title", operator: "contains", value: "x", condition: "AND" },
            { id: "r2", field: "availableEpisodeCount", operator: "greaterThan", value: 5, condition: "AND" },
          ],
          groups: [],
        },
      ],
    });
    const body = convertQueryToRuleSetBody(query, {
      name: "Movies only",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    const rules = body.rules as unknown as Array<{ rules: Array<{ field: string }> }>;
    expect(rules[0].rules.map((r) => r.field)).toEqual(["title"]);
  });

  it("throws ConvertQueryError when name is empty", () => {
    expect(() =>
      convertQueryToRuleSetBody(makeQuery(), {
        name: "   ",
        targetLibraryType: "MOVIE",
        serverIds: ["srv1"],
      }),
    ).toThrow(ConvertQueryError);
  });

  it("throws ConvertQueryError when serverIds is empty", () => {
    try {
      convertQueryToRuleSetBody(makeQuery(), {
        name: "n",
        targetLibraryType: "MOVIE",
        serverIds: [],
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConvertQueryError);
      expect((err as ConvertQueryError).code).toBe("EMPTY_SERVERS");
    }
  });

  it("throws ConvertQueryError when all rules are incompatible", () => {
    const query = makeQuery({
      mediaTypes: ["SERIES"],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "availableEpisodeCount", operator: "greaterThan", value: 1, condition: "AND" },
          ],
          groups: [],
        },
      ],
    });
    try {
      convertQueryToRuleSetBody(query, {
        name: "n",
        targetLibraryType: "MOVIE",
        serverIds: ["srv1"],
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConvertQueryError);
      expect((err as ConvertQueryError).code).toBe("ALL_RULES_INCOMPATIBLE");
    }
  });

  it("trims the name", () => {
    const body = convertQueryToRuleSetBody(makeQuery(), {
      name: "  spaced  ",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    expect(body.name).toBe("spaced");
  });

  it("transfers the matching Arr instance from the query", () => {
    const query = makeQuery({
      mediaTypes: ["MOVIE", "SERIES", "MUSIC"],
      arrServerIds: { radarr: "rdr-1", sonarr: "snr-2", lidarr: "ldr-3" },
    });
    const movie = convertQueryToRuleSetBody(query, {
      name: "M",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    expect(movie.arrInstanceId).toBe("rdr-1");

    const series = convertQueryToRuleSetBody(query, {
      name: "S",
      targetLibraryType: "SERIES",
      serverIds: ["srv1"],
    });
    expect(series.arrInstanceId).toBe("snr-2");

    const music = convertQueryToRuleSetBody(makeQuery({
      mediaTypes: ["MUSIC"],
      groups: [{
        id: "g1",
        condition: "AND",
        rules: [{ id: "r1", field: "title", operator: "contains", value: "x", condition: "AND" }],
        groups: [],
      }],
      arrServerIds: { radarr: "rdr-1", sonarr: "snr-2", lidarr: "ldr-3" },
    }), {
      name: "L",
      targetLibraryType: "MUSIC",
      serverIds: ["srv1"],
    });
    expect(music.arrInstanceId).toBe("ldr-3");
  });

  it("omits arrInstanceId when the query has none for the target type", () => {
    const body = convertQueryToRuleSetBody(
      makeQuery({ arrServerIds: { sonarr: "snr-only" } }),
      { name: "M", targetLibraryType: "MOVIE", serverIds: ["srv1"] },
    );
    expect("arrInstanceId" in body).toBe(false);
  });
});
