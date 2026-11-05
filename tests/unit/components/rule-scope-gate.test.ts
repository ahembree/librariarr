// @vitest-environment happy-dom
/**
 * The rule editor's scope gate (`src/components/rule-scope-gate.tsx`): with
 * "Match against entire series" / "Match against entire artist" on, criteria
 * that describe one episode or track are not allowed. A rule set holding them
 * shows a warning naming them with a one-click way out, and Save is disabled
 * with the reason until it is resolved.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  EvaluationScopeCard,
  SaveRuleSetButton,
  groupScopeBlockedReason,
  type ScopeConfig,
} from "@/components/rule-scope-gate";
import { groupScopeViolation } from "@/lib/conditions/group-scope";
import { RuleBuilder, ruleBuilderConfig } from "@/components/rule-builder";

const SERIES_SCOPE: ScopeConfig = {
  id: "series-scope",
  label: "Match against entire series",
  enabledDescription: "Rules evaluate against aggregated series data",
  disabledDescription: "Rules evaluate against individual episodes",
  ruleSetEnabledLabel: "Series scope",
  ruleSetDisabledLabel: "Episode scope",
};

const ARTIST_SCOPE: ScopeConfig = { ...SERIES_SCOPE, id: "artist-scope", label: "Match against entire artist" };

function groups(fields: string[], streamQuery = false) {
  return [{
    id: "g1",
    condition: "AND" as const,
    rules: fields.map((field, i) => ({ id: `r${i}`, field, operator: "equals", value: "x", condition: "AND" as const })),
    groups: streamQuery
      ? [{ id: "sq", condition: "AND" as const, rules: [], groups: [], streamQuery: { streamType: "audio" as const } }]
      : [],
  }];
}

/**
 * The editor's wiring in miniature: the scope switch, the rules, and Save,
 * each reading the same `groupScopeViolation` the page computes.
 */
