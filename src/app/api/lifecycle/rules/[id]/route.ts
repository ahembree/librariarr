import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { removePlexCollection } from "@/lib/lifecycle/collections";
import { cleanupArrTags } from "@/lib/lifecycle/actions";
import { validateRequest, ruleSetUpdateSchema } from "@/lib/validation";
import { findFieldsInvalidForType } from "@/lib/conditions";
import { validateActionConfig } from "@/lib/lifecycle/action-config";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, ruleSetUpdateSchema);
  if (error) return error;

  const {
    name, rules, seriesScope,
    enabled, actionEnabled, actionType, actionDelayDays, arrInstanceId, targetQualityProfileId, addImportExclusion, searchAfterAction,
    addArrTags, removeArrTags,
    collectionEnabled, collectionName, collectionSortName, collectionHomeScreen, collectionRecommended, collectionSort,
    discordNotifyOnAction,
    discordNotifyOnMatch,
    stickyMatches,
    serverIds,
  } = data;

  // The rule set's type is fixed at creation and needed for both the duplicate-
  // name check and the field-validity guard below. Fetch it once when either is
  // relevant rather than twice.
  let currentType: "MOVIE" | "SERIES" | "MUSIC" | undefined;
  if (name !== undefined || rules !== undefined) {
    const current = await prisma.ruleSet.findFirst({
      where: { id, userId: session.userId },
      select: { type: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Rule set not found" }, { status: 404 });
    }
    currentType = current.type;
  }

  if (name !== undefined) {
    const existing = await prisma.ruleSet.findFirst({
      where: { userId: session.userId, name, type: currentType!, id: { not: id } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "A rule set with this name already exists" },
        { status: 409 }
      );
    }
  }

  // Reject fields invalid for this rule set's library type (see POST handler
  // for rationale). Only relevant when the update actually carries new rules.
  if (rules !== undefined && currentType) {
    const invalidFields = findFieldsInvalidForType(rules, currentType);
    if (invalidFields.length > 0) {
      return NextResponse.json(
        {
          error: `These criteria are not valid for ${currentType.toLowerCase()} rules: ${invalidFields.join(", ")}`,
        },
        { status: 400 }
      );
    }
  }

  // If the merged state would be an enabled CHANGE_QUALITY_PROFILE_* action
  // with no target profile, refuse the write. Have to merge with the current
  // record because PUT only sends changed fields.
  if (actionEnabled !== undefined || actionType !== undefined || targetQualityProfileId !== undefined) {
    const current = await prisma.ruleSet.findFirst({
      where: { id, userId: session.userId },
      select: { actionEnabled: true, actionType: true, targetQualityProfileId: true },
    });
    if (current) {
      const nextActionEnabled = actionEnabled ?? current.actionEnabled;
      const nextActionType = actionType !== undefined ? actionType : current.actionType;
      const nextTargetId = targetQualityProfileId !== undefined
        ? targetQualityProfileId
        : current.targetQualityProfileId;
      if (
        nextActionEnabled &&
        nextActionType &&
        nextActionType.startsWith("CHANGE_QUALITY_PROFILE_") &&
        nextTargetId == null
      ) {
        return NextResponse.json(
          { error: "Change Quality Profile actions require a target quality profile" },
          { status: 400 }
        );
      }
    }
  }

  // Validate the MERGED action configuration (PUT only sends changed
  // fields): family of actionType must match the library type, and a
  // referenced instance must exist in that family for this user.
  if (actionType !== undefined || arrInstanceId !== undefined) {
    const current = await prisma.ruleSet.findFirst({
      where: { id, userId: session.userId },
      select: { type: true, actionType: true, arrInstanceId: true },
    });
    if (current) {
      const actionConfigError = await validateActionConfig({
        userId: session.userId!,
        libraryType: current.type,
        actionType: actionType !== undefined ? actionType : current.actionType,
        arrInstanceId: arrInstanceId !== undefined ? arrInstanceId : current.arrInstanceId,
      });
      if (actionConfigError) {
        return NextResponse.json({ error: actionConfigError }, { status: 400 });
      }
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (rules !== undefined) updateData.rules = rules;
  if (seriesScope !== undefined) updateData.seriesScope = seriesScope;
  if (actionEnabled !== undefined) updateData.actionEnabled = actionEnabled;
  if (actionType !== undefined) updateData.actionType = actionType;
  if (actionDelayDays !== undefined) updateData.actionDelayDays = actionDelayDays;
  if (arrInstanceId !== undefined) updateData.arrInstanceId = arrInstanceId;
  if (targetQualityProfileId !== undefined) updateData.targetQualityProfileId = targetQualityProfileId;
  if (addImportExclusion !== undefined) updateData.addImportExclusion = addImportExclusion;
  if (searchAfterAction !== undefined) updateData.searchAfterAction = searchAfterAction;
  if (addArrTags !== undefined) updateData.addArrTags = addArrTags;
  if (removeArrTags !== undefined) updateData.removeArrTags = removeArrTags;
  if (enabled !== undefined) updateData.enabled = enabled;
  if (collectionEnabled !== undefined) updateData.collectionEnabled = collectionEnabled;
  if (collectionName !== undefined) updateData.collectionName = collectionName;
  if (collectionSortName !== undefined) updateData.collectionSortName = collectionSortName;
  if (collectionHomeScreen !== undefined) updateData.collectionHomeScreen = collectionHomeScreen;
  if (collectionRecommended !== undefined) updateData.collectionRecommended = collectionRecommended;
  if (collectionSort !== undefined) updateData.collectionSort = collectionSort;
  if (discordNotifyOnAction !== undefined) updateData.discordNotifyOnAction = discordNotifyOnAction;
  if (discordNotifyOnMatch !== undefined) updateData.discordNotifyOnMatch = discordNotifyOnMatch;
  if (stickyMatches !== undefined) updateData.stickyMatches = stickyMatches;
  if (serverIds !== undefined) updateData.serverIds = serverIds;

  // clearMatches=false preserves existing matches and pending actions (e.g. when user
  // wants to keep matches intact after a config-only change). Defaults to true for
  // backwards compatibility and safety.
  const clearMatches = request.nextUrl.searchParams.get("clearMatches") !== "false";

  // Wrap update + cleanup + read in a single transaction so the returned
  // record reflects exactly the values we just wrote and isn't clobbered
  // by a concurrent update between commit and read.
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.ruleSet.updateMany({
      where: { id, userId: session.userId },
      data: updateData,
    });
    if (result.count === 0) return null;

    if (clearMatches) {
      await tx.ruleMatch.deleteMany({ where: { ruleSetId: id } });
      await tx.lifecycleAction.deleteMany({
        where: { ruleSetId: id, status: "PENDING" },
      });
    } else if (actionEnabled === false || enabled === false) {
      // Disabling the rule set (or just its action) must cancel armed
      // PENDING actions — the execution-side enabled filter is the backstop,
      // but cancelling here keeps the Pending page honest and prevents the
      // actions lingering until the next detection run.
      await tx.lifecycleAction.deleteMany({
        where: { ruleSetId: id, status: "PENDING" },
      });
    }

    return tx.ruleSet.findUnique({ where: { id } });
  });

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ruleSet: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const cleanupTags = request.nextUrl.searchParams.get("cleanupTags") === "true";

  // Fetch the rule set to check for collection/tag config before deleting
  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id, userId: session.userId },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Clean up Arr tags if requested and rule set has addArrTags configured
  if (cleanupTags && ruleSet.addArrTags.length > 0 && ruleSet.arrInstanceId) {
    try {
      await cleanupArrTags(ruleSet.arrInstanceId, ruleSet.type, ruleSet.addArrTags);
    } catch {
      // Best-effort cleanup — don't block deletion if Arr is unreachable
    }
  }

  // Clean up Plex collection if one was configured
  if (ruleSet.collectionName && session.userId) {
    try {
      await removePlexCollection(session.userId, ruleSet.type, ruleSet.collectionName);
    } catch {
      // Best-effort cleanup — don't block deletion if Plex is unreachable
    }
  }

  // Delete PENDING actions (no longer relevant).
  // COMPLETED and FAILED actions are preserved — SetNull will clear their ruleSetId
  // while the denormalized ruleSetName/ruleSetType fields retain display info.
  await prisma.lifecycleAction.deleteMany({
    where: { ruleSetId: id, status: "PENDING" },
  });

  await prisma.ruleSet.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
