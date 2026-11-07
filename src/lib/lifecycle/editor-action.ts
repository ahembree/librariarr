/**
 * The action an unsaved rule set is judged with where the rule editor
 * evaluates it for display — Preview, Test Media and the Match Changes
 * Preview (the rule diff).
 *
 * A criterion whose value belongs to one episode or track may never make a
 * whole show or artist an action's target (`groupScopeViolation`): with the
 * scope off, that depends on the action — Delete from Sonarr may not follow
 * "Resolution = 4K", Delete Files Only may. Saving, detection and execution
 * judge the rule set's action; these routes judge the one the editor holds,
 * so they refuse what a save would refuse, with the reason detection gives
 * (`checkLifecycleRuleEvaluability`'s seventh argument).
 *
 * The editor sends its whole action. A field the request leaves out reads as
 * the stored rule set's (`ruleSetId`, one of the user's), else as no action.
 */
import { prisma } from "@/lib/db";
import type { GroupScopeAction } from "@/lib/conditions/group-scope";
import { HOLD_ACTION_SELECT } from "@/lib/lifecycle/held-actions";

/** The action fields the editor sends with Preview, Test Media and the rule diff. */
export interface EditorActionFields {
  actionEnabled?: boolean;
  actionType?: string | null;
  addArrTags?: string[];
  removeArrTags?: string[];
  searchAfterAction?: boolean;
}

const EDITOR_ACTION_KEYS = ["actionEnabled", "actionType", "addArrTags", "removeArrTags", "searchAfterAction"] as const;

/**
 * The editor's action, each field it leaves out taken from `stored` (the rule
 * set being edited) or, with none, read as no action: off, no type, no tags.
 */
export function editorScopeAction(body: EditorActionFields, stored: GroupScopeAction | null | undefined): GroupScopeAction {
  return {
    actionEnabled: body.actionEnabled ?? stored?.actionEnabled ?? false,
    actionType: body.actionType !== undefined ? body.actionType : (stored?.actionType ?? null),
    addArrTags: body.addArrTags ?? stored?.addArrTags ?? [],
    removeArrTags: body.removeArrTags ?? stored?.removeArrTags ?? [],
    searchAfterAction: body.searchAfterAction ?? stored?.searchAfterAction ?? false,
  };
}

/**
 * `editorScopeAction` for a request that names the rule set it edits by id:
 * the stored rule set (the user's own) is read only when the request leaves a
 * field out.
 */
export async function loadEditorScopeAction(
  userId: string,
  body: EditorActionFields,
  ruleSetId: string | null | undefined,
): Promise<GroupScopeAction> {
  const complete = EDITOR_ACTION_KEYS.every((key) => body[key] !== undefined);
  const stored = complete || !ruleSetId
    ? null
    : await prisma.ruleSet.findFirst({ where: { id: ruleSetId, userId }, select: HOLD_ACTION_SELECT });
  return editorScopeAction(body, stored);
}
