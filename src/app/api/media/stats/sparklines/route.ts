import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { resolveStatsScope } from "@/lib/media/stats-scope";
import { getTimelineCached, VALID_TYPES, type TimelinePoint } from "@/lib/media/timeline";

/**
 * The dashboard library tiles' sparklines in one request: items added per
 * month for each requested type (`types=MOVIE,SERIES,MUSIC`), plus library
 * size added per month under `ALL` for the totals tile. Each series is the
 * same cached timeline `GET /api/media/stats/timeline` answers for that tile;
 * the tiles asked for them one request each, four of the dozen-plus requests
 * the dashboard makes on load.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const types = [...new Set((searchParams.get("types") ?? "").split(",").filter(Boolean))];
  if (types.some((type) => !VALID_TYPES.has(type))) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  const scope = await resolveStatsScope(session.userId!, searchParams.get("serverId"));
  if (scope === "server-not-found") {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const series: Record<string, TimelinePoint[]> = {};
  if (scope.serverIds.length === 0) {
    for (const key of [...types, "ALL"]) series[key] = [];
    return NextResponse.json({ series });
  }

  const base = {
    dateField: "addedAt",
    bin: "month",
    breakdownMeta: null,
    serverIds: scope.serverIds,
    topN: null,
    dedupEnabled: scope.dedupEnabled,
  };
  const entries = await Promise.all([
    ...types.map(async (type) => {
      const { points } = await getTimelineCached({ ...base, measure: "count", typeFilter: type });
      return [type, points] as const;
    }),
    getTimelineCached({ ...base, measure: "size", typeFilter: null }).then(({ points }) => ["ALL", points] as const),
  ]);
  for (const [key, points] of entries) series[key] = points;

  return NextResponse.json({ series });
}
