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
          ratingImage: true,
          audienceRating: true,
          audienceRatingImage: true,
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
      seriesKey: true,
      dedupKey: true,
    },
  });

  if (!mediaItem) {
    return NextResponse.json({ error: "Media item not found" }, { status: 404 });
  }

  // Individual scope: original single-item behavior
  if (scope === "individual") {
    return handleIndividualException(session.userId!, mediaItem, reason ?? null);
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
    // The show on every server: by title, and by series identity for another
    // server's copy titled differently ("The Office" vs "The Office (US)").
    bulkWhere.OR = [
      { parentTitle: mediaItem.parentTitle },
      ...(mediaItem.seriesKey ? [{ seriesKey: mediaItem.seriesKey }] : []),
    ];
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
    select: { id: true, dedupKey: true },
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

  await disarmExcludedItems(session.userId!, relatedItems);

  return NextResponse.json({ count: mediaItemIds.length, scope }, { status: 201 });
}

async function handleIndividualException(
  userId: string,
  item: { id: string; dedupKey: string | null },
  reason: string | null
) {
  const mediaItemId = item.id;
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

  await disarmExcludedItems(userId, [item]);

  return NextResponse.json({ exception }, { status: 201 });
}

/**
 * Disarm everything an exception on `items` now protects: the matches and
 * PENDING actions of the items themselves AND of every other copy of them —
 * the same `dedupKey` on the user's other servers or libraries, or a match
 * that collapsed them into its `copyIds` — and their entries in Plex
 * collections.
 *
 * An exception covers every copy (see `findExceptedItemIds`), and a title on
 * several servers is matched ONCE, on whichever copy detection kept: clearing
 * only the excluded item's own rows left that match and its armed action in
 * place until the executor or the next detection happened to cancel them —
 * while the Matches and Pending pages, the pending-deletion stats and the
 * collection it was in went on presenting the title as leaving.
 */
async function disarmExcludedItems(
  userId: string,
  items: Array<{ id: string; dedupKey: string | null }>,
): Promise<void> {
  const dedupKeys = [...new Set(items.map((i) => i.dedupKey).filter((k): k is string => !!k))];
  const twins =
    dedupKeys.length > 0
      ? await prisma.mediaItem.findMany({
          where: { dedupKey: { in: dedupKeys }, library: { mediaServer: { userId } } },
          select: { id: true },
        })
      : [];
  const affected = [...new Set([...items.map((i) => i.id), ...twins.map((t) => t.id)])];

  const matches = await prisma.ruleMatch.findMany({
    where: {
      ruleSet: { userId },
      OR: [{ mediaItemId: { in: affected } }, { copyIds: { hasSome: affected } }],
    },
    select: {
      mediaItemId: true,
      itemData: true,
      ruleSet: {
        select: {
          type: true,
          collection: { select: { name: true } },
          seriesScope: true,
        },
      },
    },
  });
  const disarmed = [...new Set([...affected, ...matches.map((m) => m.mediaItemId)])];

  await prisma.ruleMatch.deleteMany({
    where: { mediaItemId: { in: disarmed }, ruleSet: { userId } },
  });
  await prisma.lifecycleAction.deleteMany({
    where: { mediaItemId: { in: disarmed }, userId, status: "PENDING" },
  });

  // Take each match's items out of its Plex collection: the kept copy and the
  // copies it listed — each from its OWN library, since a rating key only
  // identifies an item within one server.
  const withCollection = matches.filter((m) => m.ruleSet.collection);
  if (withCollection.length === 0) return;
  const reps = await prisma.mediaItem.findMany({
    where: { id: { in: withCollection.map((m) => m.mediaItemId) } },
    select: { id: true, ratingKey: true, libraryId: true, title: true, parentTitle: true },
  });
  const repById = new Map(reps.map((r) => [r.id, r]));
  for (const match of withCollection) {
    const rep = repById.get(match.mediaItemId);
    const data = match.itemData as Record<string, unknown> | null;
    const copies = Array.isArray(data?.copies)
      ? (data.copies as Array<{ libraryId?: unknown; ratingKey?: unknown; title?: unknown; parentTitle?: unknown }>)
      : [];
    const entries = [
      ...(rep ? [rep] : []),
      ...copies
        .filter((c) => typeof c.libraryId === "string" && typeof c.ratingKey === "string")
        .map((c) => ({
          libraryId: c.libraryId as string,
          ratingKey: c.ratingKey as string,
          title: typeof c.title === "string" ? c.title : "",
          parentTitle: typeof c.parentTitle === "string" ? c.parentTitle : null,
        })),
    ];
    const { type, collection, seriesScope } = match.ruleSet;
    for (const entry of entries) {
      await removeItemFromCollections(
        userId,
        type,
        collection!.name,
        entry.ratingKey,
        seriesScope && type === "SERIES" ? (entry.parentTitle ?? entry.title) : null,
        entry.libraryId,
      ).catch(() => {
        // Collection removal is best-effort; don't fail the exclusion
      });
    }
  }
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
