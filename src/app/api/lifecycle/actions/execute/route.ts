import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeAction, extractActionError } from "@/lib/lifecycle/actions";
import { validateRequest, actionExecuteSchema } from "@/lib/validation";
import { sendDiscordNotification, buildFailureSummaryEmbed } from "@/lib/discord/client";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, actionExecuteSchema);
  if (error) return error;

  const { ruleSetId, mediaItemIds } = data;

  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id: ruleSetId, userId: session.userId },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Rule set not found" }, { status: 404 });
  }

  const hasTagOps = ruleSet.addArrTags.length > 0 || ruleSet.removeArrTags.length > 0;

  if (!ruleSet.actionType && !hasTagOps) {
    return NextResponse.json(
      { error: "Rule set has no action configured" },
      { status: 400 }
    );
  }

  // Arr instance needed when: actionType is not DO_NOTHING, or tag operations are configured
  const needsArrInstance = (ruleSet.actionType && ruleSet.actionType !== "DO_NOTHING") || hasTagOps;
  if (needsArrInstance && !ruleSet.arrInstanceId) {
    return NextResponse.json(
      { error: "Rule set has no Arr instance configured" },
      { status: 400 }
    );
  }

  // Track episode-level matched IDs for series with seriesScope=false
  const episodeIdMap = new Map<string, string[]>();

  // SAFETY: Only act on items that are stored matches for this rule set.
  // Never re-evaluate rules — use the persisted RuleMatch records as the
  // single source of truth. This ensures what the user sees on the matches
  // page is exactly what gets actioned.
  let itemIds: string[];

  if (!mediaItemIds || mediaItemIds.length === 0) {
    // "Execute All" — use all stored matches for this rule set
    const storedMatches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
      select: { mediaItemId: true, itemData: true },
    });

    if (storedMatches.length === 0) {
      return NextResponse.json(
        { error: "No matches found for this rule set — run detection first" },
        { status: 400 }
      );
    }

    itemIds = storedMatches.map((m) => m.mediaItemId);

    // Extract episodeIdMap from stored match data for series episode-level tracking
    if (ruleSet.type === "SERIES" && !ruleSet.seriesScope) {
      for (const rm of storedMatches) {
        const rmData = rm.itemData as Record<string, unknown> | null;
        const memberIds = rmData?.memberIds as string[] | undefined;
        if (memberIds && memberIds.length > 0) {
          episodeIdMap.set(rm.mediaItemId, memberIds);
        }
      }
    }

    logger.info("Lifecycle", `Manual execute all: ${storedMatches.length} stored matches for rule set "${ruleSet.id}"`);
  } else {
    // Specific items selected — validate ALL provided IDs are actual matches
    const validMatches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id, mediaItemId: { in: mediaItemIds } },
      select: { mediaItemId: true, itemData: true },
    });

    const validIds = new Set(validMatches.map((m) => m.mediaItemId));
    const invalidIds = mediaItemIds.filter((id) => !validIds.has(id));

    if (invalidIds.length > 0) {
      logger.warn("Lifecycle", `Rejected ${invalidIds.length} items not in matches for rule set "${ruleSet.id}": [${invalidIds.join(", ")}]`);
    }

    // Only action items that are confirmed matches
    itemIds = mediaItemIds.filter((id) => validIds.has(id));

    if (itemIds.length === 0) {
      return NextResponse.json(
        { error: "None of the provided items are matches for this rule set" },
        { status: 400 }
      );
    }

    // Extract episodeIdMap from stored match data for series episode-level tracking
    if (ruleSet.type === "SERIES" && !ruleSet.seriesScope) {
      for (const rm of validMatches) {
        const rmData = rm.itemData as Record<string, unknown> | null;
        const memberIds = rmData?.memberIds as string[] | undefined;
        if (memberIds && memberIds.length > 0) {
          episodeIdMap.set(rm.mediaItemId, memberIds);
        }
      }
    }

    logger.info("Lifecycle", `Manual execute selected: ${itemIds.length} validated matches (${invalidIds.length} rejected) for rule set "${ruleSet.id}"`);
  }

  // Filter out items that have a LifecycleException
  const exceptions = await prisma.lifecycleException.findMany({
    where: {
      userId: session.userId!,
      mediaItemId: { in: itemIds },
    },
    select: { mediaItemId: true },
  });
  if (exceptions.length > 0) {
    const excludedIds = new Set(exceptions.map((e) => e.mediaItemId));
    itemIds = itemIds.filter((id) => !excludedIds.has(id));
    logger.info("Lifecycle", `Skipped ${exceptions.length} excluded items during manual execution for rule set "${ruleSet.id}"`);

    if (itemIds.length === 0) {
      return NextResponse.json(
        { error: "All selected items are excluded from lifecycle actions" },
        { status: 400 }
      );
    }
  }

  // Fetch media items with external IDs (ownership-validated)
  const items = await prisma.mediaItem.findMany({
    where: {
      id: { in: itemIds },
      library: { mediaServer: { userId: session.userId } },
    },
    include: { externalIds: true },
  });

  // SAFETY: Log the bounded execution count before starting any destructive operations
  logger.info("Lifecycle", `Executing ${ruleSet.actionType ?? "DO_NOTHING"} on ${items.length} items for rule set "${ruleSet.id}" (${itemIds.length} match IDs, ${items.length} ownership-verified)`);

  let executed = 0;
  let failed = 0;
  const errors: string[] = [];
  const failures: { title: string; error: string }[] = [];

  for (const item of items) {
    const matchedMediaItemIds = episodeIdMap.get(item.id) ?? [];
    try {
      await executeAction({
        id: "immediate",
        actionType: ruleSet.actionType ?? "DO_NOTHING",
        arrInstanceId: ruleSet.arrInstanceId,
        addImportExclusion: ruleSet.addImportExclusion,
        searchAfterDelete: ruleSet.searchAfterDelete,
        matchedMediaItemIds,
        addArrTags: ruleSet.addArrTags,
        removeArrTags: ruleSet.removeArrTags,
        mediaItem: item,
      });

      // Delete any existing PENDING action for this item and remove from matches
      await prisma.lifecycleAction.deleteMany({
        where: { ruleSetId: ruleSet.id, mediaItemId: item.id, status: "PENDING" },
      });
      await prisma.ruleMatch.deleteMany({
        where: { ruleSetId: ruleSet.id, mediaItemId: item.id },
      });

      // Compute deleted bytes for stats tracking
      let deletedBytes: bigint | null = null;
      if (matchedMediaItemIds.length > 0) {
        const memberSizes = await prisma.mediaItem.findMany({
          where: { id: { in: matchedMediaItemIds } },
          select: { fileSize: true },
        });
        const total = memberSizes.reduce((sum, m) => sum + (m.fileSize ?? BigInt(0)), BigInt(0));
        if (total > BigInt(0)) deletedBytes = total;
      } else if (item.fileSize) {
        deletedBytes = item.fileSize;
      }

      // Create a completed action record
      await prisma.lifecycleAction.create({
        data: {
          userId: session.userId!,
          mediaItemId: item.id,
          ruleSetId: ruleSet.id,
          ruleSetName: ruleSet.name,
          ruleSetType: ruleSet.type,
          actionType: ruleSet.actionType ?? "DO_NOTHING",
          addImportExclusion: ruleSet.addImportExclusion,
          searchAfterDelete: ruleSet.searchAfterDelete,
          matchedMediaItemIds,
          addArrTags: ruleSet.addArrTags,
          removeArrTags: ruleSet.removeArrTags,
          scheduledFor: new Date(),
          executedAt: new Date(),
          status: "COMPLETED",
          deletedBytes,
          arrInstanceId: ruleSet.arrInstanceId,
        },
      });

      executed++;
    } catch (error) {
      const msg = extractActionError(error);
      errors.push(`${item.title}: ${msg}`);
      failures.push({ title: item.title, error: msg });
      logger.error("Lifecycle", `Failed immediate ${ruleSet.actionType} for "${item.title}"`, { error: msg });

      await prisma.lifecycleAction.create({
        data: {
          userId: session.userId!,
          mediaItemId: item.id,
          ruleSetId: ruleSet.id,
          ruleSetName: ruleSet.name,
          ruleSetType: ruleSet.type,
          actionType: ruleSet.actionType ?? "DO_NOTHING",
          addImportExclusion: ruleSet.addImportExclusion,
          searchAfterDelete: ruleSet.searchAfterDelete,
          matchedMediaItemIds,
          addArrTags: ruleSet.addArrTags,
          removeArrTags: ruleSet.removeArrTags,
          scheduledFor: new Date(),
          executedAt: new Date(),
          status: "FAILED",
          error: msg,
          arrInstanceId: ruleSet.arrInstanceId,
        },
      });
      failed++;
    }
  }

  // Send Discord notification for failures if the rule set has notifications enabled
  if (failed > 0 && ruleSet.discordNotifyOnAction) {
    try {
      const settings = await prisma.appSettings.findUnique({
        where: { userId: session.userId! },
        select: { discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
      });
      if (settings?.discordWebhookUrl) {
        await sendDiscordNotification(settings.discordWebhookUrl, {
          username: settings.discordWebhookUsername || "Librariarr",
          avatar_url: settings.discordWebhookAvatarUrl || undefined,
          embeds: [buildFailureSummaryEmbed(ruleSet.name, ruleSet.actionType ?? "DO_NOTHING", failures)],
        });
      }
    } catch {
      // Don't let notification failures break the response
    }
  }

  return NextResponse.json({ executed, failed, errors });
}
