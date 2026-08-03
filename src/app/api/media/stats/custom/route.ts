import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDimensionMeta } from "@/lib/dashboard/custom-dimensions";
import { appCache } from "@/lib/cache/memory-cache";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import { computeBreakdown } from "@/lib/media/breakdown";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const dimensionId = searchParams.get("dimension");
  const serverId = searchParams.get("serverId");

  if (!dimensionId) {
    return NextResponse.json({ error: "Missing dimension parameter" }, { status: 400 });
  }

  const meta = getDimensionMeta(dimensionId);
  if (!meta) {
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }

  const scope = await resolveStatsScope(session.userId!, serverId);
  if (scope === "server-not-found") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (scope.serverIds.length === 0) {
    return NextResponse.json({ breakdown: [] });
  }

  const cacheKey = `custom-stats:${dimensionId}:${[...scope.serverIds].sort().join(",")}:${scope.dedupEnabled ? "dedup" : "raw"}`;
  const breakdown = await appCache.getOrSet(
    cacheKey,
    () => computeBreakdown(meta, scope.serverIds, scope.dedupEnabled),
    60_000,
  );

  return NextResponse.json({ breakdown });
}
