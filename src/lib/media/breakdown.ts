import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { DimensionMeta } from "@/lib/dashboard/custom-dimensions";
import { escapeSqlLiteral } from "./sql-literal";

type BreakdownRow = { value: string | null; type: string; _count: number };

// Defense-in-depth: allowlisted column names for raw SQL queries.
// Values from DIMENSION_REGISTRY are hardcoded, but validating here prevents
// accidental SQL injection if a future registry entry contains special characters.
const ALLOWED_MEDIA_ITEM_COLUMNS = new Set([
  "resolution", "videoCodec", "dynamicRange", "videoProfile", "videoFrameRate",
  "videoBitDepth", "scanType", "aspectRatio", "videoBitrate", "audioCodec",
  "audioChannels", "audioProfile", "audioSamplingRate", "audioBitrate",
  "contentRating", "genres", "year", "studio", "countries", "container",
  "fileSize", "duration", "addedAt", "lastPlayedAt", "originallyAvailableAt",
  "rating", "audienceRating", "playCount",
]);
const ALLOWED_STREAM_COLUMNS = new Set(["language"]);

function assertAllowedColumn(column: string, allowed: Set<string>): void {
  if (!allowed.has(column)) {
    throw new Error(`Disallowed column name in raw SQL: ${column}`);
  }
}

const LIBRARY_TYPES = new Set(["MOVIE", "SERIES", "MUSIC"]);

/**
 * The media types none of `metas` applies to (`excludeTypes`: a music track has
 * no video codec or resolution). Their rows hold NULL in the column and were
 * counted anyway, so a Video Codec card's "Unknown" bucket was the library's
 * track count. Validated against `LibraryType` because the SQL form below is
 * spliced into a statement.
 */
function excludedTypes(...metas: DimensionMeta[]): string[] {
  return [...new Set(metas.flatMap((m) => m.excludeTypes ?? []))].filter((t) => LIBRARY_TYPES.has(t));
}

/** `AND mi.type NOT IN (…)` for the types `metas` exclude, or "" when none. */
export function excludedTypesSql(...metas: DimensionMeta[]): string {
  const types = excludedTypes(...metas);
  return types.length > 0
    ? `AND mi.type NOT IN (${types.map((t) => `'${t}'::"LibraryType"`).join(", ")})`
    : "";
}

/**
 * Compute a single-dimension distribution over the given servers. Shared by
 * `GET /api/media/stats/custom` and the AI analysis `get_breakdown` tool so the
 * six aggregation strategies (direct / value_map / json_unnest / numeric_bucket
 * / stream_group / date_bucket) can't drift.
 */
export function computeBreakdown(
  meta: DimensionMeta,
  serverIds: string[],
  dedupEnabled: boolean,
): Promise<BreakdownRow[]> {
  const excluded = excludedTypes(meta);
  const serverFilter = {
    library: { mediaServerId: { in: serverIds } },
    ...(dedupEnabled ? { dedupCanonical: true } : {}),
    ...(excluded.length > 0 ? { type: { notIn: excluded as ("MOVIE" | "SERIES" | "MUSIC")[] } } : {}),
  };
  // Every raw query below ends its WHERE with this, the SQL form of the same
  // exclusion, after its own dedup clause.
  const typeClause = excludedTypesSql(meta);

  switch (meta.category) {
    case "direct":
      return queryDirect(meta.dbField, serverFilter);
    case "value_map":
      return queryValueMap(meta.dbField, meta.valueMapFn!, serverFilter);
    case "json_unnest":
      return queryJsonUnnest(meta.dbField, serverIds, dedupEnabled, typeClause);
    case "numeric_bucket":
      return queryNumericBucket(meta.dbField, meta.nullLabel, meta.bucketConfig!.ranges, serverIds, dedupEnabled, typeClause);
    case "stream_group":
      return queryStreamGroup(meta.streamType!, meta.streamField!, meta.nullLabel, serverIds, dedupEnabled, typeClause);
    case "date_bucket":
      return queryDateBucket(meta.dbField, meta.nullLabel, meta.dateBucketGranularity!, serverIds, dedupEnabled, typeClause);
  }
}

async function queryDirect(
  dbField: string,
  serverFilter: Record<string, unknown>
): Promise<BreakdownRow[]> {
  const grouped = await prisma.mediaItem.groupBy({
    by: [dbField as "resolution", "type"],
    where: serverFilter,
    _count: true,
  });

  return grouped.map((row) => ({
    value: row[dbField as keyof typeof row] != null ? String(row[dbField as keyof typeof row]) : null,
    type: row.type,
    _count: row._count,
  }));
}

async function queryValueMap(
  dbField: string,
  mapFn: (raw: string | null) => string,
  serverFilter: Record<string, unknown>
): Promise<BreakdownRow[]> {
  const raw = await queryDirect(dbField, serverFilter);

  // Apply mapping and re-aggregate
  const agg = new Map<string, Map<string, number>>();
  for (const row of raw) {
    const mapped = mapFn(row.value);
    const typeMap = agg.get(mapped) ?? new Map<string, number>();
    typeMap.set(row.type, (typeMap.get(row.type) ?? 0) + row._count);
    agg.set(mapped, typeMap);
  }

  const result: BreakdownRow[] = [];
  for (const [value, typeMap] of agg) {
    for (const [type, count] of typeMap) {
      result.push({ value, type, _count: count });
    }
  }
  return result;
}

