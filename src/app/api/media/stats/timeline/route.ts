import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDimensionMeta, supportsTimelineBreakdown } from "@/lib/dashboard/custom-dimensions";
import { appCache } from "@/lib/cache/memory-cache";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import {
  computeTimeline,
  ALLOWED_DATE_COLUMNS,
  VALID_BINS,
  VALID_MEASURES,
  VALID_TYPES,
} from "@/lib/media/timeline";

// Re-exported for consumers that imported the type from the route (e.g. charts).
export type { TimelinePoint } from "@/lib/media/timeline";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const dateField = searchParams.get("dateField");
  const bin = searchParams.get("bin") ?? "month";
  const measure = searchParams.get("measure") ?? "count";
  const breakdownDim = searchParams.get("breakdown");
  const serverId = searchParams.get("serverId");
  const typeFilter = searchParams.get("type");
  const topNParam = searchParams.get("topN");
  const topN = topNParam ? parseInt(topNParam, 10) : null;

  if (!dateField || !ALLOWED_DATE_COLUMNS.has(dateField)) {
    return NextResponse.json({ error: "Invalid or missing dateField" }, { status: 400 });
  }
  if (!VALID_BINS.has(bin)) {
    return NextResponse.json({ error: "Invalid bin" }, { status: 400 });
  }
  if (!VALID_MEASURES.has(measure)) {
    return NextResponse.json({ error: "Invalid measure" }, { status: 400 });
  }
  if (typeFilter && !VALID_TYPES.has(typeFilter)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  const breakdownMeta = breakdownDim ? getDimensionMeta(breakdownDim) : null;
  if (breakdownDim && !breakdownMeta) {
    return NextResponse.json({ error: "Invalid breakdown dimension" }, { status: 400 });
  }
  if (breakdownMeta && !supportsTimelineBreakdown(breakdownMeta)) {
    // Refused rather than silently charting an uncoloured total under a
    // "by Genre" card title.
    return NextResponse.json(
      { error: `Cannot break a timeline down by ${breakdownMeta.label}` },
      { status: 400 },
    );
  }

  const scope = await resolveStatsScope(session.userId!, serverId);
  if (scope === "server-not-found") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (scope.serverIds.length === 0) {
    return NextResponse.json({ points: [], series: [] });
  }

  const cacheKey = `timeline:${dateField}:${bin}:${measure}:${breakdownDim ?? ""}:${typeFilter ?? ""}:${topN ?? ""}:${[...scope.serverIds].sort().join(",")}:${scope.dedupEnabled ? "dedup" : "raw"}`;

  const result = await appCache.getOrSet(cacheKey, async () => {
    return computeTimeline({
      dateField,
      bin,
      measure,
      breakdownMeta: breakdownMeta ?? null,
      serverIds: scope.serverIds,
      typeFilter,
      topN,
      dedupEnabled: scope.dedupEnabled,
    });
  }, 60_000);

  return NextResponse.json(result);
}
