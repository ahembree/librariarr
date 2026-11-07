// @vitest-environment happy-dom
/**
 * The rule editor's gate (`src/components/rule-scope-gate.tsx`): a criterion
 * that describes one episode or track may never make a whole show or artist
 * the target of an action. With "Match against entire series" / "Match
 * against entire artist" on, such criteria are not allowed; with the scope
 * off, an action on the whole show or artist (Delete from Sonarr, Arr tags,
 * …) may not follow them. A rule set breaking it shows a warning naming them
 * with the valid ways out, the picker offers the actions that would break it
 * disabled, and Save is disabled with the reason until it is resolved.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  ActionTypeSelect,
  EvaluationScopeCard,
  PreviewRuleSetButton,
  SaveRuleSetButton,
  TestMediaButton,
  actionTypeOptionStates,
  groupScopeBlockedReason,
  wholeRecordSwitchReason,
  type ScopeConfig,
} from "@/components/rule-scope-gate";
import { groupScopeViolation, type GroupScopeAction } from "@/lib/conditions/group-scope";
import { MUSIC_ACTION_TYPES, SERIES_ACTION_TYPES } from "@/lib/lifecycle/action-types";
import { RuleBuilder, groupScopeGateOf, ruleBuilderConfig } from "@/components/rule-builder";

// Radix Select measures and scrolls its items, which happy-dom does not.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

const SERIES_SCOPE: ScopeConfig = {
  id: "series-scope",
  label: "Match against entire series",
  enabledDescription: "Rules evaluate against aggregated series data",
  disabledDescription: "Rules evaluate against individual episodes",
  ruleSetEnabledLabel: "Series scope",
  ruleSetDisabledLabel: "Episode scope",
};

const ARTIST_SCOPE: ScopeConfig = { ...SERIES_SCOPE, id: "artist-scope", label: "Match against entire artist" };

const DELETE_SERIES: GroupScopeAction = { actionEnabled: true, actionType: "DELETE_SONARR", addArrTags: [], removeArrTags: [] };
const DELETE_FILES: GroupScopeAction = { ...DELETE_SERIES, actionType: "DELETE_FILES_SONARR" };

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
 * The editor's wiring in miniature: the scope switch, the rules, the action,
 * and Save, each reading the same `groupScopeViolation` the page computes.
 */
