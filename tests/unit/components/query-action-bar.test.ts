// @vitest-environment happy-dom
/**
 * The Query page's action bar (`src/components/query-action-bar.tsx`) under
 * the group-scope gate: a query judges each episode and track on its own, so
 * an action on the whole Sonarr series or Lidarr artist can't follow the
 * run's criteria of one episode or track. Such actions are offered disabled
 * with the reason the server refuses them with, as are the tag pickers and
 * Lidarr's Search after, and Run is off while the chosen action would break
 * it; actions on the matched members stay available.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryActionBar } from "@/components/query-action-bar";
import { queryActionScopeError, queryActionScopeViolation } from "@/lib/query/action-scope";

// Radix Select measures and scrolls its items, which happy-dom does not.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

function groups(fields: string[]) {
  return [{
    id: "g", condition: "AND", groups: [],
    rules: fields.map((field, i) => ({ id: `r${i}`, field, operator: "equals", value: "x", condition: "AND" })),
  }];
}

const META = { qualityProfiles: [{ id: 1, name: "HD" }], tags: ["keep"] };

function bar(props: { criteria: unknown; episodeMode?: boolean; type?: "SERIES" | "MUSIC"; onExecute?: () => void }) {
  const type = props.type ?? "SERIES";
  return createElement(QueryActionBar, {
    selectedCount: 2,
    selectedSize: 0,
    selectionTypeCounts: { MOVIE: 0, SERIES: type === "SERIES" ? 2 : 0, MUSIC: type === "MUSIC" ? 2 : 0 },
    arrServerIds: type === "SERIES" ? { sonarr: "sonarr-1" } : { lidarr: "lidarr-1" },
    arrMeta: { radarr: META, sonarr: META, lidarr: META },
    executing: false,
    onExecute: props.onExecute ?? vi.fn(),
    onClear: vi.fn(),
    criteria: props.criteria,
    episodeMode: props.episodeMode ?? false,
  });
}

/** Opens the action picker and answers each option's label and whether it is disabled. */
async function pickerOptions(): Promise<Record<string, boolean>> {
  const trigger = screen.getByRole("combobox");
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const options = await screen.findAllByRole("option");
  return Object.fromEntries(options.map((o) => [o.textContent ?? "", o.getAttribute("aria-disabled") === "true" || o.hasAttribute("data-disabled")]));
}

async function choose(label: string) {
  await pickerOptions();
  await act(async () => fireEvent.click(screen.getByRole("option", { name: label })));
  // The picker hands focus back to its trigger once it has closed.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function reasonOn(control: HTMLElement): Promise<string | null> {
  const trigger = control.closest("span[tabindex='0']") as HTMLElement;
  expect(trigger, "no focusable reason around the control").not.toBeNull();
  await act(async () => trigger.focus());
  return (await screen.findByRole("tooltip")).textContent;
}

function runButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Run Action" }) as HTMLButtonElement;
}

const FOURK = groups(["resolution"]);
const reasonFor = (type: "SERIES" | "MUSIC", criteria: unknown, actionType: string, extra: Record<string, unknown> = {}) =>
  queryActionScopeError(queryActionScopeViolation(type, criteria, false, { actionType, ...extra })!);

describe("the Query action bar's scope gate", () => {
  it("offers the whole-show actions disabled under a per-episode criterion, with the server's reason", async () => {
    render(bar({ criteria: FOURK }));
    expect(await pickerOptions()).toEqual({
      "Do Nothing (tags only)": true,
      "Delete from Sonarr": true,
      "Unmonitor & Delete Files": true,
      "Monitor & Delete Files": true,
      "Delete Files Only": false,
      // Grouped by show, these act on the whole series.
      "Unmonitor Only": true,
      "Change Quality Profile": true,
      "Search for New Copy": true,
    });
    expect(screen.getByRole("option", { name: "Delete from Sonarr" }).getAttribute("title")).toBe(reasonFor("SERIES", FOURK, "DELETE_SONARR"));
  });

  it("offers Unmonitor Only and Search for New Copy in episode view, where they act on the selected episodes", async () => {
    render(bar({ criteria: FOURK, episodeMode: true }));
    const options = await pickerOptions();
    expect(options["Unmonitor Only"]).toBe(false);
    expect(options["Search for New Copy"]).toBe(false);
    expect(options["Delete from Sonarr"]).toBe(true);
  });

  it("offers every action on criteria every episode of a show answers alike", async () => {
    render(bar({ criteria: groups(["parentTitle", "availableEpisodeCount"]) }));
    expect(Object.values(await pickerOptions()).every((disabled) => !disabled)).toBe(true);
  });

  it("keeps a file delete runnable but its tags off, with the reason", async () => {
    const onExecute = vi.fn();
    render(bar({ criteria: FOURK, onExecute }));
    await choose("Delete Files Only");
    const addTags = screen.getByRole("button", { name: /Add tags/ }) as HTMLButtonElement;
    expect(addTags.disabled).toBe(true);
    expect(await reasonOn(addTags)).toBe(reasonFor("SERIES", FOURK, "DELETE_FILES_SONARR", { addArrTags: ["tag"] }));
    expect(runButton().disabled).toBe(false);

    await act(async () => fireEvent.click(runButton()));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run action" })));
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ actionType: "DELETE_FILES_SONARR", addArrTags: [], removeArrTags: [] }));
  });

  it("turns Lidarr's Search after off under a per-track criterion", async () => {
    const mp3 = groups(["audioCodec"]);
    render(bar({ criteria: mp3, type: "MUSIC" }));
    await choose("Delete Files Only");
    const searchAfter = screen.getByRole("checkbox") as HTMLButtonElement;
    expect(searchAfter.disabled).toBe(true);
    expect(await reasonOn(searchAfter)).toBe(reasonFor("MUSIC", mp3, "DELETE_FILES_LIDARR", { searchAfterAction: true }));
  });

  it("turns Run off with the reason when a re-run brings a per-episode criterion under the chosen action", async () => {
    const view = render(bar({ criteria: groups(["parentTitle"]) }));
    await choose("Delete from Sonarr");
    expect(runButton().disabled).toBe(false);

    view.rerender(bar({ criteria: FOURK }));
    expect(runButton().disabled).toBe(true);
    expect(await reasonOn(runButton())).toBe(reasonFor("SERIES", FOURK, "DELETE_SONARR"));
  });
});
