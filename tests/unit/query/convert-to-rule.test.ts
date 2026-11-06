import { describe, it, expect } from "vitest";
import type { QueryDefinition } from "@/lib/query/types";
import {
  ConvertQueryError,
  convertQueryToRuleSetBody,
  convertedScope,
  convertedWholeRecordLimit,
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

  it("sets seriesScope only for a scoped target, SERIES mirroring includeEpisodes", () => {
    const movieBody = convertQueryToRuleSetBody(makeQuery(), {
      name: "M",
      targetLibraryType: "MOVIE",
      serverIds: ["srv1"],
    });
    expect("seriesScope" in movieBody).toBe(false);

    // Music: artist scope on, the rule set default.
    const musicBody = convertQueryToRuleSetBody(makeQuery({ mediaTypes: ["MUSIC"] }), {
      name: "L",
      targetLibraryType: "MUSIC",
      serverIds: ["srv1"],
    });
    expect(musicBody.seriesScope).toBe(true);

    const seriesAggregate = convertQueryToRuleSetBody(
      makeQuery({ mediaTypes: ["SERIES"], includeEpisodes: false }),
      { name: "S-agg", targetLibraryType: "SERIES", serverIds: ["srv1"] },
    );
    expect(seriesAggregate.seriesScope).toBe(true);

    const seriesEpisodes = convertQueryToRuleSetBody(
      makeQuery({ mediaTypes: ["SERIES"], includeEpisodes: true }),
      { name: "S-ep", targetLibraryType: "SERIES", serverIds: ["srv1"] },
    );
    expect(seriesEpisodes.seriesScope).toBe(false);

    // includeEpisodes undefined defaults to series-aggregate (seriesScope=true)
    const seriesDefault = convertQueryToRuleSetBody(
      makeQuery({ mediaTypes: ["SERIES"] }),
      { name: "S-def", targetLibraryType: "SERIES", serverIds: ["srv1"] },
    );
    expect(seriesDefault.seriesScope).toBe(true);
  });

  describe("a query using a criterion that describes one episode or track", () => {
    const perItem = (field: string, value: string, nested: unknown[] = []) =>
      makeQuery({
        groups: [{
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" },
            { id: "r2", field, operator: "equals", value, condition: "AND" },
          ],
          groups: nested as never,
        }],
      });

    it("becomes a Series rule set with series scope off, even grouped by show, and saves", () => {
      for (const includeEpisodes of [false, undefined, true]) {
        const query = { ...perItem("resolution", "4K"), mediaTypes: ["SERIES" as const], includeEpisodes };
        const body = convertQueryToRuleSetBody(query, { name: "S", targetLibraryType: "SERIES", serverIds: ["srv1"] });
        expect(body.seriesScope).toBe(false);
        expect(ruleSetCreateSchema.safeParse(body).success).toBe(true);
      }
    });

    it("becomes a Music rule set with artist scope off, and saves", () => {
      const query = { ...perItem("audioCodec", "flac"), mediaTypes: ["MUSIC" as const] };
      const body = convertQueryToRuleSetBody(query, { name: "L", targetLibraryType: "MUSIC", serverIds: ["srv1"] });
      expect(body.seriesScope).toBe(false);
      expect(ruleSetCreateSchema.safeParse(body).success).toBe(true);
    });

    it("counts a stream query group", () => {
      const query = {
        ...perItem("title", "x", [{
          id: "sq", condition: "AND", streamQuery: { streamType: "audio", quantifier: "any" },
          rules: [{ id: "s1", field: "sqLanguage", operator: "equals", value: "English", condition: "AND" }], groups: [],
        }]),
        mediaTypes: ["SERIES" as const],
      };
      expect(convertedScope(query, "SERIES", query.groups)).toEqual({ seriesScope: false, blockedLabels: ["Stream Query"] });
    });

    it("says which criteria turned the scope off, for the dialog", () => {
      const query = { ...perItem("resolution", "4K"), mediaTypes: ["SERIES" as const] };
      expect(convertedScope(query, "SERIES", query.groups)).toEqual({ seriesScope: false, blockedLabels: ["Resolution"] });
      // Genre is stored per episode, which can disagree with its show's.
      const genre = { ...perItem("genre", "Drama"), mediaTypes: ["SERIES" as const] };
      expect(convertedScope(genre, "SERIES", genre.groups)).toEqual({ seriesScope: false, blockedLabels: ["Genre"] });
      const showLevel = { ...perItem("arrEnded", "true"), mediaTypes: ["SERIES" as const] };
      expect(convertedScope(showLevel, "SERIES", showLevel.groups)).toEqual({ seriesScope: true, blockedLabels: [] });
      expect(convertedScope({ ...showLevel, includeEpisodes: true }, "SERIES", showLevel.groups)).toEqual({ seriesScope: false, blockedLabels: [] });
      expect(convertedScope(query, "MOVIE", query.groups)).toBeNull();
    });

    it("never arms an action, so no conversion makes a whole-show action follow per-episode criteria", () => {
      const series = { ...perItem("resolution", "4K"), mediaTypes: ["SERIES" as const] };
      const music = { ...perItem("genre", "Rock"), mediaTypes: ["MUSIC" as const] };
      for (const [query, type] of [[series, "SERIES"], [music, "MUSIC"]] as const) {
        const body = convertQueryToRuleSetBody(query, { name: "C", targetLibraryType: type, serverIds: ["srv1"] });
        expect(body.actionEnabled).toBe(false);
        expect("actionType" in body).toBe(false);
        expect(ruleSetCreateSchema.safeParse(body).success).toBe(true);
        // Arming a whole-show or whole-artist action on it is what the save refuses.
        const armed = { ...body, actionEnabled: true, actionType: type === "SERIES" ? "DELETE_SONARR" : "DELETE_LIDARR" };
        const refused = ruleSetCreateSchema.safeParse(armed);
        expect(refused.success).toBe(false);
        expect(refused.error?.issues[0].path).toEqual(["actionType"]);
        // A per-member action saves.
        const perMember = { ...body, actionEnabled: true, actionType: type === "SERIES" ? "DELETE_FILES_SONARR" : "DELETE_FILES_LIDARR" };
        expect(ruleSetCreateSchema.safeParse(perMember).success).toBe(true);
      }
    });

    it("says which criteria keep a whole-show or whole-artist action off, for the dialog", () => {
      // Episode view, show-level criteria only: Play Count is the episode's own there.
      const episodes = { ...perItem("arrEnded", "true"), mediaTypes: ["SERIES" as const], includeEpisodes: true };
      expect(convertedWholeRecordLimit("SERIES", convertedScope(episodes, "SERIES", episodes.groups), episodes.groups)).toEqual(["Play Count"]);
      const resolution = { ...perItem("resolution", "4K"), mediaTypes: ["SERIES" as const] };
      expect(convertedWholeRecordLimit("SERIES", convertedScope(resolution, "SERIES", resolution.groups), resolution.groups)).toEqual([
        "Play Count",
        "Resolution",
      ]);
      // Grouped by show with show-level criteria: the scope is on, nothing is kept off.
      const grouped = { ...perItem("arrEnded", "true"), mediaTypes: ["SERIES" as const] };
      expect(convertedWholeRecordLimit("SERIES", convertedScope(grouped, "SERIES", grouped.groups), grouped.groups)).toBeNull();
      expect(convertedWholeRecordLimit("MOVIE", null, resolution.groups)).toBeNull();
    });

    it("keeps any criterion on a movie rule set, which has no scope", () => {
      const body = convertQueryToRuleSetBody(perItem("resolution", "4K"), { name: "M", targetLibraryType: "MOVIE", serverIds: ["srv1"] });
      expect("seriesScope" in body).toBe(false);
    });
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
    try {
      convertQueryToRuleSetBody(makeQuery(), {
        name: "   ",
        targetLibraryType: "MOVIE",
        serverIds: ["srv1"],
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConvertQueryError);
      expect((err as ConvertQueryError).code).toBe("EMPTY_NAME");
    }
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

  it("throws when the cleaned tree has groups but no rules left", () => {
    // Mixed input: one group with an incompatible rule + one empty
    // placeholder group. After pruning, the first group is dropped and the
    // placeholder is preserved (per fix #2/#3) — but the resulting rule set
    // would have zero effective rules.
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
        { id: "g2", condition: "AND", rules: [], groups: [] },
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

  it("throws when the input tree is structurally valid but has zero rules", () => {
    const query = makeQuery({
      mediaTypes: ["MOVIE"],
      groups: [{ id: "g1", condition: "AND", rules: [], groups: [] }],
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