function Editor({
  type,
  config,
  rules,
  initialScope = true,
  initialAction = null,
  onSave,
}: {
  type: "SERIES" | "MUSIC";
  config: ScopeConfig;
  rules: ReturnType<typeof groups>;
  initialScope?: boolean;
  initialAction?: GroupScopeAction | null;
  onSave: () => void;
}) {
  const [seriesScope, setSeriesScope] = useState(initialScope);
  const [action, setAction] = useState(initialAction);
  const violation = groupScopeViolation(type, seriesScope, rules, action);
  return createElement(
    "div",
    null,
    createElement(EvaluationScopeCard, { config, seriesScope, onSeriesScopeChange: setSeriesScope, violation }),
    createElement(ActionTypeSelect, {
      value: action?.actionType ?? "DO_NOTHING",
      onValueChange: (actionType: string) => setAction({ ...(action ?? DELETE_FILES), actionType }),
      options: actionTypeOptionStates(type, seriesScope, rules, type === "SERIES" ? SERIES_ACTION_TYPES : MUSIC_ACTION_TYPES, true),
    }),
    createElement(SaveRuleSetButton, {
      blockedReason: violation ? groupScopeBlockedReason(violation) : null,
      disabled: false,
      loading: false,
      justSaved: false,
      onSave,
    }),
    createElement(PreviewRuleSetButton, {
      blockedReason: violation ? groupScopeBlockedReason(violation) : null,
      disabled: false,
      loading: false,
      onPreview: vi.fn(),
    }),
    createElement(TestMediaButton, {
      blockedReason: violation ? groupScopeBlockedReason(violation) : null,
      disabled: false,
      onTest: vi.fn(),
    }),
  );
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

async function reasonOn(button: HTMLElement): Promise<string | null> {
  const trigger = button.closest("span[tabindex='0']") as HTMLElement;
  expect(trigger, "no focusable reason around the control").not.toBeNull();
  await act(async () => trigger.focus());
  return (await screen.findByRole("tooltip")).textContent;
}

/** Opens the action picker and answers each option's label and whether it is disabled. */
async function pickerOptions(): Promise<Record<string, boolean>> {
  const trigger = screen.getByRole("combobox", { name: "Action type" });
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const options = await screen.findAllByRole("option");
  return Object.fromEntries(options.map((o) => [o.textContent ?? "", o.getAttribute("aria-disabled") === "true" || o.hasAttribute("data-disabled")]));
}

describe("the rule editor's scope gate", () => {
  it("names the per-episode criteria, disables Save with the reason, and turns series scope off in one click", async () => {
    const onSave = vi.fn();
    render(createElement(Editor, { type: "SERIES", config: SERIES_SCOPE, rules: groups(["playCount", "resolution", "year"], true), onSave }));

    const warning = screen.getAllByRole("alert")[0];
    expect(warning.textContent).toContain("Per-episode criteria can't judge a whole show");
    for (const label of ["Resolution", "Year", "Stream Query"]) expect(warning.textContent).toContain(label);
    // Play Count is a show-level value: not listed.
    expect(warning.textContent).not.toContain("Play Count");

    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(await reasonOn(saveButton())).toBe(
      `Resolution, Year, Stream Query can't be used with "Match against entire series" on — turn series scope off or remove them first.`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Turn off series scope" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("speaks of tracks and artist scope on a music rule set, and blocks a track's genre", () => {
    render(createElement(Editor, { type: "MUSIC", config: ARTIST_SCOPE, rules: groups(["genre"]), onSave: vi.fn() }));
    expect(screen.getByRole("alert").textContent).toContain("Per-track criteria can't judge a whole artist");
    expect(screen.getByRole("alert").textContent).toContain("Genre");
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
    render(createElement(Editor, { type: "SERIES", config: SERIES_SCOPE, rules: groups(["playCount", "watchedEpisodePercentage", "arrEnded"]), onSave: vi.fn() }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps Save disabled for the editor's other requirements", () => {
    render(createElement(SaveRuleSetButton, { blockedReason: null, disabled: true, loading: false, justSaved: false, onSave: vi.fn() }));
    expect(saveButton().disabled).toBe(true);
  });
});

describe("a whole-show action following per-episode criteria", () => {
  it("is blocked with the scope off: the warning names the action and the ways out, Save is off", async () => {
    const onSave = vi.fn();
    render(createElement(Editor, {
      type: "SERIES", config: SERIES_SCOPE, rules: groups(["resolution"]), initialScope: false, initialAction: DELETE_SERIES, onSave,
    }));

    const warning = screen.getByRole("alert");
    expect(warning.textContent).toContain("Per-episode criteria can't decide a whole-show action");
    expect(warning.textContent).toContain("“Delete from Sonarr” acts on the whole show");
    expect(warning.textContent).toContain("switch to an action that acts only on the matched episodes (Delete Files Only, Unmonitor & Delete Files, Unmonitor Only or Search for New Copy, without Arr tags)");
    expect(warning.textContent).toContain("Resolution");
    // Turning series scope on would not do: Resolution describes one episode there too.
    expect(screen.queryByRole("button", { name: /Turn (on|off) series scope/ })).toBeNull();

    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(await reasonOn(saveButton())).toBe(
      `Resolution can't decide "Delete from Sonarr", which acts on the whole show — remove them or pick an action that acts only on the matched episodes.`,
    );
  });

  it("keeps Preview and Test Media off with the same reason, as their routes refuse it", async () => {
    render(createElement(Editor, {
      type: "SERIES", config: SERIES_SCOPE, rules: groups(["resolution"]), initialScope: false, initialAction: DELETE_SERIES, onSave: vi.fn(),
    }));
    const reason = `Resolution can't decide "Delete from Sonarr", which acts on the whole show — remove them or pick an action that acts only on the matched episodes.`;
    for (const name of ["Preview", "Test Media"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled, name).toBe(true);
    }
    expect(await reasonOn(screen.getByRole("button", { name: "Preview" }))).toBe(reason);
  });

  it("turns Preview and Test Media on again once the action acts on the matched episodes", async () => {
    render(createElement(Editor, {
      type: "SERIES", config: SERIES_SCOPE, rules: groups(["resolution"]), initialScope: false, initialAction: DELETE_SERIES, onSave: vi.fn(),
    }));
    await pickerOptions();
    await act(async () => fireEvent.click(screen.getByRole("option", { name: "Delete Files Only" })));
    for (const name of ["Preview", "Test Media"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(false);
    }
  });

  it("is resolved by switching to a per-episode action, which the picker offers while whole-show ones are off", async () => {
    render(createElement(Editor, {
      type: "SERIES", config: SERIES_SCOPE, rules: groups(["resolution"]), initialScope: false, initialAction: DELETE_SERIES, onSave: vi.fn(),
    }));

    const options = await pickerOptions();
    expect(options).toEqual({
      "Do Nothing": false,
      "Delete from Sonarr": true,
      "Unmonitor & Delete Files": false,
      "Monitor & Delete Files": true,
      "Delete Files Only": false,
      "Unmonitor Only": false,
      "Change Quality Profile": true,
      "Search for New Copy": false,
    });
    expect(screen.getByRole("option", { name: "Delete from Sonarr" }).getAttribute("title")).toBe(
      `"Delete from Sonarr" acts on the whole show, so with series scope off it can't follow per-episode criteria (Resolution) — remove them first.`,
    );

    await act(async () => fireEvent.click(screen.getByRole("option", { name: "Delete Files Only" })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("offers turning series scope on when the whole show answers every criterion", () => {
    render(createElement(Editor, {
      type: "SERIES", config: SERIES_SCOPE, rules: groups(["playCount", "arrEnded"]), initialScope: false, initialAction: DELETE_SERIES, onSave: vi.fn(),
    }));
    expect(screen.getByRole("alert").textContent).toContain("Play Count");
    fireEvent.click(screen.getByRole("button", { name: "Turn on series scope" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("does not offer turning series scope off while the action acts on the whole show", () => {
    render(createElement(Editor, {
      type: "SERIES", config: SERIES_SCOPE, rules: groups(["resolution"]), initialAction: DELETE_SERIES, onSave: vi.fn(),
    }));
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toContain("Per-episode criteria can't judge a whole show");
    expect(warning.textContent).toContain("“Delete from Sonarr” acts on the whole show with series scope off too");
    expect(screen.queryByRole("button", { name: "Turn off series scope" })).toBeNull();
  });

  it("speaks of tracks and artists for a Lidarr action", () => {
    render(createElement(Editor, {
      type: "MUSIC", config: ARTIST_SCOPE, rules: groups(["genre"]), initialScope: false,
      initialAction: { ...DELETE_SERIES, actionType: "DELETE_LIDARR" }, onSave: vi.fn(),
    }));
    expect(screen.getByRole("alert").textContent).toContain(`Per-track criteria can't decide a whole-artist action`);
    expect(saveButton().disabled).toBe(true);
  });
});

describe("the action picker and the switches that make an action act on the whole record", () => {
  it("offers every action with the scope on or without per-episode criteria", () => {
    for (const [scope, fields] of [[true, ["resolution"]], [false, ["arrEnded"]]] as const) {
      const states = actionTypeOptionStates("SERIES", scope, groups([...fields]), SERIES_ACTION_TYPES, true);
      expect(states.every((s) => s.disabledReason === null)).toBe(true);
    }
  });

  it("keeps the Arr requirement", () => {
    const states = actionTypeOptionStates("SERIES", true, groups(["playCount"]), SERIES_ACTION_TYPES, false);
    expect(states.find((s) => s.value === "DELETE_SONARR")?.disabledReason).toBe("Select an Arr server above to enable this action");
    expect(states.find((s) => s.value === "DO_NOTHING")?.disabledReason).toBeNull();
  });

  it("offers every Lidarr action but the file delete and Do Nothing disabled under per-track criteria", () => {
    const states = actionTypeOptionStates("MUSIC", false, groups(["audioCodec"]), MUSIC_ACTION_TYPES, true);
    expect(states.filter((s) => s.disabledReason === null).map((s) => s.value)).toEqual(["DO_NOTHING", "DELETE_FILES_LIDARR"]);
  });

  it("says why Arr tags and Lidarr's search after are off", () => {
    expect(wholeRecordSwitchReason("SERIES", false, groups(["resolution"]), "Arr tags")).toBe(
      `"Arr tags" acts on the whole show, so with series scope off it can't follow per-episode criteria (Resolution) — remove them first.`,
    );
    expect(wholeRecordSwitchReason("MUSIC", false, groups(["playCount"]), "Search after")).toBe(
      `"Search after" acts on the whole artist, so with artist scope off it can't follow per-track criteria (Play Count) — remove them first, or turn artist scope on.`,
    );
    expect(wholeRecordSwitchReason("SERIES", true, groups(["playCount"]), "Arr tags")).toBeNull();
    expect(wholeRecordSwitchReason("SERIES", false, groups(["arrEnded"]), "Arr tags")).toBeNull();
    expect(wholeRecordSwitchReason("MOVIE", false, groups(["resolution"]), "Arr tags")).toBeNull();
  });
});

describe("the rule builder's gate", () => {
  const ctx = (gate: ReturnType<typeof groupScopeGateOf>) => ({ libraryType: gate?.type ?? "SERIES", groupScope: gate });
  const series = groupScopeGateOf("SERIES", true, null);
  const artist = groupScopeGateOf("MUSIC", true, null);

  it("offers per-episode fields disabled, with the reason, while the scope is on", () => {
    expect(ruleBuilderConfig.isFieldDisabled("resolution", ctx(series))).toBe(true);
    expect(ruleBuilderConfig.getDisabledTooltip("resolution", ctx(series))).toBe(
      `Describes one episode, not the whole show — turn off "Match against entire series" to use it`,
    );
    expect(ruleBuilderConfig.isFieldDisabled("genre", ctx(series))).toBe(true);
    expect(ruleBuilderConfig.isFieldDisabled("audioCodec", ctx(artist))).toBe(true);
    expect(ruleBuilderConfig.getDisabledTooltip("audioCodec", ctx(artist))).toBe(
      `Describes one track, not the whole artist — turn off "Match against entire artist" to use it`,
    );
  });

  it("says to pick a per-episode action too while the action acts on the whole show", () => {
    expect(ruleBuilderConfig.getDisabledTooltip("resolution", ctx(groupScopeGateOf("SERIES", true, DELETE_SERIES)))).toBe(
      `Describes one episode, not the whole show — turn off "Match against entire series" and pick an action that acts only on the matched episodes to use it`,
    );
  });

  it("offers per-episode fields disabled with the scope off under a whole-show action", () => {
    const gate = groupScopeGateOf("SERIES", false, DELETE_SERIES);
    expect(gate).toEqual({ type: "SERIES", judgement: "member", wholeRecordAction: "Delete from Sonarr" });
    expect(ruleBuilderConfig.isFieldDisabled("resolution", ctx(gate))).toBe(true);
    expect(ruleBuilderConfig.getDisabledTooltip("resolution", ctx(gate))).toBe(
      `Describes one episode, and "Delete from Sonarr" acts on the whole show — pick an action that acts only on the matched episodes to use it`,
    );
    // The episode's own play count — the show's total with the scope on.
    expect(ruleBuilderConfig.isFieldDisabled("playCount", ctx(gate))).toBe(true);
    expect(ruleBuilderConfig.getDisabledTooltip("playCount", ctx(gate))).toBe(
      `Describes one episode, and "Delete from Sonarr" acts on the whole show — turn on "Match against entire series" to judge the whole show by it, or pick an action that acts only on the matched episodes`,
    );
    // The show's own: Arr, the aggregates, its name.
    for (const field of ["arrEnded", "watchedEpisodePercentage", "parentTitle", "seerrRequested"]) {
      expect(ruleBuilderConfig.isFieldDisabled(field, ctx(gate)), field).toBe(false);
    }
  });

  it("gates nothing with the scope off under an action on the matched episodes", () => {
    expect(groupScopeGateOf("SERIES", false, DELETE_FILES)).toBeNull();
    expect(groupScopeGateOf("SERIES", false, null)).toBeNull();
    expect(groupScopeGateOf("MOVIE", true, DELETE_SERIES)).toBeNull();
  });

  it("flags a rule already using one", () => {
    expect(ruleBuilderConfig.getFieldUnreachableTooltip?.("year", ctx(series))).toMatch(/^Describes one episode/);
    expect(ruleBuilderConfig.getFieldUnreachableTooltip?.("year", ctx(null))).toBeNull();
  });

  it("leaves show-level fields, and every field ungated, as they were", () => {
    expect(ruleBuilderConfig.isFieldDisabled("playCount", ctx(series))).toBe(false);
    expect(ruleBuilderConfig.isFieldDisabled("playCount", ctx(artist))).toBe(false);
    expect(ruleBuilderConfig.isFieldDisabled("resolution", ctx(null))).toBe(false);
    expect(ruleBuilderConfig.getDisabledTooltip("resolution", ctx(null))).toBeNull();
  });

  it("renders Stream Query disabled with the reason while gated, and enabled when not", async () => {
    const rules = [{ id: "g1", condition: "AND" as const, rules: [{ id: "r1", field: "arrEnded", operator: "equals", value: "true", condition: "AND" as const }], groups: [] }];
    const onChange = vi.fn();
    const { rerender } = render(createElement(RuleBuilder, { groups: rules, onChange, libraryType: "SERIES", groupScope: series }));

    const button = screen.getByRole("button", { name: "Stream Query" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
    expect(await reasonOn(button)).toBe(
      `Stream queries read one episode's tracks — turn off "Match against entire series" to use them`,
    );

    rerender(createElement(RuleBuilder, { groups: rules, onChange, libraryType: "SERIES", groupScope: null }));
    const enabled = screen.getByRole("button", { name: "Stream Query" }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not offer a stream query, saying why", () => {
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx(series))).toBe(
      `Stream queries read one episode's tracks — turn off "Match against entire series" to use them`,
    );
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx(artist))).toBe(
      `Stream queries read one track's streams — turn off "Match against entire artist" to use them`,
    );
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx(groupScopeGateOf("SERIES", false, DELETE_SERIES)))).toBe(
      `Stream queries read one episode's tracks, and "Delete from Sonarr" acts on the whole show — pick an action that acts only on the matched episodes to use them`,
    );
    expect(ruleBuilderConfig.getStreamQueryDisabledTooltip?.(ctx(null))).toBeNull();
  });
});