function Editor({
  type,
  config,
  rules,
  initialScope = true,
  onSave,
}: {
  type: "SERIES" | "MUSIC";
  config: ScopeConfig;
  rules: ReturnType<typeof groups>;
  initialScope?: boolean;
  onSave: () => void;
}) {
  const [seriesScope, setSeriesScope] = useState(initialScope);
  const violation = groupScopeViolation(type, seriesScope, rules);
  return createElement(
    "div",
    null,
    createElement(EvaluationScopeCard, { config, seriesScope, onSeriesScopeChange: setSeriesScope, violation }),
    createElement(SaveRuleSetButton, {
      blockedReason: violation ? groupScopeBlockedReason(violation) : null,
      disabled: false,
      loading: false,
      justSaved: false,
      onSave,
    }),
  );
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

describe("the rule editor's scope gate", () => {
  it("names the per-episode criteria, disables Save with the reason, and turns series scope off in one click", async () => {
    const onSave = vi.fn();
    render(createElement(Editor, { type: "SERIES", config: SERIES_SCOPE, rules: groups(["playCount", "resolution", "year"], true), onSave }));

    const warning = screen.getByRole("alert");
    expect(warning.textContent).toContain("Per-episode criteria can't judge a whole show");
    for (const label of ["Resolution", "Year", "Stream Query"]) expect(warning.textContent).toContain(label);
    // Play Count is a show-level value: not listed.
    expect(warning.textContent).not.toContain("Play Count");

    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    const trigger = saveButton().closest("span[tabindex='0']") as HTMLElement;
    expect(trigger, "no focusable reason around Save").not.toBeNull();
    await act(async () => trigger.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      `Resolution, Year, Stream Query can't be used with "Match against entire series" on — turn series scope off or remove them first.`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Turn off series scope" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("speaks of tracks and artist scope on a music rule set", () => {
    render(createElement(Editor, { type: "MUSIC", config: ARTIST_SCOPE, rules: groups(["audioCodec"]), onSave: vi.fn() }));
    expect(screen.getByRole("alert").textContent).toContain("Per-track criteria can't judge a whole artist");
    fireEvent.click(screen.getByRole("button", { name: "Turn off artist scope" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("warns as soon as the scope is turned on over per-episode criteria", () => {
    render(createElement(Editor, { type: "SERIES", config: SERIES_SCOPE, rules: groups(["resolution"]), initialScope: false, onSave: vi.fn() }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(screen.getByRole("switch"));

    expect(screen.getByRole("alert").textContent).toContain("Resolution");
    expect(saveButton().disabled).toBe(true);
  });

  it("shows no warning and leaves Save alone for show-level criteria", () => {
    render(createElement(Editor, { type: "SERIES", config: SERIES_SCOPE, rules: groups(["genre", "watchedEpisodePercentage", "arrEnded"]), onSave: vi.fn() }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps Save disabled for the editor's other requirements", () => {
    render(createElement(SaveRuleSetButton, { blockedReason: null, disabled: true, loading: false, justSaved: false, onSave: vi.fn() }));
    expect(saveButton().disabled).toBe(true);
  });
});

describe("the rule builder with the scope on", () => {
  const ctx = (groupScope: "SERIES" | "MUSIC" | null) => ({ libraryType: groupScope ?? "SERIES", groupScope });

  it("offers per-episode fields disabled, with the reason", () => {
    expect(ruleBuilderConfig.isFieldDisabled("resolution", ctx("SERIES"))).toBe(true);
    expect(ruleBuilderConfig.getDisabledTooltip("resolution", ctx("SERIES"))).toBe(
      `Describes one episode, not the whole show — turn off "Match against entire series" to use it`,
    );
    expect(ruleBuilderConfig.isFieldDisabled("audioCodec", ctx("MUSIC"))).toBe(true);
    expect(ruleBuilderConfig.getDisabledTooltip("audioCodec", ctx("MUSIC"))).toBe(
      `Describes one track, not the whole artist — turn off "Match against entire artist" to use it`,
    );
  });

  it("flags a rule already using one", () => {
    expect(ruleBuilderConfig.getFieldUnreachableTooltip?.("year", ctx("SERIES"))).toMatch(/^Describes one episode/);
    expect(ruleBuilderConfig.getFieldUnreachableTooltip?.("year", ctx(null))).toBeNull();
  });

  it("leaves show-level fields, and every field with the scope off, as they were", () => {
    expect(ruleBuilderConfig.isFieldDisabled("genre", ctx("SERIES"))).toBe(false);
    expect(ruleBuilderConfig.isFieldDisabled("playCount", ctx("MUSIC"))).toBe(false);
    expect(ruleBuilderConfig.isFieldDisabled("resolution", ctx(null))).toBe(false);
    expect(ruleBuilderConfig.getDisabledTooltip("resolution", ctx(null))).toBeNull();
  });

  it("renders Stream Query disabled with the reason while the scope is on, and enabled with it off", async () => {
    const groups = [{ id: "g1", condition: "AND" as const, rules: [{ id: "r1", field: "genre", operator: "equals", value: "Drama", condition: "AND" as const }], groups: [] }];
    const onChange = vi.fn();
    const { rerender } = render(createElement(RuleBuilder, { groups, onChange, libraryType: "SERIES", groupScope: "SERIES" }));

    const button = screen.getByRole("button", { name: "Stream Query" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
    const trigger = button.closest("span[tabindex='0']") as HTMLElement;
    await act(async () => trigger.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      `Stream queries read one episode's tracks — turn off "Match against entire series" to use them`,
    );

    rerender(createElement(RuleBuilder, { groups, onChange, libraryType: "SERIES", groupScope: null }));
    const enabled = screen.getByRole("button", { name: "Stream Query" }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not offer a stream query, saying why", () => {
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx("SERIES"))).toBe(
      `Stream queries read one episode's tracks — turn off "Match against entire series" to use them`,
    );
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx("MUSIC"))).toBe(
      `Stream queries read one track's streams — turn off "Match against entire artist" to use them`,
    );
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx(null))).toBeNull();
  });
});
