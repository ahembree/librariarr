import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { SeerrClient } from "@/lib/seerr/seerr-client";

/**
 * Aggregate reachability for the user's enabled Arr/Seerr integrations.
 *
 * Used by the rule editor, query page, pending actions, and rule matches
 * pages to surface a warning when a rule references an integration that is
 * configured but currently unreachable. Cached for 30s per user to avoid
 * pinging integrations on every page load.
 */

const HEALTH_TTL_MS = 30_000;

interface InstanceHealth {
  id: string;
  name: string;
  reachable: boolean;
  error: string | null;
}

interface IntegrationTypeHealth {
  configured: number;
  reachable: number;
  instances: InstanceHealth[];
}

export interface IntegrationsHealth {
  sonarr: IntegrationTypeHealth;
  radarr: IntegrationTypeHealth;
  lidarr: IntegrationTypeHealth;
  seerr: IntegrationTypeHealth;
  /** True if at least one of Sonarr/Radarr/Lidarr is reachable. */
  arrAnyReachable: boolean;
}

function emptyType(): IntegrationTypeHealth {
  return { configured: 0, reachable: 0, instances: [] };
}

/** Cap the per-instance reachability check at 5s. The underlying HTTP
 *  client retries with a longer timeout, but for a status indicator we want
 *  an answer fast — better to call a slow-responding server "unreachable"
 *  than to keep the UI waiting for tens of seconds.
 */
const PER_INSTANCE_TIMEOUT_MS = 5_000;

async function checkInstance(
  testFn: () => Promise<{ ok: boolean; error?: string }>,
  id: string,
  name: string,
): Promise<InstanceHealth> {
  try {
    const result = await Promise.race([
      testFn(),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "Timed out after 5s" }), PER_INSTANCE_TIMEOUT_MS),
      ),
    ]);
    return {
      id,
      name,
      reachable: result.ok,
      error: result.ok ? null : (result.error ?? "Unknown error"),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Connection failed";
    return { id, name, reachable: false, error: msg };
  }
}

async function computeHealth(userId: string): Promise<IntegrationsHealth> {
  const [sonarrInstances, radarrInstances, lidarrInstances, seerrInstances] = await Promise.all([
    prisma.sonarrInstance.findMany({ where: { userId, enabled: true }, select: { id: true, name: true, url: true, apiKey: true } }),
    prisma.radarrInstance.findMany({ where: { userId, enabled: true }, select: { id: true, name: true, url: true, apiKey: true } }),
    prisma.lidarrInstance.findMany({ where: { userId, enabled: true }, select: { id: true, name: true, url: true, apiKey: true } }),
    prisma.seerrInstance.findMany({ where: { userId, enabled: true }, select: { id: true, name: true, url: true, apiKey: true } }),
  ]);

  const [sonarrResults, radarrResults, lidarrResults, seerrResults] = await Promise.all([
    Promise.all(sonarrInstances.map((i) => checkInstance(() => new SonarrClient(i.url, i.apiKey).testConnection(), i.id, i.name))),
    Promise.all(radarrInstances.map((i) => checkInstance(() => new RadarrClient(i.url, i.apiKey).testConnection(), i.id, i.name))),
    Promise.all(lidarrInstances.map((i) => checkInstance(() => new LidarrClient(i.url, i.apiKey).testConnection(), i.id, i.name))),
    Promise.all(seerrInstances.map((i) => checkInstance(() => new SeerrClient(i.url, i.apiKey).testConnection(), i.id, i.name))),
  ]);

  const buildType = (results: InstanceHealth[]): IntegrationTypeHealth => ({
    configured: results.length,
    reachable: results.filter((r) => r.reachable).length,
    instances: results,
  });

  const sonarr = buildType(sonarrResults);
  const radarr = buildType(radarrResults);
  const lidarr = buildType(lidarrResults);
  const seerr = buildType(seerrResults);

  return {
    sonarr,
    radarr,
    lidarr,
    seerr,
    arrAnyReachable: sonarr.reachable + radarr.reachable + lidarr.reachable > 0,
  };
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Allow the UI to bypass the cache on demand (e.g. after editing an
  // integration). With no flag, repeat calls within the TTL window are
  // served from cache.
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";

  const cacheKey = `integrations:health:${session.userId}`;
  const empty: IntegrationsHealth = {
    sonarr: emptyType(),
    radarr: emptyType(),
    lidarr: emptyType(),
    seerr: emptyType(),
    arrAnyReachable: false,
  };

  if (fresh) appCache.invalidate(cacheKey);

  let health: IntegrationsHealth;
  try {
    health = await appCache.getOrSet(cacheKey, () => computeHealth(session.userId!), HEALTH_TTL_MS);
  } catch {
    // If everything blew up (DB error, etc.), don't 500 — return an empty
    // shape so the UI can fall back to the existing "not configured" path.
    health = empty;
  }

  return NextResponse.json(health);
}
