import { withApiKey, v1Error, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import type { LibraryType, Prisma } from "@/generated/prisma/client";

const LIBRARY_TYPES: readonly LibraryType[] = ["MOVIE", "SERIES", "MUSIC"];

function isLibraryType(value: string): value is LibraryType {
  return (LIBRARY_TYPES as readonly string[]).includes(value);
}

/**
 * Persisted rule matches — what detection last decided, not a fresh evaluation.
 *
 * Reading `RuleMatch` rather than re-running the engine is the point: an
 * external poller must never be able to kick off a full library evaluation just
 * by listing matches.
 */
export const GET = withApiKey(async (request, { userId }) => {
  const { searchParams } = new URL(request.url);
  const pagination = parseV1Pagination(searchParams);
  const ruleSetId = searchParams.get("ruleSetId");
  const type = searchParams.get("type");

  // Scoping lives on the rule set — RuleMatch has no userId of its own, so the
  // relation filter is what keeps the query on this user's data.
  const ruleSetWhere: Prisma.RuleSetWhereInput = { userId };
  if (ruleSetId) ruleSetWhere.id = ruleSetId;
  if (type) {
    // Reject rather than ignore: an unknown value would otherwise be passed to
    // a Prisma enum column and surface as a 500.
    if (!isLibraryType(type)) {
      return v1Error(`Invalid type. Expected one of: ${LIBRARY_TYPES.join(", ")}`, 400);
    }
    ruleSetWhere.type = type;
  }

  const rows = await prisma.ruleMatch.findMany({
    where: { ruleSet: ruleSetWhere },
    skip: pagination.skip,
    take: pagination.limit + 1,
    orderBy: [{ detectedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      detectedAt: true,
      ruleSet: { select: { id: true, name: true, type: true } },
      mediaItem: {
        select: { id: true, title: true, parentTitle: true, year: true, type: true },
      },
    },
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  const items = rows.map((row) => ({
    id: row.id,
    detectedAt: row.detectedAt,
    ruleSet: {
      id: row.ruleSet.id,
      name: row.ruleSet.name,
      libraryType: row.ruleSet.type,
    },
    mediaItem: row.mediaItem,
  }));

  return v1List(items, pagination, hasMore);
});
