import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { validateRequest, ruleSetCreateSchema } from "@/lib/validation";

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
