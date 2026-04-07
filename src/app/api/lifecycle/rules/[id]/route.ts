import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { removePlexCollection } from "@/lib/lifecycle/collections";
import { cleanupArrTags } from "@/lib/lifecycle/actions";
import { validateRequest, ruleSetUpdateSchema } from "@/lib/validation";

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
    enabled, actionEnabled, actionType, actionDelayDays, arrInstanceId, addImportExclusion, searchAfterDelete,
    addArrTags, removeArrTags,
    collectionEnabled, collectionName, collectionSortName, collectionHomeScreen, collectionRecommended, collectionSort,
    discordNotifyOnAction,
    discordNotifyOnMatch,
    stickyMatches,
    serverIds,
  } = data;

  if (name !== undefined) {
    const existing = await prisma.ruleSet.findFirst({
      where: { userId: session.userId, name, id: { not: id } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "A rule set with this name already exists" },
        { status: 409 }
      );
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
  if (addImportExclusion !== undefined) updateData.addImportExclusion = addImportExclusion;
  if (searchAfterDelete !== undefined) updateData.searchAfterDelete = searchAfterDelete;
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

  // Wrap in transaction to prevent race conditions with concurrent detection runs.
  const operations = [
    prisma.ruleSet.updateMany({
      where: { id, userId: session.userId },
      data: updateData,
    }),
  ];
  if (clearMatches) {
    operations.push(prisma.ruleMatch.deleteMany({ where: { ruleSetId: id } }));
    operations.push(
      prisma.lifecycleAction.deleteMany({
        where: { ruleSetId: id, status: "PENDING" },
      }),
    );
  } else if (actionEnabled === false) {
    // Delete pending actions immediately when actions are disabled
    operations.push(
      prisma.lifecycleAction.deleteMany({
        where: { ruleSetId: id, status: "PENDING" },
      }),
    );
  }
  const [ruleSet] = await prisma.$transaction(operations);

  if (ruleSet.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.ruleSet.findUnique({ where: { id } });
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
      await removePlexCollection(session.userId, ruleSet.type, ruleSet.collectionName, ruleSet.id);
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
