import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { validateRequest, ruleSetCreateSchema } from "@/lib/validation";
import { findFieldsInvalidForType } from "@/lib/conditions";
import { validateActionConfig } from "@/lib/lifecycle/action-config";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ruleSets = await prisma.ruleSet.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ ruleSets });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, ruleSetCreateSchema);
  if (error) return error;

  const {
    name, type, rules, seriesScope,
    enabled, actionEnabled, actionType, actionDelayDays, arrInstanceId, targetQualityProfileId, addImportExclusion, searchAfterAction,
    addArrTags, removeArrTags,
    collectionEnabled, collectionName, collectionSortName, collectionHomeScreen, collectionRecommended, collectionSort,
    discordNotifyOnAction,
    discordNotifyOnMatch,
    stickyMatches,
    serverIds,
  } = data;

  const existing = await prisma.ruleSet.findFirst({
    where: { userId: session.userId, name, type },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A rule set with this name already exists" },
      { status: 409 }
    );
  }

  // Reject fields that can never be populated for this library type (e.g.
  // arrSeasonCount on a MOVIE rule set). Such a clause evaluates against a
  // null value — silently dead in an AND group, or match-all under negate —
  // which is a correctness risk for the deletion pipeline. The builders gate
  // these in the UI; this guards direct API writes and legacy payloads.
  const invalidFields = findFieldsInvalidForType(rules, type);
  if (invalidFields.length > 0) {
    return NextResponse.json(
      {
        error: `These criteria are not valid for ${type.toLowerCase()} rules: ${invalidFields.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Refuse to persist an enabled CHANGE_QUALITY_PROFILE_* action without a
  // target profile — every scheduled action would just produce a FAILED row
  // at execution time. The UI guards this too, but a direct API write needs
  // its own check.
  if (
    actionEnabled &&
    actionType &&
    actionType.startsWith("CHANGE_QUALITY_PROFILE_") &&
    (targetQualityProfileId == null)
  ) {
    return NextResponse.json(
      { error: "Change Quality Profile actions require a target quality profile" },
      { status: 400 }
    );
  }

  // Action config must target the right Arr family for this library type,
  // and any referenced instance must exist and belong to the user.
  const actionConfigError = await validateActionConfig({
    userId: session.userId!,
    libraryType: type,
    actionType,
    arrInstanceId,
  });
  if (actionConfigError) {
    return NextResponse.json({ error: actionConfigError }, { status: 400 });
  }

  const ruleSet = await prisma.ruleSet.create({
    data: {
      userId: session.userId!,
      name,
      type,
      rules: rules as unknown as Prisma.InputJsonValue,
      seriesScope: seriesScope ?? true,
      enabled: enabled ?? true,
      actionEnabled: actionEnabled ?? false,
      actionType: actionType ?? null,
      actionDelayDays: actionDelayDays ?? 7,
      arrInstanceId: arrInstanceId ?? null,
      targetQualityProfileId: targetQualityProfileId ?? null,
      addImportExclusion: addImportExclusion ?? false,
      searchAfterAction: searchAfterAction ?? false,
      addArrTags: addArrTags ?? [],
      removeArrTags: removeArrTags ?? [],
      collectionEnabled: collectionEnabled ?? false,
      collectionName: collectionName ?? null,
      collectionSortName: collectionSortName ?? null,
      collectionHomeScreen: collectionHomeScreen ?? false,
      collectionRecommended: collectionRecommended ?? false,
      collectionSort: collectionSort ?? "ALPHABETICAL",
      discordNotifyOnAction: discordNotifyOnAction ?? false,
      discordNotifyOnMatch: discordNotifyOnMatch ?? false,
      stickyMatches: stickyMatches ?? false,
      serverIds,
    },
  });

  return NextResponse.json({ ruleSet }, { status: 201 });
}
