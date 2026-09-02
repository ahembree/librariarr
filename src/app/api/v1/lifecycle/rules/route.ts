import { withApiKey, parseV1Pagination, v1List } from "@/lib/api/v1";
import { prisma } from "@/lib/db";

/**
 * The user's lifecycle rule sets, with how many items each currently matches.
 *
 * The rule *definition* (the nested AND/OR group) is deliberately not exposed:
 * it is an internal structure the rule builder owns, it is by far the largest
 * column on the row, and an external integration wants "what exists and how
 * much does it match", not the predicate tree.
 */
export const GET = withApiKey(async (request, { userId }) => {
  const pagination = parseV1Pagination(new URL(request.url).searchParams);

  const rows = await prisma.ruleSet.findMany({
    where: { userId },
    skip: pagination.skip,
    take: pagination.limit + 1,
    // `id` makes the sort a total order so a page boundary can't permute rows
    // that share a createdAt timestamp.
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      enabled: true,
      type: true,
      actionType: true,
      actionEnabled: true,
      actionDelayDays: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { ruleMatches: true } },
    },
  });

  const hasMore = rows.length > pagination.limit;
  if (hasMore) rows.pop();

  const items = rows.map(({ _count, type, ...rule }) => ({
    ...rule,
    // `RuleSet.type` is the library it targets. Named `libraryType` on the wire
    // so it can't be mistaken for the action type on the same object.
    libraryType: type,
    matchCount: _count.ruleMatches,
  }));

  return v1List(items, pagination, hasMore);
});
