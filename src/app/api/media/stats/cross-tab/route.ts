import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { getDimensionMeta, type DimensionMeta } from "@/lib/dashboard/custom-dimensions";
import { appCache } from "@/lib/cache/memory-cache";

type CrossTabRow = { dim1: string | null; dim2: string | null; type: string; _count: number };

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const dim1Id = searchParams.get("dimension1");
  const dim2Id = searchParams.get("dimension2");
  const serverId = searchParams.get("serverId");

  if (!dim1Id || !dim2Id) {
    return NextResponse.json({ error: "Missing dimension1 or dimension2" }, { status: 400 });
  }
  if (dim1Id === dim2Id) {
    return NextResponse.json({ error: "Dimensions must differ" }, { status: 400 });
  }

  const meta1 = getDimensionMeta(dim1Id);
  const meta2 = getDimensionMeta(dim2Id);
  if (!meta1 || !meta2) {
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }

  if (meta1.category === "stream_group" && meta2.category === "stream_group") {
    return NextResponse.json({ error: "Cannot cross two stream dimensions" }, { status: 400 });
  }

  const [servers, settings] = await Promise.all([
    prisma.mediaServer.findMany({
      where: { userId: session.userId, enabled: true },
      select: { id: true },
    }),
    prisma.appSettings.findUnique({
      where: { userId: session.userId! },
      select: { dedupStats: true },
    }),
  ]);
  let serverIds = servers.map((s) => s.id);
  const dedupEnabled = (settings?.dedupStats ?? true) && serverIds.length > 1 && !serverId;

  if (serverId) {
    if (!serverIds.includes(serverId)) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    serverIds = [serverId];
  }

  if (serverIds.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const cacheKey = `cross-tab:${dim1Id}:${dim2Id}:${serverIds.sort().join(",")}:${dedupEnabled ? "dedup" : "raw"}`;
  const expensive = ["json_unnest", "stream_group"];
  const ttl = (expensive.includes(meta1.category) || expensive.includes(meta2.category))
    ? 120_000 : 60_000;

  const rows = await appCache.getOrSet(cacheKey, () => queryCrossTab(meta1, meta2, serverIds, dedupEnabled), ttl);
  return NextResponse.json({ rows });
}

// ── Query dispatcher ────────────────────────────────────────────

async function queryCrossTab(
  meta1: DimensionMeta,
  meta2: DimensionMeta,
  serverIds: string[],
  dedupEnabled: boolean
): Promise<CrossTabRow[]> {
  // Fast path: both dimensions are simple direct fields on MediaItem
  if (meta1.category === "direct" && meta2.category === "direct") {
    return queryDirectDirect(meta1.dbField, meta2.dbField, serverIds, dedupEnabled);
  }

  // General path: fetch raw items, resolve labels in JS, cross-tabulate
  return queryGeneral(meta1, meta2, serverIds, dedupEnabled);
}

// ── Direct × Direct (pure SQL) ─────────────────────────────────

async function queryDirectDirect(
  field1: string,
  field2: string,
  serverIds: string[],
  dedupEnabled: boolean
): Promise<CrossTabRow[]> {
  const dedupClause = dedupEnabled ? `AND mi."dedupCanonical" = true` : "";
  return prisma.$queryRawUnsafe<CrossTabRow[]>(
    `SELECT mi."${field1}"::text AS "dim1", mi."${field2}"::text AS "dim2",
       mi.type::text AS "type", COUNT(*)::int AS "_count"
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       ${dedupClause}
     GROUP BY mi."${field1}", mi."${field2}", mi.type
     ORDER BY "_count" DESC
     LIMIT 2000`,
    serverIds
  );
}

// ── General cross-tabulation (in-memory) ────────────────────────

interface RawItem {
  type: string;
  [key: string]: unknown;
}

async function queryGeneral(
  meta1: DimensionMeta,
  meta2: DimensionMeta,
  serverIds: string[],
  dedupEnabled: boolean
): Promise<CrossTabRow[]> {
  const items = await fetchItems(meta1, meta2, serverIds, dedupEnabled);

  // Cross-tabulate: for each item, resolve labels for both dimensions and count
  const countMap = new Map<string, number>();

  for (const item of items) {
    const labels1 = resolveValues(meta1, item);
    const labels2 = resolveValues(meta2, item);

    for (const l1 of labels1) {
      for (const l2 of labels2) {
        const key = `${l1}\0${l2}\0${item.type}`;
        countMap.set(key, (countMap.get(key) ?? 0) + 1);
      }
    }
  }

  const rows: CrossTabRow[] = [];
  for (const [key, count] of countMap) {
    const [dim1, dim2, type] = key.split("\0");
    rows.push({ dim1, dim2, type, _count: count });
  }

  rows.sort((a, b) => b._count - a._count);
  return rows.slice(0, 2000);
}

