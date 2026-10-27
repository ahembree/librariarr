import { NextRequest, NextResponse } from "next/server";
import { withSession, type LoggedInSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeAction, extractActionError, describeActionError } from "@/lib/lifecycle/actions";
import { actionTargetTitle } from "@/lib/lifecycle/action-target";
import { loadMemberEpisodes } from "@/lib/lifecycle/member-episodes";
import {
  tryBeginExecute,
  endExecute,
  tryBeginRuleSetExecution,
  endRuleSetExecution,
} from "@/lib/lifecycle/execute-in-flight";
import {
  findExceptedItemIds,
  findExceptionProtectedGroups,
  isGroupProtected,
  hasProtectionGroup,
  isWholeRecordDestructiveAction,
} from "@/lib/lifecycle/exception-guard";
import { matchIdentityChange } from "@/lib/lifecycle/match-identity";
import { arrIdSourceFor } from "@/lib/lifecycle/cross-server-copies";
import { hasSeerrRules } from "@/lib/rules/lifecycle-engine";
import { actionHonorsMemberIds } from "@/lib/lifecycle/action-types";
import { memberIdsFromItemData } from "@/lib/lifecycle/group-aggregate";
import type { LifecycleRuleGroup } from "@/lib/rules/types";
import type { Prisma } from "@/generated/prisma/client";

