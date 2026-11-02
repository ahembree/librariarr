import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { appCache } from "@/lib/cache/memory-cache";
import { INTEGRATIONS_HEALTH_CACHE_KEY } from "@/lib/cache/invalidate";
import { LIDARR, RADARR, SEERR, SONARR, listInstances } from "@/lib/integrations/instance-routes";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

/**
 * Aggregate reachability for the user's enabled Arr/Seerr integrations.
 *
 * Used by the rule editor, query page, pending actions, and rule matches
 * pages to surface a warning when a rule references an integration that is
 * configured but currently unreachable. Cached for 30s to avoid pinging
 * integrations on every page load.
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
    // Error text from a failed connection can name the instance's private
    // address or an internal path; the rest of the API scrubs it the same way.
    return {
      id,
      name,
      reachable: result.ok,
      error: result.ok ? null : (sanitizeErrorDetail(result.error) ?? "Unknown error"),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Connection failed";
    return { id, name, reachable: false, error: sanitizeErrorDetail(msg) ?? "Connection failed" };
  }
}

/** The types whose reachability the rule editor and the Query page warn about. */
const CHECKED = [SONARR, RADARR, LIDARR, SEERR] as const;

async function computeHealth(userId: string): Promise<IntegrationsHealth> {
  const [sonarr, radarr, lidarr, seerr] = await Promise.all(
    CHECKED.map(async (config): Promise<IntegrationTypeHealth> => {
      const instances = await listInstances(config, userId, { enabledOnly: true });
      const results = await Promise.all(
        instances.map((i) => checkInstance(() => config.client(i.url, i.apiKey).testConnection(), i.id, i.name)),
      );
      return {
        configured: results.length,
        reachable: results.filter((r) => r.reachable).length,
        instances: results,
      };
    }),
  );

  return {
    sonarr,
    radarr,
    lidarr,
    seerr,
    arrAnyReachable: sonarr.reachable + radarr.reachable + lidarr.reachable > 0,
  };
}

export const GET = withSession(async (session, request: Request) => {
  // Allow the UI to bypass the cache on demand (e.g. after editing an
  // integration). With no flag, repeat calls within the TTL window are
  // served from cache.
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";

  const empty: IntegrationsHealth = {
    sonarr: emptyType(),
    radarr: emptyType(),
    lidarr: emptyType(),
    seerr: emptyType(),
    arrAnyReachable: false,
  };

  if (fresh) appCache.invalidate(INTEGRATIONS_HEALTH_CACHE_KEY);

  let health: IntegrationsHealth;
  try {
    health = await appCache.getOrSet(INTEGRATIONS_HEALTH_CACHE_KEY, () => computeHealth(session.userId), HEALTH_TTL_MS);
  } catch {
    // If everything blew up (DB error, etc.), don't 500 — return an empty
    // shape so the UI can fall back to the existing "not configured" path.
    health = empty;
  }

  return NextResponse.json(health);
});
