import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { sanitize } from "@/lib/api/sanitize";
import { INTEGRATIONS, SEERR, listInstances, readInstanceMetadata } from "@/lib/integrations/instance-routes";
import { loadSeerrMetadata } from "@/lib/integrations/instance-metadata";

/**
 * Every integration type's instances in one request:
 * `{ sonarr, radarr, lidarr, seerr, tracearr }`, each list exactly what
 * `GET /api/integrations/<type>` answers (`instances`, sanitized, newest
 * first). The Query page and the rule editor fetched the lists one route each.
 *
 * `?withMetadata=1` adds `seerrUsers`: every requester name across the ENABLED
 * Seerr instances — the "Requested By" values, which those pages then fetched
 * from each instance's metadata route one after another. Read through the
 * same per-instance cache that route uses; an instance that cannot be read
 * adds no names, as the pages treated a failed fetch.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.userId!;

  const entries = await Promise.all(
    Object.entries(INTEGRATIONS).map(async ([type, config]) => [type, await listInstances(config, userId)] as const),
  );
  const byType = Object.fromEntries(entries);
  const body: Record<string, unknown> = Object.fromEntries(entries.map(([type, rows]) => [type, sanitize(rows)]));

  if (request.nextUrl.searchParams.get("withMetadata") === "1") {
    const enabled = (byType.seerr ?? []).filter((instance) => instance.enabled);
    const answers = await Promise.all(enabled.map((instance) => readInstanceMetadata(SEERR, instance, loadSeerrMetadata)));
    const users = answers.flatMap((answer) => (answer.ok ? (answer.body.users as string[]) : []));
    body.seerrUsers = [...new Set(users)].sort((a, b) => a.localeCompare(b));
  }

  return NextResponse.json(body);
}