// ── Fetch raw items with both dimension fields ──────────────────

async function fetchItems(
  meta1: DimensionMeta,
  meta2: DimensionMeta,
  serverIds: string[],
  dedupEnabled: boolean
): Promise<RawItem[]> {
  // If either dimension is stream_group, we need a JOIN to MediaStream
  const streamMeta = meta1.category === "stream_group" ? meta1
    : meta2.category === "stream_group" ? meta2
    : null;

  if (streamMeta) {
    const otherMeta = streamMeta === meta1 ? meta2 : meta1;
    return fetchWithStreamJoin(streamMeta, otherMeta, streamMeta === meta1, serverIds, dedupEnabled);
  }

  // All other combos: select from MediaItem with both fields
  const fields = new Set(["type"]);
  addRequiredFields(meta1, fields);
  addRequiredFields(meta2, fields);

  const selectCols = [...fields].map((f) => `mi."${f}"`).join(", ");
  const dedupClause = dedupEnabled ? `AND mi."dedupCanonical" = true` : "";

  return prisma.$queryRawUnsafe<RawItem[]>(
    `SELECT ${selectCols}
     FROM "MediaItem" mi
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       ${dedupClause}`,
    serverIds
  );
}

function addRequiredFields(meta: DimensionMeta, fields: Set<string>) {
  fields.add(meta.dbField);
  // json_unnest fields need the raw JSON column
  // numeric_bucket, direct, value_map, date_bucket all just need dbField
}

async function fetchWithStreamJoin(
  streamMeta: DimensionMeta,
  otherMeta: DimensionMeta,
  isStreamDim1: boolean,
  serverIds: string[],
  dedupEnabled: boolean
): Promise<RawItem[]> {
  const otherFields = new Set<string>();
  addRequiredFields(otherMeta, otherFields);

  const otherCols = [...otherFields].map((f) => `mi."${f}"`).join(", ");
  const streamCol = `ms."${streamMeta.streamField!}"`;
  const streamAlias = isStreamDim1 ? "dim1_stream" : "dim2_stream";
  const dedupClause = dedupEnabled ? `AND mi."dedupCanonical" = true` : "";

  return prisma.$queryRawUnsafe<RawItem[]>(
    `SELECT mi.type::text AS "type", ${otherCols},
       ${streamCol} AS "${streamAlias}"
     FROM "MediaStream" ms
     JOIN "MediaItem" mi ON ms."mediaItemId" = mi.id
     JOIN "Library" l ON mi."libraryId" = l.id
     WHERE l."mediaServerId" = ANY($1)
       AND ms."streamType" = $2
       ${dedupClause}`,
    serverIds,
    streamMeta.streamType!
  );
}

// ── Resolve display labels for a dimension ──────────────────────

function resolveValues(meta: DimensionMeta, item: RawItem): string[] {
  // For stream_group dimensions, the value was already fetched with a special alias
  if (meta.category === "stream_group") {
    const streamVal = item.dim1_stream ?? item.dim2_stream;
    const label = streamVal != null ? String(streamVal) : meta.nullLabel;
    return [label];
  }

  const raw = item[meta.dbField];

  switch (meta.category) {
    case "direct": {
      return [raw != null ? String(raw) : meta.nullLabel];
    }

    case "value_map": {
      const strVal = raw != null ? String(raw) : null;
      return [meta.valueMapFn!(strVal)];
    }

    case "json_unnest": {
      if (raw == null || !Array.isArray(raw)) return [];
      return (raw as string[]).map((v) => String(v));
    }

    case "numeric_bucket": {
      if (raw == null) return [meta.nullLabel];
      const num = Number(raw);
      if (isNaN(num)) return [meta.nullLabel];
      for (const [min, max, label] of meta.bucketConfig!.ranges) {
        if (min === null && max !== null && num < max) return [label];
        if (min !== null && max !== null && num >= min && num < max) return [label];
        if (min !== null && max === null && num >= min) return [label];
      }
      return [meta.nullLabel];
    }

    case "date_bucket": {
      if (raw == null) return [meta.nullLabel];
      const date = raw instanceof Date ? raw : new Date(String(raw));
      if (isNaN(date.getTime())) return [meta.nullLabel];
      if (meta.dateBucketGranularity === "year") {
        return [String(date.getFullYear())];
      }
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      return [`${y}-${m}`];
    }

    default:
      return [meta.nullLabel];
  }
}