export const DELETE = withSession(async (
  session,
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const action = await prisma.lifecycleAction.findUnique({
    where: { id },
  });

  if (!action || action.userId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (action.status !== "FAILED") {
    return NextResponse.json(
      { error: "Only failed actions can be removed" },
      { status: 400 }
    );
  }

  await prisma.lifecycleAction.delete({ where: { id } });
  return NextResponse.json({ action: null });
});

// Force-retry a failed action
export const POST = withSession(async (
  session,
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const skipTitleValidation = request.nextUrl.searchParams.get("skipTitleValidation") === "true";

  const action = await prisma.lifecycleAction.findUnique({
    where: { id },
    include: { mediaItem: { include: { externalIds: true } } },
  });

  if (!action || action.userId !== session.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (action.status !== "FAILED") {
    return NextResponse.json(
      { error: "Only failed actions can be retried" },
      { status: 400 }
    );
  }

  if (!action.ruleSetId) {
    return NextResponse.json(
      { error: "Cannot retry actions for deleted rule sets" },
      { status: 400 }
    );
  }

  // SINGLE-FLIGHT on the action's item within its rule set: this runs the Arr
  // call inline exactly like the manual execute route, so two overlapping
  // retries of the same FAILED action — or a retry landing while an Execute of
  // the same rule set covers the item — each send the same delete and each
  // record a COMPLETED row with its own `deletedBytes`. Claimed before any read
  // the response is built from, released in the `finally` on every exit. See
  // `execute-in-flight.ts` for the live-review finding behind this.
  const ruleSetId = action.ruleSetId;
  // An action whose item is gone claims the whole rule set; retryAction refuses it anyway.
  const lockedItems = action.mediaItemId ? [action.mediaItemId] : undefined;
  if (!tryBeginExecute(ruleSetId, lockedItems)) {
    return NextResponse.json(
      { error: "An execution covering this item is already running for this rule set" },
      { status: 409 }
    );
  }
  // Kept apart from an ad-hoc query action, which can act on another copy or
  // track of the same Arr record (see `execute-in-flight.ts`).
  if (!tryBeginRuleSetExecution(session.userId)) {
    endExecute(ruleSetId, lockedItems);
    return NextResponse.json(
      { error: "A query action is running — wait for it to finish" },
      { status: 409 }
    );
  }
  try {
    return await retryAction(session, { ...action, ruleSetId }, skipTitleValidation);
  } finally {
    endRuleSetExecution(session.userId);
    endExecute(ruleSetId, lockedItems);
  }
});

type FailedAction = Prisma.LifecycleActionGetPayload<{
  include: { mediaItem: { include: { externalIds: true } } };
}> & { ruleSetId: string };

/** The retry proper. Runs under the execute lock on its item (see `POST`). */
async function retryAction(
  session: LoggedInSession,
  action: FailedAction,
  skipTitleValidation: boolean,
): Promise<NextResponse> {
  const { id } = action;

  // A disabled rule set must not fire actions, even via force-retry. Detection
  // skips disabled sets, so their RuleMatch rows are frozen — the stale-match
  // guard below stays green forever and would happily wave a destructive
  // retry through. The scheduled executor and the manual execute route both
  // enforce this gate; force-retry needs it too.
  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id: action.ruleSetId, userId: session.userId },
    select: { enabled: true, type: true, rules: true },
  });
  if (!ruleSet?.enabled) {
    return NextResponse.json(
      { error: "Rule set is disabled — enable it before retrying actions" },
      { status: 400 }
    );
  }
  // Seerr criteria on a MUSIC rule set can never evaluate, so its matches are
  // vacuous (mirrors the scheduled executor and the manual execute route).
  if (ruleSet.type === "MUSIC" && hasSeerrRules(ruleSet.rules as unknown as LifecycleRuleGroup[])) {
    return NextResponse.json(
      { error: "Seerr criteria are not supported on music rule sets — this action's match is invalid" },
      { status: 400 }
    );
  }

  if (!action.mediaItem || !action.mediaItemId) {
    return NextResponse.json(
      { error: "Cannot retry actions — media item no longer exists" },
      { status: 400 }
    );
  }

  // Stale-match guard: a months-old FAILED action can be retried after the
  // item stopped matching the rule. Only retry when the item is STILL a
  // current match for this rule set (the same invariant the scheduled
  // executor enforces).
  const stillMatched = await prisma.ruleMatch.findFirst({
    where: { ruleSetId: action.ruleSetId, mediaItemId: action.mediaItemId },
    select: { itemData: true },
  });
  if (!stillMatched) {
    return NextResponse.json(
      { error: "This item is no longer a match for the rule set — re-run detection before retrying" },
      { status: 400 }
    );
  }

  // The episodes/tracks the retry acts on, judged as the scheduled executor
  // judges them (processor.ts, pass 1): the FAILED row keeps the member list it
  // was scheduled with, which can be months old. A member-scoped file delete
  // acts only on members the current match still lists, and none that an
  // exception protects — sent as stored, a retry deleted the files of episodes
  // watched or excepted since the failure.
  let members = action.matchedMediaItemIds ?? [];
  if (members.length > 0 && actionHonorsMemberIds(action.actionType)) {
    const current = new Set(memberIdsFromItemData(stillMatched.itemData));
    if (current.size > 0) {
      members = members.filter((m) => current.has(m));
      if (members.length === 0) {
        return NextResponse.json(
          { error: "None of the episodes/tracks this action targeted still match — re-run detection before retrying" },
          { status: 400 }
        );
      }
    }
  }

  // Exceptions added AFTER an action failed must still protect the item —
  // exception creation deletes PENDING actions, but FAILED rows survive and
  // could otherwise be force-retried against an excluded item.
  // An exception on another server's copy of the item (same dedupKey) counts.
  const excepted = await findExceptedItemIds(session.userId, [action.mediaItemId, ...members]);
  if (excepted.has(action.mediaItemId)) {
    return NextResponse.json(
      { error: "This item has a lifecycle exception and cannot be actioned" },
      { status: 400 }
    );
  }
  if (members.some((m) => excepted.has(m))) {
    const kept = members.filter((m) => !excepted.has(m));
    // A whole-record delete cannot leave an excepted member out.
    if (kept.length === 0 || isWholeRecordDestructiveAction(action.actionType)) {
      return NextResponse.json(
        { error: "An episode/track of this action has a lifecycle exception and cannot be actioned" },
        { status: 400 }
      );
    }
    members = kept;
  }

  // Whole-record destructive actions destroy every episode/track of the
  // series/artist — refuse the retry if ANY sibling is excepted (mirrors the
  // scheduled executor and the manual execute route).
  if (isWholeRecordDestructiveAction(action.actionType) && hasProtectionGroup(action.mediaItem)) {
    const protectedGroups = await findExceptionProtectedGroups(session.userId, [
      action.mediaItem,
    ]);
    if (isGroupProtected(protectedGroups, action.mediaItem)) {
      return NextResponse.json(
        { error: "An episode/track of this series/artist has a lifecycle exception — a whole-record delete cannot exclude it" },
        { status: 400 }
      );
    }
  }

  const mediaItem = action.mediaItem;

  // A Fix Match since the action was scheduled: a retry would act on a work
  // the rules never matched. Compared with the action's own snapshot, exactly
  // as the scheduled executor does before it runs an action (see
  // match-identity.ts); a snapshot too old to judge passes.
  const identityChange = matchIdentityChange(
    {
      title: action.mediaItemTitle,
      parentTitle: action.mediaItemParentTitle,
      year: action.mediaItemYear,
      externalIds: action.mediaItemExternalId
        ? [{ source: arrIdSourceFor(ruleSet.type), externalId: action.mediaItemExternalId }]
        : [],
    },
    mediaItem,
    ruleSet.type,
  );
  if (identityChange) {
    return NextResponse.json(
      {
        error:
          `This item is no longer the title the action was scheduled for (${identityChange}) — ` +
          "remove the failed action and run detection again",
      },
      { status: 409 }
    );
  }

  // A file delete on exactly one other episode is named after it.
  const running = { ...action, matchedMediaItemIds: members };
  const targetTitle = actionTargetTitle({ ...running, mediaItem, memberEpisodes: await loadMemberEpisodes([running]) });

  try {
    await executeAction({
      id: action.id,
      actionType: action.actionType,
      arrInstanceId: action.arrInstanceId,
      targetQualityProfileId: action.targetQualityProfileId,
      addImportExclusion: action.addImportExclusion,
      searchAfterAction: action.searchAfterAction,
      matchedMediaItemIds: members,
      addArrTags: action.addArrTags,
      removeArrTags: action.removeArrTags,
      skipTitleValidation,
      targetTitle,
      mediaItem,
    });

    await prisma.lifecycleAction.update({
      where: { id },
      data: {
        status: "COMPLETED",
        executedAt: new Date(),
        error: null,
        // What it acted on, not what was scheduled (see `members` above).
        matchedMediaItemIds: members,
      },
    });

    // Clean up match and any pending/failed duplicates for this item
    await prisma.ruleMatch.deleteMany({
      where: { ruleSetId: action.ruleSetId!, mediaItemId: action.mediaItemId },
    });
    await prisma.lifecycleAction.deleteMany({
      where: {
        ruleSetId: action.ruleSetId!,
        mediaItemId: action.mediaItemId,
        status: { in: ["PENDING", "FAILED"] },
        id: { not: id },
      },
    });

    logger.info("Lifecycle", `Force-retried action ${id} for "${targetTitle}" — succeeded`);

    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = extractActionError(error);
    await prisma.lifecycleAction.update({
      where: { id },
      data: { error: msg, executedAt: new Date() },
    });

    logger.error("Lifecycle", `Force-retry failed for "${targetTitle}"`, { error: describeActionError(error) });

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
