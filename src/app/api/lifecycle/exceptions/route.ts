import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import {
  validateRequest,
  exceptionCreateSchema,
  exceptionBulkDeleteSchema,
  exceptionBulkUpdateSchema,
} from "@/lib/validation";
import { removeItemsFromCollections, type CollectionRemoval } from "@/lib/lifecycle/collections";
import { jsonResponse } from "@/lib/api/json-response";
import { inChunks } from "@/lib/conditions/in-chunks";
import { protectionKeys, isGroupProtected } from "@/lib/lifecycle/exception-guard";
import { artistMbidOf } from "@/lib/media/artist-key";
import type { Prisma } from "@/generated/prisma/client";

export const GET = withSession(async (session, request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  if (type && !["ALL", "MOVIE", "SERIES", "MUSIC"].includes(type)) {
    return NextResponse.json(
      { error: "Invalid type. Must be MOVIE, SERIES, MUSIC, or ALL" },
      { status: 400 }
    );
  }

  const where: Prisma.LifecycleExceptionWhereInput = {
    userId: session.userId,
    ...(type && type !== "ALL" ? { mediaItem: { type: type as "MOVIE" | "SERIES" | "MUSIC" } } : {}),
  };

  // Which items are excepted, and nothing else — what the Matches, Pending and
  // rule editor pages mark their rows with.
  if (isTruthyFlag(searchParams.get("idsOnly"))) {
    const rows = await prisma.lifecycleException.findMany({
      where,
      select: { mediaItemId: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return jsonResponse(request, { mediaItemIds: rows.map((r) => r.mediaItemId) });
  }

  const exceptions = await prisma.lifecycleException.findMany({
    where,
    include: {
      mediaItem: {
        select: {
          id: true,
          title: true,
          parentTitle: true,
          // The Exceptions page groups a show's exceptions by series identity;
          // by title, two same-titled shows were one row (and one Remove).
          seriesKey: true,
          albumTitle: true,
          type: true,
          year: true,
          thumbUrl: true,
          // The Exceptions page's hover popover renders it.
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
          audioCodec: true,
          fileSize: true,
          genres: true,
          studio: true,
          playCount: true,
          seasonNumber: true,
          episodeNumber: true,
          lastPlayedAt: true,
          addedAt: true,
          libraryId: true,
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });

  // Each row's server, from one lookup of the handful of libraries the rows
  // sit in rather than a library → server relation read per row.
  const libraryIds = [...new Set(exceptions.map((e) => e.mediaItem.libraryId))];
  const libraries =
    libraryIds.length > 0
      ? await prisma.library.findMany({
          where: { id: { in: libraryIds } },
          select: { id: true, mediaServer: { select: { id: true, name: true, type: true } } },
        })
      : [];
  const serverByLibrary = new Map(libraries.map((l) => [l.id, l.mediaServer]));

  // Serialize BigInt fileSize to string for JSON compatibility
  const serialized = exceptions.map((e) => {
    const { libraryId, ...mediaItem } = e.mediaItem;
    return {
      ...e,
      mediaItem: {
        ...mediaItem,
        fileSize: mediaItem.fileSize?.toString() ?? null,
        library: { mediaServer: serverByLibrary.get(libraryId) ?? null },
      },
    };
  });

  return jsonResponse(request, { exceptions: serialized });
});

/** `?idsOnly=1` / `?idsOnly=true`. */
function isTruthyFlag(value: string | null): boolean {
  return value === "1" || value === "true";
}

export const POST = withSession(async (session, request: NextRequest) => {
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
      externalIds: { where: { source: "MUSICBRAINZ" }, select: { source: true, externalId: true } },
    },
  });

  if (!mediaItem) {
    return NextResponse.json({ error: "Media item not found" }, { status: 404 });
  }

  // Individual scope: original single-item behavior
  if (scope === "individual") {
    return handleIndividualException(session.userId, mediaItem, reason ?? null);
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
    select: {
      id: true,
      dedupKey: true,
      parentTitle: true,
      seriesKey: true,
      type: true,
      externalIds: { where: { source: "MUSICBRAINZ" }, select: { source: true, externalId: true } },
    },
  });

  const mediaItemIds = relatedItems.map((item) => item.id);

  if (mediaItemIds.length === 0) {
    return NextResponse.json({ error: "No related items found" }, { status: 404 });
  }

  // Bulk create exceptions
  await prisma.lifecycleException.createMany({
    data: mediaItemIds.map((id) => ({
      userId: session.userId,
      mediaItemId: id,
      reason: reason ?? null,
    })),
    skipDuplicates: true,
  });

  await disarmExcludedItems(session.userId, relatedItems);

  return NextResponse.json({ count: mediaItemIds.length, scope }, { status: 201 });
});

async function handleIndividualException(
  userId: string,
  item: ExcludedItem,
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

interface ExcludedItem {
  id: string;
  dedupKey: string | null;
  parentTitle: string | null;
  seriesKey: string | null;
  type: string;
  /** The artist's MusicBrainz id, for a track (see `isGroupProtected`). */
  externalIds: Array<{ source: string; externalId: string }>;
}

/**
 * Disarm now what the next detection run would drop because of an exception
 * on `items` — no more, or a match detection keeps comes straight back with
 * its countdown restarted:
 *
 * - the matches and PENDING actions of the items themselves and of every
 *   other copy of them (the same `dedupKey` on the user's other servers or
 *   libraries — `findExceptedItemIds`). A title on several servers is matched
 *   ONCE, on whichever copy detection kept, so clearing only the excluded
 *   item's own rows left that match and its armed action in place;
 * - in grouped-scope (seriesScope) rule sets, the match of the whole show or
 *   artist, which detection drops when ANY of its items carries an exception,
 *   on any server (`isGroupProtected`) — deleted in that rule set only;
 * - their entries in Plex collections.
 *
 * A per-episode match whose group merely lists the item as another server's
 * copy is left alone: detection only removes the excepted members from it.
 */
async function disarmExcludedItems(userId: string, items: ExcludedItem[]): Promise<void> {
  const dedupKeys = [...new Set(items.map((i) => i.dedupKey).filter((k): k is string => !!k))];
  const twins =
    dedupKeys.length > 0
      ? await prisma.mediaItem.findMany({
          where: { dedupKey: { in: dedupKeys }, library: { mediaServer: { userId } } },
          select: { id: true },
        })
      : [];
  const affected = new Set([...items.map((i) => i.id), ...twins.map((t) => t.id)]);

  const groupKeys = new Set(items.flatMap((i) => protectionKeys(i)));
  const parents = [...new Set(items.map((i) => i.parentTitle).filter((t): t is string => !!t))];
  const seriesKeys = [...new Set(items.map((i) => i.seriesKey).filter((k): k is string => !!k))];
  const artistMbids = [
    ...new Set(
      items
        .filter((i) => i.type === "MUSIC")
        .map((i) => artistMbidOf(i.externalIds))
        .filter((m): m is string => !!m),
    ),
  ];

  const candidates = await prisma.ruleMatch.findMany({
    where: {
      ruleSet: { userId },
      OR: [
        { mediaItemId: { in: [...affected] } },
        ...(groupKeys.size > 0
          ? [
              {
                ruleSet: { userId, seriesScope: true, type: { in: ["SERIES" as const, "MUSIC" as const] } },
                mediaItem: {
                  OR: [
                    ...(parents.length > 0 ? [{ parentTitle: { in: parents, mode: "insensitive" as const } }] : []),
                    ...(seriesKeys.length > 0 ? [{ seriesKey: { in: seriesKeys } }] : []),
                    ...(artistMbids.length > 0
                      ? [{ externalIds: { some: { source: "MUSICBRAINZ", externalId: { in: artistMbids } } } }]
                      : []),
                  ],
                },
              },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      ruleSetId: true,
      mediaItemId: true,
      mediaItem:{ select: { parentTitle: true, seriesKey: true, externalIds: { where: { source: "MUSICBRAINZ" }, select: { source: true, externalId: true } } } },
      ruleSet: {
        select: {
          type: true,
          collection: { select: { name: true } },
          seriesScope: true,
        },
      },
    },
  });
  // Re-keyed as detection keys it (`isGroupProtected`): the title/seriesKey
  // probe above also finds a same-titled DIFFERENT show, which the exception
  // does not protect.
  const groupHits = candidates.filter(
    (m) =>
      !affected.has(m.mediaItemId) &&
      m.ruleSet.seriesScope &&
      isGroupProtected(groupKeys, {
        parentTitle: m.mediaItem.parentTitle,
        seriesKey: m.mediaItem.seriesKey,
        type: m.ruleSet.type,
        externalIds: m.mediaItem.externalIds,
      }),
  );
  const matches = [...candidates.filter((m) => affected.has(m.mediaItemId)), ...groupHits];
  const pairs = groupHits.map((m) => ({ ruleSetId: m.ruleSetId, mediaItemId: m.mediaItemId }));

  // The copies each collection-fed match lists, read (only for those, and only
  // that path of the snapshot) before the matches go.
  const withCollection = matches.filter((m) => m.ruleSet.collection);
  const copiesByMatch = new Map<string, unknown>();
  if (withCollection.length > 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; copies: unknown }>>(
      `SELECT id, "itemData"->'copies' AS copies FROM "RuleMatch" WHERE id = ANY($1)`,
      withCollection.map((m) => m.id),
    );
    for (const row of rows) copiesByMatch.set(row.id, row.copies);
  }

  await prisma.ruleMatch.deleteMany({
    where: { ruleSet: { userId }, OR: [{ mediaItemId: { in: [...affected] } }, ...pairs] },
  });
  await prisma.lifecycleAction.deleteMany({
    where: { userId, status: "PENDING", OR: [{ mediaItemId: { in: [...affected] } }, ...pairs] },
  });

  // Take each match's items out of its Plex collection: the kept copy and the
  // copies it listed — each from its OWN library, since a rating key only
  // identifies an item within one server. One batch, so each library's
  // collections and each collection's members are read once, not per entry.
  if (withCollection.length === 0) return;
  const reps = await prisma.mediaItem.findMany({
    where: { id: { in: withCollection.map((m) => m.mediaItemId) } },
    select: { id: true, ratingKey: true, libraryId: true, title: true, parentTitle: true },
  });
  const repById = new Map(reps.map((r) => [r.id, r]));
  const removals = new Map<string, CollectionRemoval>();
  for (const match of withCollection) {
    const rep = repById.get(match.mediaItemId);
    const listed = copiesByMatch.get(match.id);
    const copies = Array.isArray(listed)
      ? (listed as Array<{ libraryId?: unknown; ratingKey?: unknown; title?: unknown; parentTitle?: unknown }>)
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
      const removal: CollectionRemoval = {
        type,
        collectionName: collection!.name,
        itemRatingKey: entry.ratingKey,
        seriesTitle: seriesScope && type === "SERIES" ? (entry.parentTitle ?? entry.title) : null,
        libraryId: entry.libraryId,
      };
      const key = [removal.type, removal.collectionName, removal.itemRatingKey, removal.seriesTitle, removal.libraryId].join("\u0000");
      removals.set(key, removal);
    }
  }
  try {
    await removeItemsFromCollections(userId, [...removals.values()]);
  } catch {
    // Collection removal is best-effort; don't fail the exclusion
  }
}

export const DELETE = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, exceptionBulkDeleteSchema);
  if (error) return error;

  // A grouped row can name up to MAX_EXCEPTION_IDS_PER_REQUEST ids, past
  // Postgres' bind-parameter limit in one IN list: removed in slices, in one
  // transaction so the request still removes all or nothing.
  const ids = [...new Set(data.ids)];
  const results = await prisma.$transaction(
    inChunks(ids).map((chunk) =>
      prisma.lifecycleException.deleteMany({ where: { id: { in: chunk }, userId: session.userId } }),
    ),
  );

  return NextResponse.json({ deleted: results.reduce((n, r) => n + r.count, 0) });
});

export const PATCH = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, exceptionBulkUpdateSchema);
  if (error) return error;

  const { reason } = data;
  // In slices, as the DELETE above (distinct ids, so no row is counted twice).
  const ids = [...new Set(data.ids)];
  const results = await prisma.$transaction(
    inChunks(ids).map((chunk) =>
      prisma.lifecycleException.updateMany({
        where: { id: { in: chunk }, userId: session.userId },
        data: { reason: reason ?? null },
      }),
    ),
  );

  return NextResponse.json({ updated: results.reduce((n, r) => n + r.count, 0) });
});
