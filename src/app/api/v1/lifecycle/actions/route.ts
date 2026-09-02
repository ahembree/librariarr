import { withApiKey, v1Error, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type {
  LibraryType,
  LifecycleActionStatus,
  Prisma,
} from "@/generated/prisma/client";

const LIBRARY_TYPES: readonly LibraryType[] = ["MOVIE", "SERIES", "MUSIC"];

/**
 * The full set of states an action row can hold. There is no CANCELLED member:
 * cancelling an action deletes the row (see `processLifecycleRules`), so a
 * cancelled action is simply absent rather than a terminal status.
 */
const ACTION_STATUSES: readonly LifecycleActionStatus[] = [
  "PENDING",
  "COMPLETED",
  "FAILED",
];

function isLibraryType(value: string): value is LibraryType {
  return (LIBRARY_TYPES as readonly string[]).includes(value);
}

function isActionStatus(value: string): value is LifecycleActionStatus {
  return (ACTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Scheduled, executed and failed lifecycle actions.
 *
 * Titles are read from the denormalized `mediaItemTitle`/`ruleSetName` columns
 * when the related row is gone — a completed delete removes the MediaItem on
 * the next sync, and an integration polling history still needs to know what
 * the action was about.
 */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const status = searchParams.get("status");
  const type = searchParams.get("type");

  const where: Prisma.LifecycleActionWhereInput = { userId };

  if (status) {
    if (!isActionStatus(status)) {
      return v1Error(`Invalid status. Expected one of: ${ACTION_STATUSES.join(", ")}`, 400);
    }
    where.status = status;
  }

  if (type) {
    if (!isLibraryType(type)) {
      return v1Error(`Invalid type. Expected one of: ${LIBRARY_TYPES.join(", ")}`, 400);
    }
    // The denormalized column, not `ruleSet.type`: the rule set FK is SetNull,
    // so filtering through the relation would silently drop the history of a
    // deleted rule set.
    where.ruleSetType = type;
  }

  const rows = await prisma.lifecycleAction.findMany({
    where,
    skip: pagination.skip,
    take: pagination.limit + 1,
    orderBy: [{ scheduledFor: "desc" }, { id: "asc" }],
    select: {
      id: true,
      actionType: true,
      status: true,
      scheduledFor: true,
      executedAt: true,
      error: true,
      deletedBytes: true,
      createdAt: true,
      ruleSetId: true,
      ruleSetName: true,
      ruleSetType: true,
      mediaItemId: true,
      mediaItemTitle: true,
      mediaItemParentTitle: true,
      mediaItem: {
        select: { id: true, title: true, parentTitle: true, year: true, type: true },
      },
    },
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  const items = rows.map((row) => ({
    id: row.id,
    actionType: row.actionType,
    status: row.status,
    scheduledFor: row.scheduledFor,
    executedAt: row.executedAt,
    error: row.error,
    // BigInt — JSON.stringify throws on it, so it always goes out as a string.
    deletedBytes: row.deletedBytes?.toString() ?? null,
    createdAt: row.createdAt,
    ruleSet: {
      id: row.ruleSetId,
      name: row.ruleSetName,
      libraryType: row.ruleSetType,
    },
    mediaItem: {
      id: row.mediaItem?.id ?? row.mediaItemId,
      title: row.mediaItem?.title ?? row.mediaItemTitle,
      parentTitle: row.mediaItem?.parentTitle ?? row.mediaItemParentTitle,
      year: row.mediaItem?.year ?? null,
      type: row.mediaItem?.type ?? row.ruleSetType,
    },
  }));

  return v1List(items, pagination, hasMore);
});
