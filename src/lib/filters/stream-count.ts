import type { Prisma, PrismaClient } from "@/generated/prisma/client";

interface CountCondition {
  op: string;
  value: number;
}

function parseCountConditions(raw: string | null): CountCondition[] {
  if (!raw) return [];
  return raw
    .split("|")
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      if (idx === -1) {
        const num = parseInt(part);
        return !isNaN(num) ? { op: "eq", value: num } : null;
      }
      const op = part.slice(0, idx);
      const num = parseInt(part.slice(idx + 1));
      return !isNaN(num) ? { op, value: num } : null;
    })
    .filter((c): c is CountCondition => c !== null);
}

function opToSql(op: string): string {
  switch (op) {
    case "gt": return ">";
    case "lt": return "<";
    case "gte": return ">=";
    case "lte": return "<=";
    case "eq":
    default: return "=";
  }
}

/**
 * Apply stream count filters (audio track count, subtitle count) to the where clause.
 * Uses a raw SQL subquery to find matching media item IDs, then adds id IN (...) to the where.
 */
export async function applyStreamCountFilters(
  where: Prisma.MediaItemWhereInput,
  params: URLSearchParams,
  db: PrismaClient,
): Promise<void> {
  const audioConditions = parseCountConditions(params.get("audioStreamCountConditions"));
  const subtitleConditions = parseCountConditions(params.get("subtitleStreamCountConditions"));

  if (audioConditions.length === 0 && subtitleConditions.length === 0) return;

  const havingClauses: string[] = [];
  const queryValues: number[] = [];
  let idx = 1;

  for (const c of audioConditions) {
    havingClauses.push(
      `COUNT(*) FILTER (WHERE "streamType" = 2) ${opToSql(c.op)} $${idx}`
    );
    queryValues.push(c.value);
    idx++;
  }

  for (const c of subtitleConditions) {
    havingClauses.push(
      `COUNT(*) FILTER (WHERE "streamType" = 3) ${opToSql(c.op)} $${idx}`
    );
    queryValues.push(c.value);
    idx++;
  }

  const rows = await db.$queryRawUnsafe<{ mediaItemId: string }[]>(
    `SELECT "mediaItemId" FROM "MediaStream"
     GROUP BY "mediaItemId"
     HAVING ${havingClauses.join(" AND ")}`,
    ...queryValues,
  );

  const ids = rows.map((r) => r.mediaItemId);

  // Add id filter to where clause
  const andClauses: Prisma.MediaItemWhereInput[] = Array.isArray(where.AND)
    ? [...where.AND]
    : where.AND
      ? [where.AND as Prisma.MediaItemWhereInput]
      : [];
  andClauses.push({ id: { in: ids } });
  where.AND = andClauses;
}
