import { NextRequest } from "next/server";
import { withSharedSession } from "@/lib/auth/shared-session";
import { apiLogger } from "@/lib/logger";
import { ALL_SERVERS, dashboardStatsUrl } from "@/lib/dashboard/server-selection";
import {
  LIFECYCLE_SUMMARY_URL,
  SCHEDULE_INFO_URL,
  SERVERS_URL,
  SYNC_STATUS_URL,
  libraryTileTypes,
  recentlyAddedUrl,
  sparklinesUrl,
} from "@/lib/dashboard/seed-urls";
import type { DashboardSeed, ServerClock } from "@/lib/dashboard/dashboard-seed-types";
import { monthLabel } from "@/lib/dashboard/sparkline";
import { GET as getStats } from "@/app/api/media/stats/route";
import { GET as getSparklines } from "@/app/api/media/stats/sparklines/route";
import { GET as getRecentlyAdded } from "@/app/api/media/recently-added/route";
import { GET as getLifecycleSummary } from "@/app/api/lifecycle/summary/route";
import { GET as getScheduleInfo } from "@/app/api/settings/schedule-info/route";
import { GET as getSyncStatus } from "@/app/api/sync/status/route";
import { GET as getServers } from "@/app/api/servers/route";

/**
 * How long the server render waits for the slowest read. One still running
 * then is left to the browser, which asks for it as it did before any was
 * read here; the render does not wait on it.
 */
export const DASHBOARD_SEED_BUDGET_MS = 1500;

type Handler = (request: NextRequest) => Promise<Response>;

/**
 * The dashboard's opening reads, answered on the server so the page's HTML
 * carries its figures: a phone paints them as soon as the HTML arrives instead
 * of after its script has run, hydrated the page and asked for each one.
 *
 * Each read is the route's own GET handler — the same validation, scoping and
 * caches as the request the browser would send — under one session check
 * (`withSharedSession`). Only reads of the database: the active sessions, the
 * integration health and the update check ask other servers, which must never
 * hold the page back, so the browser still fetches those.
 *
 * `libraryTypes` are the types the layout read (`loadShellSettings`), which the
 * library tiles render from on the same render.
 */
export async function loadDashboardSeed(libraryTypes: readonly string[]): Promise<DashboardSeed> {
  const at = Date.now();
  const reads: [string, Handler][] = [
    [dashboardStatsUrl(ALL_SERVERS), getStats],
    [sparklinesUrl(libraryTileTypes(libraryTypes)), getSparklines],
    [recentlyAddedUrl(), getRecentlyAdded],
    [LIFECYCLE_SUMMARY_URL, getLifecycleSummary],
    [SCHEDULE_INFO_URL, getScheduleInfo],
    [SYNC_STATUS_URL, getSyncStatus],
    [SERVERS_URL, getServers],
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, DASHBOARD_SEED_BUDGET_MS, undefined);
  });
  try {
    const answers = await withSharedSession(() =>
      Promise.all(
        reads.map(async ([url, handler]) => [url, await Promise.race([read(url, handler), budget])] as const),
      ),
    );
    const bodies: Record<string, unknown> = {};
    for (const [url, body] of answers) {
      if (body !== undefined) bodies[url] = body;
    }
    return { at, bodies };
  } finally {
    clearTimeout(timer);
  }
}

/** The handler's JSON body for `url`, undefined unless it answered 200. */
async function read(url: string, handler: Handler): Promise<unknown> {
  try {
    const response = await handler(new NextRequest(new URL(url, "http://localhost")));
    if (!response.ok) return undefined;
    return await response.json();
  } catch (error) {
    apiLogger.warn("Dashboard", `Server-rendered read of ${url} failed; the browser will fetch it`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** The server render's clock (`ServerClock`), in the server's time zone and locale. */
export function serverClock(now = new Date()): ServerClock {
  return {
    at: now.getTime(),
    hour: now.getHours(),
    weekday: now.toLocaleDateString(undefined, { weekday: "long" }),
    monthDay: now.toLocaleDateString(undefined, { month: "long", day: "numeric" }),
    month: monthLabel(now),
  };
}
