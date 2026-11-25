import { describe, it, expect, vi } from "vitest";

const engine = vi.hoisted(() => ({
  evaluateLifecycleRules: vi.fn(async () => [{ id: "raw" }]),
  evaluateSeriesScope: vi.fn(async () => [{ id: "series" }]),
  evaluateMusicScope: vi.fn(async () => [{ id: "music" }]),
  groupSeriesResults: vi.fn(() => [{ id: "grouped" }]),
  hasEpisodeLevelRules: vi.fn(() => false),
  hasSeriesAggregateRules: vi.fn(() => false),
}));
vi.mock("@/lib/rules/lifecycle-engine", () => engine);

import { evaluateEditorRuleSet } from "@/lib/lifecycle/editor-evaluation";

const rules = [{ id: "r", field: "year", operator: "lessThan", value: 2000, condition: "AND" }] as never;
const base = { rules, serverIds: ["s1"], excludeRuleSetId: "rs1" };

describe("evaluateEditorRuleSet", () => {
  it("evaluates movies one by one", async () => {
    expect(await evaluateEditorRuleSet({ ...base, type: "MOVIE" })).toEqual([{ id: "raw" }]);
    expect(engine.evaluateLifecycleRules).toHaveBeenCalledWith(rules, "MOVIE", ["s1"], undefined, undefined, { excludeRuleSetId: "rs1" });
  });

  it("evaluates whole shows with series scope on or left out", async () => {
    for (const seriesScope of [true, undefined]) {
      engine.evaluateSeriesScope.mockClear();
      expect(await evaluateEditorRuleSet({ ...base, type: "SERIES", seriesScope })).toEqual([{ id: "series" }]);
      expect(engine.evaluateSeriesScope).toHaveBeenCalledWith(rules, ["s1"], undefined, undefined, false, { excludeRuleSetId: "rs1" });
    }
  });

  it("forces the series path for a series-aggregate field with series scope off", async () => {
    engine.hasSeriesAggregateRules.mockReturnValueOnce(true);
    await evaluateEditorRuleSet({ ...base, type: "SERIES", seriesScope: false });
    expect(engine.evaluateSeriesScope).toHaveBeenCalledWith(rules, ["s1"], undefined, undefined, true, { excludeRuleSetId: "rs1" });
  });

  it("groups per-episode results by show with series scope off", async () => {
    engine.hasEpisodeLevelRules.mockReturnValueOnce(true);
    expect(await evaluateEditorRuleSet({ ...base, type: "SERIES", seriesScope: false })).toEqual([{ id: "grouped" }]);
    expect(engine.groupSeriesResults).toHaveBeenCalledWith([{ id: "raw" }], { summarizeEpisodeFields: true });
  });

  it("evaluates whole artists with artist scope on, tracks with it off", async () => {
    expect(await evaluateEditorRuleSet({ ...base, type: "MUSIC" })).toEqual([{ id: "music" }]);
    expect(await evaluateEditorRuleSet({ ...base, type: "MUSIC", seriesScope: false })).toEqual([{ id: "raw" }]);
  });
});
