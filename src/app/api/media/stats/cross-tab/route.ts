import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDimensionMeta } from "@/lib/dashboard/custom-dimensions";
import { appCache } from "@/lib/cache/memory-cache";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import { computeCrossTab } from "@/lib/media/cross-tab";

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

  const scope = await resolveStatsScope(session.userId!, serverId);
  if (scope === "server-not-found") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (scope.serverIds.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const cacheKey = `cross-tab:${dim1Id}:${dim2Id}:${[...scope.serverIds].sort().join(",")}:${scope.dedupEnabled ? "dedup" : "raw"}`;
  const expensive = ["json_unnest", "stream_group"];
  const ttl = (expensive.includes(meta1.category) || expensive.includes(meta2.category))
    ? 120_000 : 60_000;

  const rows = await appCache.getOrSet(
    cacheKey,
    () => computeCrossTab(meta1, meta2, scope.serverIds, scope.dedupEnabled),
    ttl,
  );
  return NextResponse.json({ rows });
}
