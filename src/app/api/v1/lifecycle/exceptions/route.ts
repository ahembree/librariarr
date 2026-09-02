import { NextResponse } from "next/server";
import { withApiKey, v1Error, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { validateRequest, v1ExceptionCreateSchema } from "@/lib/validation";
import { removeItemFromCollections } from "@/lib/lifecycle/collections";

const MEDIA_ITEM_SELECT = {
  id: true,
  title: true,
  parentTitle: true,
  year: true,
  type: true,
} satisfies Prisma.MediaItemSelect;

/** Items the user has protected from destructive lifecycle actions. */
export const GET = withApiKey(async (request, { userId }) => {
  const pagination = parseV1Pagination(new URL(request.url).searchParams);

  const rows = await prisma.lifecycleException.findMany({
    where: { userId },
    skip: pagination.skip,
    take: pagination.limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      reason: true,
      createdAt: true,
      mediaItem: { select: MEDIA_ITEM_SELECT },
    },
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  return v1List(rows, pagination, hasMore);
});

/**
 * Protect a single item.
 *
 * Creating an exception is not just an insert: the same cleanup the UI path
 * performs runs here too (drop the item's rule matches, delete its PENDING
 * actions, pull it out of any Plex collection it was pushed into). Skipping it
 * would leave a scheduled delete standing against an item the user just marked
 * untouchable until the next detection run tidied up.
 */
export const POST = withApiKey(
  async (request, { userId }) => {
    const { data, error } = await validateRequest(request, v1ExceptionCreateSchema);
    if (error) return error;

    const { mediaItemId, reason } = data;

    const mediaItem = await prisma.mediaItem.findFirst({
      where: { id: mediaItemId, library: { mediaServer: { userId } } },
      select: { ...MEDIA_ITEM_SELECT, ratingKey: true },
    });
    if (!mediaItem) return v1Error("Media item not found", 404);

    // Pre-check for a friendlier 409 than a raw constraint violation; the
    // create below still catches P2002 because two concurrent calls can slip
    // between this read and the insert.
    const existing = await prisma.lifecycleException.findUnique({
      where: { userId_mediaItemId: { userId, mediaItemId } },
      select: { id: true },
    });
    if (existing) {
      return v1Error("A lifecycle exception already exists for this media item", 409);
    }

    let exception;
    try {
      exception = await prisma.lifecycleException.create({
        data: { userId, mediaItemId, reason: reason ?? null },
        select: { id: true, reason: true, createdAt: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return v1Error("A lifecycle exception already exists for this media item", 409);
      }
      throw err;
    }

    // Collect the contributing rule sets before the matches are deleted — the
    // collection name to remove from is only reachable through them.
    const matched = await prisma.ruleMatch.findMany({
      where: { mediaItemId, ruleSet: { userId } },
      select: {
        ruleSet: {
          select: {
            type: true,
            seriesScope: true,
            collection: { select: { name: true } },
          },
        },
      },
    });

    await prisma.ruleMatch.deleteMany({ where: { mediaItemId, ruleSet: { userId } } });
    await prisma.lifecycleAction.deleteMany({
      where: { mediaItemId, userId, status: "PENDING" },
    });

    for (const { ruleSet } of matched) {
      if (!ruleSet.collection) continue;
      await removeItemFromCollections(
        userId,
        ruleSet.type,
        ruleSet.collection.name,
        mediaItem.ratingKey,
        ruleSet.seriesScope && ruleSet.type === "SERIES"
          ? (mediaItem.parentTitle ?? mediaItem.title)
          : null,
      ).catch(() => {
        // Best-effort: a Plex hiccup must not fail the exception itself.
      });
    }

    return NextResponse.json(
      {
        exception: {
          id: exception.id,
          reason: exception.reason,
          createdAt: exception.createdAt,
          mediaItem: {
            id: mediaItem.id,
            title: mediaItem.title,
            parentTitle: mediaItem.parentTitle,
            year: mediaItem.year,
            type: mediaItem.type,
          },
        },
      },
      { status: 201 },
    );
  },
  { scope: "READ_WRITE" },
);
