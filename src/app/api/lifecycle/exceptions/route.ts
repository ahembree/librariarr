import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import {
  validateRequest,
  exceptionCreateSchema,
  exceptionBulkDeleteSchema,
  exceptionBulkUpdateSchema,
} from "@/lib/validation";
import { removeItemFromCollections } from "@/lib/lifecycle/collections";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");

  const where: Record<string, unknown> = {
    userId: session.userId,
  };

  if (type && type !== "ALL") {
    where.mediaItem = { type };
  }

  const exceptions = await prisma.lifecycleException.findMany({
    where,
    include: {
      mediaItem: {
        select: {
          id: true,
          title: true,
          parentTitle: true,
          albumTitle: true,
          type: true,
          year: true,
          thumbUrl: true,
          summary: true,
          contentRating: true,
          rating: true,
          audienceRating: true,
          duration: true,
          resolution: true,
          dynamicRange: true,
          audioProfile: true,
          fileSize: true,
          genres: true,
          studio: true,
          playCount: true,
          seasonNumber: true,
          lastPlayedAt: true,
          addedAt: true,
          library: {
            select: {
              mediaServer: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Serialize BigInt fileSize to string for JSON compatibility
  const serialized = exceptions.map((e) => ({
    ...e,
    mediaItem: {
      ...e.mediaItem,
      fileSize: e.mediaItem.fileSize?.toString() ?? null,
    },
  }));

  return NextResponse.json({ exceptions: serialized });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, exceptionCreateSchema);
  if (error) return error;

  const { mediaItemId, reason, scope } = data;

  // Validate ownership: media item must belong to user's server
  const mediaItem = await prisma.mediaItem.findFirst({
    where: {
      id: mediaItemId,
      library: { mediaServer: { userId: session.userId } },
    },
    select: {
      id: true,
      title: true,
      parentTitle: true,
      albumTitle: true,
      type: true,
    },
  });

  if (!mediaItem) {
    return NextResponse.json({ error: "Media item not found" }, { status: 404 });
  }

  // Individual scope: original single-item behavior
  if (scope === "individual") {
    return handleIndividualException(session.userId!, mediaItemId, reason ?? null);
  }

  // Bulk scopes: resolve all related media item IDs
  const bulkWhere: Prisma.MediaItemWhereInput = {
    library: { mediaServer: { userId: session.userId } },
  };

  if (scope === "series") {
    if (!mediaItem.parentTitle) {
      return NextResponse.json(
        { error: "Media item has no series title" },
        { status: 400 }
      );
    }
    bulkWhere.parentTitle = mediaItem.parentTitle;
    bulkWhere.type = "SERIES";
  } else if (scope === "artist") {
    if (!mediaItem.parentTitle) {
      return NextResponse.json(
        { error: "Media item has no artist" },
        { status: 400 }
      );
    }
    bulkWhere.parentTitle = mediaItem.parentTitle;
    bulkWhere.type = "MUSIC";
  } else if (scope === "album") {
    if (!mediaItem.parentTitle || !mediaItem.albumTitle) {
      return NextResponse.json(
        { error: "Media item has no album or artist" },
        { status: 400 }
      );
    }
    bulkWhere.parentTitle = mediaItem.parentTitle;
    bulkWhere.albumTitle = mediaItem.albumTitle;
    bulkWhere.type = "MUSIC";
  }

  const relatedItems = await prisma.mediaItem.findMany({
    where: bulkWhere,
    select: { id: true, ratingKey: true, title: true, parentTitle: true, type: true },
  });

  const mediaItemIds = relatedItems.map((item) => item.id);

  if (mediaItemIds.length === 0) {
    return NextResponse.json({ error: "No related items found" }, { status: 404 });
  }

  // Bulk create exceptions
  await prisma.lifecycleException.createMany({
    data: mediaItemIds.map((id) => ({
      userId: session.userId!,
      mediaItemId: id,
      reason: reason ?? null,
    })),
    skipDuplicates: true,
  });

  // Find rule matches before deleting (needed for collection removal)
  const matchedRuleSets = await prisma.ruleMatch.findMany({
    where: {
      mediaItemId: { in: mediaItemIds },
      ruleSet: { userId: session.userId },
    },
    select: {
      mediaItemId: true,
      ruleSet: {
        select: {
          id: true,
          type: true,
          collectionEnabled: true,
          collectionName: true,
          seriesScope: true,
        },
      },
    },
  });

  // Bulk-delete RuleMatch records
  await prisma.ruleMatch.deleteMany({
    where: {
      mediaItemId: { in: mediaItemIds },
      ruleSet: { userId: session.userId },
    },
  });

  // Bulk-delete PENDING LifecycleAction records
  await prisma.lifecycleAction.deleteMany({
    where: {
      mediaItemId: { in: mediaItemIds },
      userId: session.userId!,
      status: "PENDING",
    },
  });

  // Remove items from Plex collections (best-effort)
  const collectionsToUpdate = matchedRuleSets
    .filter((m) => m.ruleSet.collectionEnabled && m.ruleSet.collectionName);

  if (collectionsToUpdate.length > 0) {
    const itemMap = new Map(relatedItems.map((i) => [i.id, i]));
    for (const match of collectionsToUpdate) {
      const item = itemMap.get(match.mediaItemId);
      if (!item) continue;
      await removeItemFromCollections(
        session.userId!,
        match.ruleSet.type,
        match.ruleSet.collectionName!,
        item.ratingKey,
        match.ruleSet.seriesScope && match.ruleSet.type === "SERIES"
          ? (item.parentTitle ?? item.title)
          : null
      ).catch(() => {
        // Collection removal is best-effort
      });
    }
  }

  return NextResponse.json({ count: mediaItemIds.length, scope }, { status: 201 });
}

async function handleIndividualException(
  userId: string,
  mediaItemId: string,
  reason: string | null
) {
  // Upsert to handle duplicates gracefully
  const exception = await prisma.lifecycleException.upsert({
    where: {
      userId_mediaItemId: {
        userId,
        mediaItemId,
      },
    },
    update: { reason },
    create: {
      userId,
      mediaItemId,
      reason,
    },
  });

  // Find rule matches before deleting (needed for collection removal)
  const matchedRuleSets = await prisma.ruleMatch.findMany({
    where: {
      mediaItemId,
      ruleSet: { userId },
    },
    select: {
      ruleSet: {
        select: {
          id: true,
          type: true,
          collectionEnabled: true,
          collectionName: true,
          seriesScope: true,
        },
      },
    },
  });

  // Remove any existing RuleMatch records for this media item
  await prisma.ruleMatch.deleteMany({
    where: {
      mediaItemId,
      ruleSet: { userId },
    },
  });

  // Delete any PENDING LifecycleAction records for this media item
  await prisma.lifecycleAction.deleteMany({
    where: {
      mediaItemId,
      userId,
      status: "PENDING",
    },
  });

  // Remove the item from any Plex collections it was synced to
  const collectionsToUpdate = matchedRuleSets
    .filter((m) => m.ruleSet.collectionEnabled && m.ruleSet.collectionName)
    .map((m) => m.ruleSet);

  if (collectionsToUpdate.length > 0) {
    const fullItem = await prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        ratingKey: true,
        title: true,
        parentTitle: true,
        type: true,
        libraryId: true,
      },
    });

    if (fullItem) {
      for (const ruleSet of collectionsToUpdate) {
        await removeItemFromCollections(
          userId,
          ruleSet.type,
          ruleSet.collectionName!,
          fullItem.ratingKey,
          ruleSet.seriesScope && ruleSet.type === "SERIES"
            ? (fullItem.parentTitle ?? fullItem.title)
            : null
        ).catch(() => {
          // Collection removal is best-effort; don't fail the exclusion
        });
      }
    }
  }

  return NextResponse.json({ exception }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, exceptionBulkDeleteSchema);
  if (error) return error;

  const { ids } = data;

  const { count } = await prisma.lifecycleException.deleteMany({
    where: {
      id: { in: ids },
      userId: session.userId!,
    },
  });

  return NextResponse.json({ deleted: count });
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, exceptionBulkUpdateSchema);
  if (error) return error;

  const { ids, reason } = data;

  const { count } = await prisma.lifecycleException.updateMany({
    where: {
      id: { in: ids },
      userId: session.userId!,
    },
    data: { reason: reason ?? null },
  });

  return NextResponse.json({ updated: count });
}