async function queryJsonUnnest(
  dbField: string,
  serverIds: string[],
  dedupEnabled: boolean,
  typeClause: string,
): Promise<BreakdownRow[]> {
  assertAllowedColumn(dbField, ALLOWED_MEDIA_ITEM_COLUMNS);
  return prisma.$queryRaw<BreakdownRow[]>`
    SELECT g.val AS "value", mi.type::text AS "type",
      COUNT(DISTINCT COALESCE(CASE WHEN mi.type = 'SERIES' THEN mi."seriesKey" END, mi."parentTitle", mi.id))::int AS "_count"
    FROM "MediaItem" mi
    JOIN "Library" l ON mi."libraryId" = l.id
    CROSS JOIN LATERAL jsonb_array_elements_text(mi.${Prisma.raw(`"${dbField}"`)}) AS g(val)
    WHERE l."mediaServerId" IN (${Prisma.join(serverIds)})
      AND mi.${Prisma.raw(`"${dbField}"`)} IS NOT NULL
      AND jsonb_typeof(mi.${Prisma.raw(`"${dbField}"`)}) = 'array'
      ${dedupEnabled ? Prisma.sql`AND mi."dedupCanonical" = true` : Prisma.empty}
      ${Prisma.raw(typeClause)}
    GROUP BY g.val, mi.type
    ORDER BY "_count" DESC
  `;
}

async function queryNumericBucket(
  dbField: string,
  nullLabel: string,
  ranges: [number | null, number | null, string][],
  serverIds: string[],
  dedupEnabled: boolean,
  typeClause: string,
): Promise<BreakdownRow[]> {
  assertAllowedColumn(dbField, ALLOWED_MEDIA_ITEM_COLUMNS);
  const col = `mi."${dbField}"`;
  const safeNullLabel = escapeSqlLiteral(nullLabel);
  const caseBranches: string[] = [];

  caseBranches.push(`WHEN ${col} IS NULL THEN '${safeNullLabel}'`);

  for (const [min, max, label] of ranges) {
    const safeLabel = escapeSqlLiteral(label);
    if (min === null && max !== null) {
      caseBranches.push(`WHEN ${col} < ${max} THEN '${safeLabel}'`);
    } else if (min !== null && max !== null) {
      caseBranches.push(`WHEN ${col} >= ${min} AND ${col} < ${max} THEN '${safeLabel}'`);
    } else if (min !== null && max === null) {
      caseBranches.push(`WHEN ${col} >= ${min} THEN '${safeLabel}'`);
    }
  }

  const caseExpr = `CASE ${caseBranches.join(" ")} END`;
  const dedupClause = dedupEnabled ? `AND mi."dedupCanonical" = true` : "";

  return prisma.$queryRawUnsafe<BreakdownRow[]>(
    `SELECT ${caseExpr} AS "value", mi.type::text AS "type",
       COUNT(*)::int AS "_count"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       ${dedupClause}
       ${typeClause}
     GROUP BY "value", mi.type
     ORDER BY "_count" DESC`,
    serverIds
  );
}

async function queryStreamGroup(
  streamType: number,
  streamField: string,
  nullLabel: string,
  serverIds: string[],
  dedupEnabled: boolean,
  typeClause: string,
): Promise<BreakdownRow[]> {
  assertAllowedColumn(streamField, ALLOWED_STREAM_COLUMNS);
  const safeNullLabel = escapeSqlLiteral(nullLabel);
  const dedupClause = dedupEnabled ? `AND mi."dedupCanonical" = true` : "";
  return prisma.$queryRawUnsafe<BreakdownRow[]>(
    `SELECT COALESCE(ms."${streamField}", '${safeNullLabel}') AS "value",
       mi.type::text AS "type",
       COUNT(DISTINCT mi.id)::int AS "_count"
     FROM "MediaStream" ms
     JOIN "MediaItem" mi ON ms."mediaItemId" = mi.id
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       AND ms."streamType" = $2
       ${dedupClause}
       ${typeClause}
     GROUP BY ms."${streamField}", mi.type
     ORDER BY "_count" DESC`,
    serverIds,
    streamType
  );
}

async function queryDateBucket(
  dbField: string,
  nullLabel: string,
  granularity: "month" | "year",
  serverIds: string[],
  dedupEnabled: boolean,
  typeClause: string,
): Promise<BreakdownRow[]> {
  assertAllowedColumn(dbField, ALLOWED_MEDIA_ITEM_COLUMNS);
  const safeNullLabel = escapeSqlLiteral(nullLabel);
  const format = granularity === "month" ? "YYYY-MM" : "YYYY";
  const dedupClause = dedupEnabled ? `AND mi."dedupCanonical" = true` : "";
  // Newest bucket first, the null label ("Never Played", "Unknown") LAST:
  // ordered by the label alone it sorted first, letters after digits. The
  // cards and the AI re-sort by count with a stable sort, so this is the order
  // of equal counts. The group whose dates are all NULL is the null label's —
  // ORDER BY cannot use the "value" alias inside an expression.
  return prisma.$queryRawUnsafe<BreakdownRow[]>(
    `SELECT
       CASE
         WHEN mi."${dbField}" IS NULL THEN '${safeNullLabel}'
         ELSE TO_CHAR(mi."${dbField}", '${format}')
       END AS "value",
       mi.type::text AS "type",
       COUNT(*)::int AS "_count"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       ${dedupClause}
       ${typeClause}
     GROUP BY "value", mi.type
     ORDER BY MAX(mi."${dbField}") IS NULL, "value" DESC, "type"`,
    serverIds
  );
}
