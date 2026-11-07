/**
 * The action Preview, Test Media and the Match Changes Preview judge an
 * unsaved rule set with (`src/lib/lifecycle/editor-action.ts`): the editor's
 * own, a field it leaves out read from the stored rule set, else no action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { ruleSet: { findFirst } } }));

import { editorScopeAction, loadEditorScopeAction } from "@/lib/lifecycle/editor-action";

const STORED = {
  actionEnabled: true,
  actionType: "DELETE_SONARR",
  addArrTags: ["stored-add"],
  removeArrTags: ["stored-remove"],
  searchAfterAction: true,
};
const NONE = { actionEnabled: false, actionType: null, addArrTags: [], removeArrTags: [], searchAfterAction: false };

describe("editorScopeAction", () => {
  it("takes the editor's action whole", () => {
    const body = { actionEnabled: false, actionType: "DELETE_FILES_SONARR", addArrTags: [], removeArrTags: ["x"], searchAfterAction: false };
    expect(editorScopeAction(body, STORED)).toEqual(body);
  });

  it("reads a field the editor leaves out from the stored rule set", () => {
    expect(editorScopeAction({ actionType: "DELETE_FILES_SONARR" }, STORED)).toEqual({ ...STORED, actionType: "DELETE_FILES_SONARR" });
    // An explicit null type is the editor's, not a gap.
    expect(editorScopeAction({ actionType: null }, STORED).actionType).toBeNull();
  });

  it("reads no action when neither has one", () => {
    expect(editorScopeAction({}, null)).toEqual(NONE);
  });
});

describe("loadEditorScopeAction", () => {
  beforeEach(() => findFirst.mockReset());

  it("reads the stored rule set — the user's own — only for the fields the request leaves out", async () => {
    findFirst.mockResolvedValue(STORED);
    expect(await loadEditorScopeAction("u1", { actionType: "UNMONITOR_SONARR" }, "rs1")).toEqual({ ...STORED, actionType: "UNMONITOR_SONARR" });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rs1", userId: "u1" } }));
  });

  it("does not read it when the request carries the whole action, or names no rule set", async () => {
    const whole = { actionEnabled: true, actionType: "DELETE_SONARR", addArrTags: [], removeArrTags: [], searchAfterAction: false };
    expect(await loadEditorScopeAction("u1", whole, "rs1")).toEqual(whole);
    expect(await loadEditorScopeAction("u1", {}, undefined)).toEqual(NONE);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("reads no action for a rule set that is not the user's", async () => {
    findFirst.mockResolvedValue(null);
    expect(await loadEditorScopeAction("u1", {}, "someone-elses")).toEqual(NONE);
  });
});
