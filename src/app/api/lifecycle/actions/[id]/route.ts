import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeAction, extractActionError } from "@/lib/lifecycle/actions";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
}

// Force-retry a failed action
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  if (!action.mediaItem || !action.mediaItemId) {
    return NextResponse.json(
      { error: "Cannot retry actions — media item no longer exists" },
      { status: 400 }
    );
  }

  const mediaItem = action.mediaItem;

  try {
    await executeAction({
      id: action.id,
      actionType: action.actionType,
      arrInstanceId: action.arrInstanceId,
      addImportExclusion: action.addImportExclusion,
      searchAfterDelete: action.searchAfterDelete,
      matchedMediaItemIds: action.matchedMediaItemIds,
      addArrTags: action.addArrTags,
      removeArrTags: action.removeArrTags,
      skipTitleValidation,
      mediaItem,
    });

    await prisma.lifecycleAction.update({
      where: { id },
      data: {
        status: "COMPLETED",
        executedAt: new Date(),
        error: null,
        mediaItemTitle: mediaItem.title,
        mediaItemParentTitle: mediaItem.parentTitle,
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

    logger.info("Lifecycle", `Force-retried action ${id} for "${mediaItem.title}" — succeeded`);

    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = extractActionError(error);
    await prisma.lifecycleAction.update({
      where: { id },
      data: { error: msg, executedAt: new Date() },
    });

    logger.error("Lifecycle", `Force-retry failed for "${mediaItem.title}"`, { error: msg });

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
